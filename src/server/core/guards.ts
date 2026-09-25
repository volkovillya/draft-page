import type { Actor, MemberActor } from "./actor";
import { invalid, notAllowed } from "./failures";
import { isUuid } from "./ids";

/** Refuses anything that isn't a signed-in member, before touching the database. */
export function requireMember(actor: Actor): MemberActor {
  if (actor.kind !== "member") throw notAllowed("Only people can do this");
  return actor;
}

export function requireUuid(value: string, what: string): string {
  if (!isUuid(value)) throw invalid(`${what} is not a valid id`);
  return value;
}

export function requireText(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== "string") throw invalid(`${what} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw invalid(`${what} is required`);
  if (trimmed.length > max) throw invalid(`${what} is too long (max ${max} characters)`);
  return trimmed;
}

export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export function requireHtml(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid("HTML is required");
  if (Buffer.byteLength(value, "utf8") > MAX_HTML_BYTES) throw invalid("HTML is larger than 2 MiB");
  return value;
}
