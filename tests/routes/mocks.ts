import type { MemberActor } from "@/server/core/actor";

export const MEMBER: MemberActor = {
  kind: "member",
  memberId: "auth0|member-1",
  email: "ada@example.com",
  name: "Ada",
};

export const VERSION_ID = "11111111-1111-4111-8111-111111111111";
export const THREAD_ID = "22222222-2222-4222-8222-222222222222";

/** Route context with already-resolved params, the way Next passes them (as a Promise). */
export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

export function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const getRequest = (url: string, method = "GET") => new Request(`http://localhost${url}`, { method });
