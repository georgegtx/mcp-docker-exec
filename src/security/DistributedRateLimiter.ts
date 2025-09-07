import { Logger } from '../observability/Logger.js';

export interface RateLimiterBackend {
  increment(key: string, windowMs: number): Promise<{ count: number; ttl: number }>;
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

  increment(key: string, windowMs: number): Promise<{ count: number; ttl: number }> {
    const now = Date.now();
    const existing = this.counts.get(key);

    if (!existing || existing.resetAt < now) {
      const resetAt = now + windowMs;
      this.counts.set(key, { count: 1, resetAt });
      return Promise.resolve({ count: 1, ttl: Math.ceil(windowMs / 1000) });
    }

    existing.count++;
    const remainingMs = existing.resetAt - now;
    return Promise.resolve({ count: existing.count, ttl: Math.ceil(remainingMs / 1000) });
  }

  get(key: string): Promise<number> {
    const now = Date.now();
    const existing = this.counts.get(key);

    if (!existing || existing.resetAt < now) {
      return Promise.resolve(0);
    }

    return Promise.resolve(existing.count);
  }

  reset(key: string): Promise<void> {
    this.counts.delete(key);
    return Promise.resolve();
  }

  close(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.counts.clear();
    return Promise.resolve();
  }
}

// Redis implementation (optional, loaded dynamically)
export class RedisRateLimiter implements RateLimiterBackend {
  private redis: any; // Redis client

  private constructor(redis: any) {
    this.redis = redis;
  }

  static async create(redisUrl: string): Promise<RedisRateLimiter> {
    try {
      const RedisModule = await import('ioredis');
      const Redis = RedisModule.default || RedisModule;
      const redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
      });
      return new RedisRateLimiter(redis);
    } catch (error) {
      throw new Error(
        'Redis support not available. Install ioredis package for distributed rate limiting.'
      );
    }
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; ttl: number }> {
    const multi = this.redis.multi();
    const ttl = Math.ceil(windowMs / 1000);

    multi.incr(key);
    multi.expire(key, ttl);
    multi.ttl(key);

    const results = await multi.exec();
    return {
      count: results[0][1], // The increment result
      ttl: results[2][1] > 0 ? results[2][1] : ttl, // The actual TTL in seconds
    };
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

  private constructor(backend: RateLimiterBackend) {
    this.backend = backend;
    this.logger = new Logger('DistributedRateLimiter');
  }

  static async create(redisUrl?: string): Promise<DistributedRateLimiter> {
    const logger = new Logger('DistributedRateLimiter');

    if (redisUrl) {
      try {
        const backend = await RedisRateLimiter.create(redisUrl);
        logger.info('Using Redis for distributed rate limiting', { url: redisUrl });
        return new DistributedRateLimiter(backend);
      } catch (error) {
        logger.warn('Failed to initialize Redis rate limiter, falling back to in-memory', {
          error,
        });
        return new DistributedRateLimiter(new InMemoryRateLimiter());
      }
    } else {
      logger.info('Using in-memory rate limiter');
      return new DistributedRateLimiter(new InMemoryRateLimiter());
    }
  }

  async checkLimit(
    identifier: string,
    operation: string,
    limit: number,
    windowMs: number = 60000
  ): Promise<{ allowed: boolean; current: number; limit: number; resetAt: number }> {
    const key = `rate_limit:${operation}:${identifier}`;
    const result = await this.backend.increment(key, windowMs);
    const resetAt = Date.now() + result.ttl * 1000; // Convert TTL seconds to milliseconds

    const allowed = result.count <= limit;

    if (!allowed) {
      this.logger.warn('Rate limit exceeded', {
        identifier,
        operation,
        current: result.count,
        limit,
      });
    }

    return { allowed, current: result.count, limit, resetAt };
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
