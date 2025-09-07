import { Readable } from 'stream';

interface DemuxedChunk {
  channel: 'stdout' | 'stderr';
  data: string;
  timestamp: string;
}

export class StreamDemuxer {
  /**
   * Demultiplex Docker stream format
   * Docker multiplexes stdout and stderr into a single stream with headers
   * Header format: [8 bytes] = [stream type (1 byte), 0, 0, 0, size (4 bytes)]
   */
  async* demuxStream(stream: Readable, chunkSize: number): AsyncGenerator<DemuxedChunk> {
    let buffer = Buffer.alloc(0);
    let isMultiplexed = true;

    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);

      // Try to detect if stream is multiplexed
      if (buffer.length >= 8 && isMultiplexed) {
        const header = buffer.slice(0, 8);
        const streamType = header[0];
        
        // If first byte isn't 1 (stdout) or 2 (stderr), assume not multiplexed
        if (streamType !== 1 && streamType !== 2) {
          isMultiplexed = false;
        }
      }

      if (!isMultiplexed) {
        // Not multiplexed, treat as raw stdout
        while (buffer.length > 0) {
          const size = Math.min(buffer.length, chunkSize);
          const data = buffer.slice(0, size).toString('utf8');
          buffer = buffer.slice(size);

          yield {
            channel: 'stdout',
            data,
            timestamp: new Date().toISOString(),
          };
        }
      } else {
        // Multiplexed stream
        while (buffer.length >= 8) {
          const header = buffer.slice(0, 8);
          const streamType = header[0];
          const payloadSize = header.readUInt32BE(4);

          if (buffer.length < 8 + payloadSize) {
            // Wait for more data
            break;
          }

          const payload = buffer.slice(8, 8 + payloadSize);
          buffer = buffer.slice(8 + payloadSize);

          const channel: 'stdout' | 'stderr' = streamType === 1 ? 'stdout' : 'stderr';
          const data = payload.toString('utf8');

          // Yield in chunks if payload is large
          let offset = 0;
          while (offset < data.length) {
            const chunkData = data.slice(offset, offset + chunkSize);
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
    if (buffer.length > 0 && !isMultiplexed) {
      yield {
        channel: 'stdout',
        data: buffer.toString('utf8'),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Demux logs which may have timestamps prepended
   */
  async* demuxLogs(stream: Readable, chunkSize: number): AsyncGenerator<DemuxedChunk> {
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
        data: buffer,
        timestamp: new Date().toISOString(),
      };
    }
  }
}