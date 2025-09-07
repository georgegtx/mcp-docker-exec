import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { StreamDemuxer } from '../../src/docker/StreamDemuxer.js';

describe('StreamDemuxer', () => {
  const demuxer = new StreamDemuxer();

  describe('demuxStream', () => {
    it('should handle non-multiplexed stream', async () => {
      const data = 'Hello, World!\nThis is a test.';
      const stream = Readable.from([Buffer.from(data)]);
      
      const chunks: any[] = [];
      for await (const chunk of demuxer.demuxStream(stream, 1024)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].channel).toBe('stdout');
      expect(chunks[0].data).toBe(data);
    });

    it('should handle Docker multiplexed stream', async () => {
      // Docker multiplexed format: [stream_type(1), 0, 0, 0, size(4), payload]
      const stdoutHeader = Buffer.alloc(8);
      stdoutHeader[0] = 1; // stdout
      stdoutHeader.writeUInt32BE(5, 4); // payload size
      const stdoutPayload = Buffer.from('Hello');

      const stderrHeader = Buffer.alloc(8);
      stderrHeader[0] = 2; // stderr
      stderrHeader.writeUInt32BE(5, 4); // payload size
      const stderrPayload = Buffer.from('Error');

      const stream = Readable.from([
        Buffer.concat([stdoutHeader, stdoutPayload, stderrHeader, stderrPayload])
      ]);

      const chunks: any[] = [];
      for await (const chunk of demuxer.demuxStream(stream, 1024)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].channel).toBe('stdout');
      expect(chunks[0].data).toBe('Hello');
      expect(chunks[1].channel).toBe('stderr');
      expect(chunks[1].data).toBe('Error');
    });

    it('should handle large payloads with chunking', async () => {
      const largeData = 'X'.repeat(100);
      const header = Buffer.alloc(8);
      header[0] = 1; // stdout
      header.writeUInt32BE(100, 4);
      const payload = Buffer.from(largeData);

      const stream = Readable.from([Buffer.concat([header, payload])]);

      const chunks: any[] = [];
      for await (const chunk of demuxer.demuxStream(stream, 10)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(1);
      const reconstructed = chunks.map(c => c.data).join('');
      expect(reconstructed).toBe(largeData);
    });

    it('should handle partial headers across chunks', async () => {
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(5, 4);
      const payload = Buffer.from('Hello');

      // Split header across chunks
      const stream = Readable.from([
        header.slice(0, 4),
        Buffer.concat([header.slice(4), payload])
      ]);

      const chunks: any[] = [];
      for await (const chunk of demuxer.demuxStream(stream, 1024)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].data).toBe('Hello');
    });
  });

  describe('demuxLogs', () => {
    it('should parse timestamped log lines', async () => {
      const logs = [
        '2024-01-01T12:00:00.000Z Line 1',
        '2024-01-01T12:00:01.000Z Line 2',
        'Line without timestamp',
      ].join('\n');

      const stream = Readable.from([Buffer.from(logs)]);

      const chunks: any[] = [];
      for await (const chunk of demuxer.demuxLogs(stream, 1024)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0].data).toBe('Line 1\n');
      expect(chunks[0].timestamp).toBe('2024-01-01T12:00:00.000Z');
      expect(chunks[1].data).toBe('Line 2\n');
      expect(chunks[1].timestamp).toBe('2024-01-01T12:00:01.000Z');
      expect(chunks[2].data).toBe('Line without timestamp\n');
    });

    it('should handle incomplete lines', async () => {
      const stream = Readable.from([
        Buffer.from('Partial line'),
        Buffer.from(' continued\nComplete line\n')
      ]);

      const chunks: any[] = [];
      for await (const chunk of demuxer.demuxLogs(stream, 1024)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].data).toBe('Partial line continued\n');
      expect(chunks[1].data).toBe('Complete line\n');
    });
  });
});