export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type BackoffConfig = {
  retries: number;
  initialDelay: number;
  maxDelay: number;
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void;
};

export const retryWithBackoff = async <T>(fn: () => Promise<T>, config: BackoffConfig): Promise<T> => {
  let attempt = 0;
  let delayMs = config.initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > config.retries) {
        throw error;
      }

      const nextDelayMs = Math.min(delayMs, config.maxDelay);
      config.onRetry?.(attempt, error, nextDelayMs);
      await delay(nextDelayMs);
      delayMs = Math.min(delayMs * 2, config.maxDelay);
    }
  }
};

export const parseJsonFromText = <T = unknown>(text: string): T => {
  const matches = text.match(/\{[\s\S]*\}/g);
  if (!matches || matches.length === 0) {
    throw new Error("Unable to find JSON object in text response.");
  }

  const jsonText = matches[matches.length - 1];
  return JSON.parse(jsonText) as T;
};
