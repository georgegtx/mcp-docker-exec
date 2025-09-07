import { Readable } from 'stream';
import { Logger } from '../observability/Logger.js';

interface DemuxedChunk {
  channel: 'stdout' | 'stderr';
  data: string;
  timestamp: string;
}

export class StreamDemuxer {
  private static readonly MAX_FRAME_SIZE = 10 * 1024 * 1024; // 10MB max frame
  private static readonly MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB max buffer
  private static readonly HEADER_SIZE = 8;

  private logger: Logger;

  constructor() {
    this.logger = new Logger('StreamDemuxer');
  }

  /**
   * Validate Docker multiplex header structure
   */
  private isValidHeader(header: Buffer): boolean {
    if (header.length < StreamDemuxer.HEADER_SIZE) return false;

    const streamType = header[0];
    const zeros = header.slice(1, 4);
    const size = header.readUInt32BE(4);

    // Valid stream types are 1 (stdout) or 2 (stderr)
    // Bytes 1-3 must be zero
    // Size must be reasonable
    return (
      (streamType === 1 || streamType === 2) &&
      zeros.every((b) => b === 0) &&
      size > 0 &&
      size <= StreamDemuxer.MAX_FRAME_SIZE
    );
  }

  /**
   * Detect if stream is multiplexed by examining multiple headers
   */
  private detectMultiplexed(buffer: Buffer): boolean {
    // Need at least one full frame to detect
    if (buffer.length < StreamDemuxer.HEADER_SIZE) return true; // Assume multiplexed until proven otherwise

    // Check first header
    const firstHeader = buffer.slice(0, StreamDemuxer.HEADER_SIZE);
    if (!this.isValidHeader(firstHeader)) {
      return false;
    }

    // If we have enough data, validate a second frame
    const firstSize = firstHeader.readUInt32BE(4);
    const secondFrameStart = StreamDemuxer.HEADER_SIZE + firstSize;

    if (buffer.length >= secondFrameStart + StreamDemuxer.HEADER_SIZE) {
      const secondHeader = buffer.slice(
        secondFrameStart,
        secondFrameStart + StreamDemuxer.HEADER_SIZE
      );
      return this.isValidHeader(secondHeader);
    }

    // Single valid header found
    return true;
  }

  /**
   * Demultiplex Docker stream format with robust error handling
   */
  async *demuxStream(stream: Readable, chunkSize: number): AsyncGenerator<DemuxedChunk> {
    let buffer = Buffer.alloc(0);
    let isMultiplexed: boolean | null = null;
    let corruptionDetected = false;

    try {
      for await (const chunk of stream) {
        // Prevent buffer from growing too large
        if (buffer.length > StreamDemuxer.MAX_BUFFER_SIZE) {
          this.logger.error('Buffer overflow detected', {
            bufferSize: buffer.length,
            maxSize: StreamDemuxer.MAX_BUFFER_SIZE,
          });
          throw new Error('Stream buffer overflow - possible corruption or attack');
        }

        buffer = Buffer.concat([buffer, chunk]);

        // Detect multiplexing on first pass
        if (isMultiplexed === null && buffer.length >= StreamDemuxer.HEADER_SIZE) {
          isMultiplexed = this.detectMultiplexed(buffer);
          this.logger.debug('Stream multiplexing detected', { isMultiplexed });
        }

        if (isMultiplexed === false) {
          // Plain text stream - yield in chunks
          while (buffer.length > 0) {
            const size = Math.min(buffer.length, chunkSize);
            const data = buffer.slice(0, size).toString('utf8');
            buffer = buffer.slice(size);

            yield {
              channel: 'stdout' as const,
              data,
              timestamp: new Date().toISOString(),
            };
          }
        } else if (isMultiplexed === true) {
          // Multiplexed stream - parse frames
          let processed = true;
          while (processed && buffer.length >= StreamDemuxer.HEADER_SIZE) {
            processed = false;

            const header = buffer.slice(0, StreamDemuxer.HEADER_SIZE);

            // Validate header
            if (!this.isValidHeader(header)) {
              if (!corruptionDetected) {
                this.logger.warn('Corrupted frame detected, attempting recovery', {
                  header: header.toString('hex'),
                  bufferLength: buffer.length,
                });
                corruptionDetected = true;
              }

              // Try to find next valid header
              let recovered = false;
              for (let i = 1; i < buffer.length - StreamDemuxer.HEADER_SIZE; i++) {
                const candidateHeader = buffer.slice(i, i + StreamDemuxer.HEADER_SIZE);
                if (this.isValidHeader(candidateHeader)) {
                  // Found valid header, skip corrupted data
                  buffer = buffer.slice(i);
                  recovered = true;
                  this.logger.info('Recovered from corruption', { skippedBytes: i });
                  break;
                }
              }

              if (!recovered) {
                // No valid header found, treat remaining as plain text
                const data = buffer.toString('utf8');
                buffer = Buffer.alloc(0);
                yield {
                  channel: 'stdout' as const,
                  data,
                  timestamp: new Date().toISOString(),
                };
                break;
              }
              continue;
            }

            const streamType = header[0];
            const payloadSize = header.readUInt32BE(4);

            // Wait for complete frame
            if (buffer.length < StreamDemuxer.HEADER_SIZE + payloadSize) {
              break;
            }

            // Extract frame
            const payload = buffer.slice(
              StreamDemuxer.HEADER_SIZE,
              StreamDemuxer.HEADER_SIZE + payloadSize
            );
            buffer = buffer.slice(StreamDemuxer.HEADER_SIZE + payloadSize);
            processed = true;

            const channel: 'stdout' | 'stderr' = streamType === 1 ? 'stdout' : 'stderr';

            // Yield payload in chunks
            let offset = 0;
            while (offset < payload.length) {
              const chunkData = payload
                .slice(offset, Math.min(offset + chunkSize, payload.length))
                .toString('utf8');
              offset += chunkData.length;

              yield {
                channel,
                data: chunkData,
                timestamp: new Date().toISOString(),
              };
            }
          }
        }
      }

      // Yield any remaining data
      if (buffer.length > 0) {
        this.logger.debug('Yielding remaining buffer', { size: buffer.length });
        yield {
          channel: 'stdout' as const,
          data: buffer.toString('utf8'),
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.logger.error('Stream processing error', { error });
      throw error;
    }
  }

  /**
   * Demux logs which may have timestamps prepended
   */
  async *demuxLogs(stream: Readable, chunkSize: number): AsyncGenerator<DemuxedChunk> {
    let buffer = '';

    for await (const chunk of stream) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');

      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          // Parse timestamp if present (Docker logs --timestamps format)
          const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/);

          if (timestampMatch) {
            yield {
              channel: 'stdout',
              data: timestampMatch[2] + '\n',
              timestamp: timestampMatch[1],
            };
          } else {
            yield {
              channel: 'stdout',
              data: line + '\n',
              timestamp: new Date().toISOString(),
            };
          }
        }
      }
    }

    // Yield any remaining data
    if (buffer.trim()) {
      yield {
        channel: 'stdout',
        data: buffer + (buffer.endsWith('\n') ? '' : '\n'),
        timestamp: new Date().toISOString(),
      };
    }
  }
}
