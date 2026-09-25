/** A string field from a parsed JSON body, or "" when absent / not a string (core rejects it). */
export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

export type Params<K extends string> = { params: Promise<Record<K, string>> };
