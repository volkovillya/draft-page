import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l to keep links readable
export const SHORT_ID_LENGTH = 10;

export function newShortId(): string {
  let out = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID_RE.test(value);
