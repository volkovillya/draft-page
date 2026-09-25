import { NextResponse } from "next/server";
import { errorResponse } from "./http";

/**
 * Header API Gateway sets on the internal route after verifying the caller's SigV4 signature
 * (IAM authorization): the caller's assumed-role ARN. On every other route API Gateway
 * overwrites it, so a browser can't forge it (infra/apigw.tf).
 */
export const WORKER_IDENTITY_HEADER = "x-draftpage-caller-arn";

const SESSION_NAME = /^[\w+=.@-]{2,64}$/;

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/**
 * Wraps an internal route used only by the AI worker (decision D11). Off (404) unless
 * DRAFTPAGE_WORKER_ROLE_ARN is set; then only callers signed as that IAM role get through.
 * API Gateway already refuses unsigned requests; this is the second check, in the app.
 */
export function withWorker<C>(handler: Handler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    const expected = assumedRolePrefix(process.env.DRAFTPAGE_WORKER_ROLE_ARN);
    if (!expected) return NextResponse.json({ error: { code: "missing", message: "Not found" } }, { status: 404 });
    const caller = request.headers.get(WORKER_IDENTITY_HEADER) ?? "";
    // Exactly one assumed-role session name after the prefix: nothing appended (no commas).
    if (!caller.startsWith(expected) || !SESSION_NAME.test(caller.slice(expected.length))) {
      return NextResponse.json({ error: { code: "not_allowed", message: "Worker only" } }, { status: 403 });
    }
    try {
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * arn:aws:iam::123456789012:role/name → "arn:aws:sts::123456789012:assumed-role/name/", the
 * form API Gateway reports for a Lambda's role session. Undefined for anything else.
 */
export function assumedRolePrefix(roleArn: string | undefined): string | undefined {
  const match = /^arn:(aws[\w-]*):iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]+)$/.exec(roleArn ?? "");
  return match ? `arn:${match[1]}:sts::${match[2]}:assumed-role/${match[3]}/` : undefined;
}
