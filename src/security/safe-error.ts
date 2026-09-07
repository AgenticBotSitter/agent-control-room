export type SafeErrorCode = "invalid_request" | "forbidden" | "not_found" | "conflict" | "temporarily_unavailable" | "internal_error";

const safeMessages: Record<SafeErrorCode, string> = {
  invalid_request: "The request is invalid.",
  forbidden: "The operation is not permitted.",
  not_found: "The requested resource was not found.",
  conflict: "The operation conflicts with the current state.",
  temporarily_unavailable: "The service is temporarily unavailable.",
  internal_error: "The operation could not be completed safely.",
};

function safeCorrelationId(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

export class SafeOperationalError extends Error {
  readonly correlationId?: string;

  constructor(readonly code: SafeErrorCode, correlationId?: string) {
    super(safeMessages[code]);
    this.name = "SafeOperationalError";
    this.correlationId = safeCorrelationId(correlationId);
  }
}

export function safeErrorResponse(error: unknown, correlationId?: string): { code: SafeErrorCode; message: string; correlationId?: string } {
  if (error instanceof SafeOperationalError) return { code: error.code, message: safeMessages[error.code], ...(error.correlationId ? { correlationId: error.correlationId } : {}) };
  const safeId = safeCorrelationId(correlationId);
  return { code: "internal_error", message: safeMessages.internal_error, ...(safeId ? { correlationId: safeId } : {}) };
}
