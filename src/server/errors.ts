/** Errors that the HTTP layer can safely expose to API clients. */
export type ApiErrorCode =
  | "invalid_input"
  | "auth_required"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? defaultStatus(code);
  }
}

function defaultStatus(code: ApiErrorCode): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "auth_required":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "internal":
      return 500;
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError("invalid_input", message);
}

export function unauthorized(message = "Sign in to continue."): ApiError {
  return new ApiError("auth_required", message);
}

export function forbidden(message = "You do not have access to that resource."): ApiError {
  return new ApiError("forbidden", message);
}

export function notFound(message = "Not found."): ApiError {
  return new ApiError("not_found", message);
}

export function conflict(message: string): ApiError {
  return new ApiError("conflict", message);
}
