export class ActionError extends Error {
  readonly details: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, details?: string, { retryable = false }: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'ActionError';
    this.details = details;
    this.retryable = retryable;
  }
}

interface NetworkCause {
  message?: string;
  code?: string;
  errors?: Array<{ message?: string }>;
}

export function networkReason(error: unknown): string {
  const cause = (error as { cause?: NetworkCause } | undefined)?.cause;
  const nested = Array.isArray(cause?.errors) ? [...new Set(cause.errors.map((each) => each?.message).filter(Boolean))].join('; ') : '';
  return String(cause?.message || nested || cause?.code || (error as Error | undefined)?.message || error).slice(0, 500);
}
