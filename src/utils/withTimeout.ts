export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${errorMessage} after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);
  });

  // Wrap the original promise to handle abort
  const abortablePromise = new Promise<T>((resolve, reject) => {
    promise.then(resolve, reject);
    
    controller.signal.addEventListener('abort', () => {
      reject(new TimeoutError(`${errorMessage} after ${timeoutMs}ms`, timeoutMs));
    });
  });

  try {
    const result = await Promise.race([abortablePromise, timeoutPromise]);
    return result;
  } finally {
    // Clear the timeout in all cases
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    // Abort if still pending
    controller.abort();
  }
}

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}