/** Typed domain failures. Route handlers map `code` to an HTTP status. */
export type FailureCode = "unauthenticated" | "not_allowed" | "missing" | "invalid" | "conflict";

export const httpStatusFor: Record<FailureCode, number> = {
  unauthenticated: 401,
  not_allowed: 403,
  missing: 404,
  invalid: 400,
  conflict: 409,
};

export class Failure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "Failure";
  }
}

export const unauthenticated = (msg = "Sign in required") => new Failure("unauthenticated", msg);
export const notAllowed = (msg = "You can't do that") => new Failure("not_allowed", msg);
export const missing = (what: string) => new Failure("missing", `${what} not found`);
export const invalid = (msg: string) => new Failure("invalid", msg);
export const conflict = (msg: string) => new Failure("conflict", msg);
