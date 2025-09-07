import { Logger } from '../observability/Logger.js';

export interface DockerError extends Error {
  statusCode?: number;
  json?: any;
  reason?: string;
}

export class ErrorHandler {
  constructor(private logger: Logger) {}

  handleDockerError(
    error: DockerError,
    operation: string
  ): { message: string; code?: string; retryable: boolean } {
    // Common Docker error codes
    const errorPatterns = [
      { pattern: /no such container/i, code: 'CONTAINER_NOT_FOUND', retryable: false },
      { pattern: /no such image/i, code: 'IMAGE_NOT_FOUND', retryable: false },
      { pattern: /container.*is not running/i, code: 'CONTAINER_NOT_RUNNING', retryable: false },
      { pattern: /permission denied/i, code: 'PERMISSION_DENIED', retryable: false },
      { pattern: /cannot connect to docker/i, code: 'DOCKER_UNAVAILABLE', retryable: true },
      { pattern: /socket hang up/i, code: 'CONNECTION_LOST', retryable: true },
      { pattern: /ECONNREFUSED/i, code: 'CONNECTION_REFUSED', retryable: true },
      { pattern: /timeout/i, code: 'TIMEOUT', retryable: true },
      { pattern: /out of memory/i, code: 'OUT_OF_MEMORY', retryable: false },
      { pattern: /disk quota exceeded/i, code: 'DISK_QUOTA_EXCEEDED', retryable: false },
    ];

    const message = error.message || error.toString();

    // Check against known patterns
    for (const { pattern, code, retryable } of errorPatterns) {
      if (pattern.test(message)) {
        return {
          message: this.sanitizeErrorMessage(message),
          code,
          retryable,
        };
      }
    }

    // Handle HTTP status codes
    if (error.statusCode) {
      switch (error.statusCode) {
        case 404:
          return { message: `${operation} not found`, code: 'NOT_FOUND', retryable: false };
        case 409:
          return {
            message: 'Conflict: operation already in progress',
            code: 'CONFLICT',
            retryable: false,
          };
        case 500:
          return { message: 'Docker daemon error', code: 'INTERNAL_ERROR', retryable: true };
        case 503:
          return {
            message: 'Docker service unavailable',
            code: 'SERVICE_UNAVAILABLE',
            retryable: true,
          };
        default:
          return {
            message: `Docker API error (${error.statusCode})`,
            code: `HTTP_${error.statusCode}`,
            retryable: error.statusCode >= 500,
          };
      }
    }

    // Default handling
    return {
      message: this.sanitizeErrorMessage(message),
      code: 'UNKNOWN_ERROR',
      retryable: false,
    };
  }

  private sanitizeErrorMessage(message: string): string {
    // Remove potentially sensitive information
    const sanitized = message
      .replace(/\/[a-zA-Z0-9_\-./]+\/(docker|containers|var\/lib)/g, '/<path>/$1')
      .replace(/[0-9a-f]{64}/g, '<container-id>')
      .replace(/[0-9a-f]{12}/g, '<short-id>')
      .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '<ip-address>')
      .replace(/:[0-9]{2,5}/g, ':<port>');

    return sanitized;
  }

  async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3,
    backoffMs: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        const errorInfo = this.handleDockerError(error, operationName);

        if (!errorInfo.retryable || attempt === maxRetries) {
          throw error;
        }

        const delay = backoffMs * Math.pow(2, attempt - 1);
        this.logger.warn(`Operation failed, retrying...`, {
          operation: operationName,
          attempt,
          maxRetries,
          delay,
          error: errorInfo.message,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
