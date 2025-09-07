export class CircularBuffer {
  private buffer: string[] = [];
  private totalBytes = 0;
  private maxItems: number;
  private maxBytes: number;

  constructor(maxItems: number = 1000, maxBytes: number = 10 * 1024 * 1024) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  push(item: string): void {
    const itemBytes = Buffer.byteLength(item, 'utf8');

    // If single item exceeds max, truncate it
    if (itemBytes > this.maxBytes) {
      const truncated = item.slice(0, Math.floor(this.maxBytes / 2)) + '\n[TRUNCATED]\n';
      this.buffer = [truncated];
      this.totalBytes = Buffer.byteLength(truncated, 'utf8');
      return;
    }

    this.buffer.push(item);
    this.totalBytes += itemBytes;

    // Remove old items if we exceed limits
    while (
      (this.buffer.length > this.maxItems || this.totalBytes > this.maxBytes) &&
      this.buffer.length > 1
    ) {
      const removed = this.buffer.shift()!;
      this.totalBytes -= Buffer.byteLength(removed, 'utf8');
    }
  }

  getContents(): string {
    return this.buffer.join('');
  }

  getBytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.buffer = [];
    this.totalBytes = 0;
  }

  getStats() {
    return {
      items: this.buffer.length,
      bytes: this.totalBytes,
      maxItems: this.maxItems,
      maxBytes: this.maxBytes,
    };
  }
}
