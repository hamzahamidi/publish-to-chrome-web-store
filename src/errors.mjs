export class ActionError extends Error {
  constructor(message, details, { retryable = false } = {}) {
    super(message);
    this.name = 'ActionError';
    this.details = details;
    this.retryable = retryable;
  }
}

export function networkReason(error) {
  const cause = error?.cause;
  const nested = Array.isArray(cause?.errors) ? [...new Set(cause.errors.map((each) => each?.message).filter(Boolean))].join('; ') : '';
  return String(cause?.message || nested || cause?.code || error?.message || error).slice(0, 500);
}
