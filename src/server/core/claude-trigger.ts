export const MAX_INSTRUCTION_LENGTH = 4000;

const LEADING_MENTION = /^@claude\b[\s,:-]*/i;

/**
 * Decides whether a thread's opening message asks Claude for an edit.
 * Only a leading "@Claude" counts; the rest is the instruction.
 */
export function parseClaudeRequest(text: string): { requested: boolean; instruction: string } {
  const trimmed = text.trim();
  const match = LEADING_MENTION.exec(trimmed);
  if (!match) return { requested: false, instruction: "" };
  const instruction = trimmed.slice(match[0].length).trim();
  const requested = instruction.length >= 1 && instruction.length <= MAX_INSTRUCTION_LENGTH;
  return { requested, instruction: requested ? instruction : "" };
}

/** True when a message starts with "@Claude" but its instruction is longer than a request may be. */
export function claudeInstructionTooLong(text: string): boolean {
  const trimmed = text.trim();
  const match = LEADING_MENTION.exec(trimmed);
  return match !== null && trimmed.slice(match[0].length).trim().length > MAX_INSTRUCTION_LENGTH;
}
