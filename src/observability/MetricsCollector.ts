export interface Metrics {
  toolCalls: Map<string, number>;
  toolErrors: Map<string, number>;
  execDurations: number[];
  outputBytesHistogram: number[];
  activeSessions: number;
  totalExecs: number;
  totalBytes: number;
}

export class MetricsCollector {
  private metrics: Metrics = {
    toolCalls: new Map(),
    toolErrors: new Map(),
    execDurations: [],
    outputBytesHistogram: [],
    activeSessions: 0,
    totalExecs: 0,
    totalBytes: 0,
  };

  incrementToolCall(tool: string): void {
    const current = this.metrics.toolCalls.get(tool) || 0;
    this.metrics.toolCalls.set(tool, current + 1);
  }

  incrementToolError(tool: string): void {
    const current = this.metrics.toolErrors.get(tool) || 0;
    this.metrics.toolErrors.set(tool, current + 1);
  }

  recordExecDuration(durationMs: number): void {
    this.metrics.execDurations.push(durationMs);
    this.metrics.totalExecs++;

    // Keep only last 1000 durations to avoid memory issues
    if (this.metrics.execDurations.length > 1000) {
      this.metrics.execDurations = this.metrics.execDurations.slice(-1000);
    }
  }

  recordOutputBytes(bytes: number): void {
    this.metrics.outputBytesHistogram.push(bytes);
    this.metrics.totalBytes += bytes;

    // Keep only last 1000 entries
    if (this.metrics.outputBytesHistogram.length > 1000) {
      this.metrics.outputBytesHistogram = this.metrics.outputBytesHistogram.slice(-1000);
    }
  }

  incrementActiveSessions(): void {
    this.metrics.activeSessions++;
  }

  decrementActiveSessions(): void {
    this.metrics.activeSessions = Math.max(0, this.metrics.activeSessions - 1);
  }

  getMetrics(): any {
    const toolCallsObj = Object.fromEntries(this.metrics.toolCalls);
    const toolErrorsObj = Object.fromEntries(this.metrics.toolErrors);

    return {
      toolCalls: toolCallsObj,
      toolErrors: toolErrorsObj,
      execStats: {
        total: this.metrics.totalExecs,
        activeSessions: this.metrics.activeSessions,
        avgDuration: this.calculateAverage(this.metrics.execDurations),
        p95Duration: this.calculatePercentile(this.metrics.execDurations, 0.95),
        p99Duration: this.calculatePercentile(this.metrics.execDurations, 0.99),
      },
      outputStats: {
        totalBytes: this.metrics.totalBytes,
        avgBytes: this.calculateAverage(this.metrics.outputBytesHistogram),
        p95Bytes: this.calculatePercentile(this.metrics.outputBytesHistogram, 0.95),
        p99Bytes: this.calculatePercentile(this.metrics.outputBytesHistogram, 0.99),
      },
    };
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * percentile);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  // Hook for external metrics systems (Prometheus, etc.)
  registerMetricsEndpoint(handler: (metrics: any) => void): void {
    setInterval(() => {
      handler(this.getMetrics());
    }, 30000); // Export every 30 seconds
  }
}
