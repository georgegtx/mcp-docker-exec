import { Logger } from '../observability/Logger.js';

export interface RateLimiterBackend {
  increment(key: string, windowMs: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}

// In-memory fallback implementation
export class InMemoryRateLimiter implements RateLimiterBackend {
  private counts: Map<string, { count: number; resetAt: number }> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Cleanup old entries every minute
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.counts.entries()) {
        if (value.resetAt < now) {
          this.counts.delete(key);
        }
      }
    }, 60000);
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const existing = this.counts.get(key);

    if (!existing || existing.resetAt < now) {
      this.counts.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }

    existing.count++;
    return existing.count;
  }

  async get(key: string): Promise<number> {
    const now = Date.now();
    const existing = this.counts.get(key);
    
    if (!existing || existing.resetAt < now) {
      return 0;
    }
    
    return existing.count;
  }

  async reset(key: string): Promise<void> {
    this.counts.delete(key);
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.counts.clear();
  }
}

// Redis implementation (optional, loaded dynamically)
export class RedisRateLimiter implements RateLimiterBackend {
  private redis: any; // Redis client

  constructor(redisUrl: string) {
    // Dynamically import redis if available
    try {
      const Redis = require('ioredis');
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
      });
    } catch (error) {
      throw new Error('Redis support not available. Install ioredis package for distributed rate limiting.');
    }
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const multi = this.redis.multi();
    const ttl = Math.ceil(windowMs / 1000);
    
    multi.incr(key);
    multi.expire(key, ttl);
    
    const results = await multi.exec();
    return results[0][1]; // Return the increment result
  }

  async get(key: string): Promise<number> {
    const value = await this.redis.get(key);
    return parseInt(value || '0', 10);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export class DistributedRateLimiter {
  private backend: RateLimiterBackend;
  private logger: Logger;

  constructor(redisUrl?: string) {
    this.logger = new Logger('DistributedRateLimiter');
    
    if (redisUrl) {
      try {
        this.backend = new RedisRateLimiter(redisUrl);
        this.logger.info('Using Redis for distributed rate limiting', { url: redisUrl });
      } catch (error) {
        this.logger.warn('Failed to initialize Redis rate limiter, falling back to in-memory', { error });
        this.backend = new InMemoryRateLimiter();
      }
    } else {
      this.backend = new InMemoryRateLimiter();
      this.logger.info('Using in-memory rate limiter');
    }
  }

  async checkLimit(
    identifier: string,
    operation: string,
    limit: number,
    windowMs: number = 60000
  ): Promise<{ allowed: boolean; current: number; limit: number; resetAt: number }> {
    const key = `rate_limit:${operation}:${identifier}`;
    const current = await this.backend.increment(key, windowMs);
    const resetAt = Date.now() + windowMs;

    const allowed = current <= limit;

    if (!allowed) {
      this.logger.warn('Rate limit exceeded', {
        identifier,
        operation,
        current,
        limit,
      });
    }

    return { allowed, current, limit, resetAt };
  }

  async getUsage(identifier: string, operation: string): Promise<number> {
    const key = `rate_limit:${operation}:${identifier}`;
    return this.backend.get(key);
  }

  async reset(identifier: string, operation: string): Promise<void> {
    const key = `rate_limit:${operation}:${identifier}`;
    await this.backend.reset(key);
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}