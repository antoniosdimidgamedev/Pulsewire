export type ChatErrorCode =
  | "not_connected"
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "storage_unavailable"
  | "storage_corrupt"
  | "write_failed"
  | "auth_required"
  | "network_error"
  | "rate_limited";

/** An expected, user-presentable failure from a chat provider. */
export class ChatError extends Error {
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChatError";
    this.code = code;
  }
}

export function isChatError(error: unknown): error is ChatError {
  return error instanceof ChatError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}
