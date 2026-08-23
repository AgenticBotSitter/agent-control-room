export type SafeErrorCode = "invalid_request" | "forbidden" | "not_found" | "conflict" | "temporarily_unavailable" | "internal_error";

export class SafeOperationalError extends Error {
  constructor(readonly code: SafeErrorCode, message: string, readonly correlationId?: string) {
    super(message);
    this.name = "SafeOperationalError";
  }
}

export function safeErrorResponse(error: unknown, correlationId?: string): { code: SafeErrorCode; message: string; correlationId?: string } {
  if (error instanceof SafeOperationalError) return { code: error.code, message: error.message, ...(error.correlationId ? { correlationId: error.correlationId } : {}) };
  return { code: "internal_error", message: "The operation could not be completed safely.", ...(correlationId ? { correlationId } : {}) };
}
