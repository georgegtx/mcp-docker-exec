import { Logger } from '../observability/Logger.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  resetTimeout: number;
  name: string;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private nextAttempt = Date.now();
  private logger: Logger;

  constructor(private options: CircuitBreakerOptions) {
    this.logger = new Logger(`CircuitBreaker:${options.name}`);
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        const waitTime = Math.ceil((this.nextAttempt - Date.now()) / 1000);
        throw new Error(`Circuit breaker is OPEN. Service ${this.options.name} unavailable. Retry in ${waitTime}s`);
      }
      
      // Move to half-open state
      this.state = CircuitState.HALF_OPEN;
      this.logger.info('Circuit breaker moving to HALF_OPEN state');
    }

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Operation timeout')), this.options.timeout);
      });

      const result = await Promise.race([operation(), timeoutPromise]);
      
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        this.successes++;
        if (this.successes >= this.options.successThreshold) {
          this.state = CircuitState.CLOSED;
          this.successes = 0;
          this.logger.info('Circuit breaker is now CLOSED');
        }
        break;
      case CircuitState.CLOSED:
        // Normal operation
        break;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.successes = 0;

    switch (this.state) {
      case CircuitState.HALF_OPEN:
        this.state = CircuitState.OPEN;
        this.nextAttempt = Date.now() + this.options.resetTimeout;
        this.logger.warn('Circuit breaker is now OPEN', { 
          nextAttempt: new Date(this.nextAttempt).toISOString() 
        });
        break;
      case CircuitState.CLOSED:
        if (this.failures >= this.options.failureThreshold) {
          this.state = CircuitState.OPEN;
          this.nextAttempt = Date.now() + this.options.resetTimeout;
          this.logger.warn('Circuit breaker is now OPEN', {
            failures: this.failures,
            threshold: this.options.failureThreshold,
            nextAttempt: new Date(this.nextAttempt).toISOString()
          });
        }
        break;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      nextAttempt: this.state === CircuitState.OPEN ? new Date(this.nextAttempt).toISOString() : null,
    };
  }
}