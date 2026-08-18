import type { ConversationTurn, SanitizedContext, SanitizedTurn } from "./types.js";

export interface ContextSanitizerOptions {
  maxTurns?: number;
  maxTurnCharacters?: number;
  maxTotalCharacters?: number;
  maxCodeBlockCharacters?: number;
}

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_MAX_TURN_CHARACTERS = 4_000;
const DEFAULT_MAX_TOTAL_CHARACTERS = 8_000;
const DEFAULT_MAX_CODE_BLOCK_CHARACTERS = 800;
const OMITTED_PREFIX = "[earlier content omitted] ";

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(api[_-]?key|apikey|token)\s*[:=]\s*["']?([A-Za-z0-9._-]{12,})["']?/gi, "$1=[REDACTED]");
}

function minimizeCodeBlocks(value: string, maxCodeBlockCharacters: number): string {
  return value.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (match, language: string, body: string) => {
    if (match.length <= maxCodeBlockCharacters) return match;
    const label = language.trim();
    const omitted = `[omitted ${body.length} characters of code/log content]`;
    return label.length === 0 ? `\`\`\`\n${omitted}\n\`\`\`` : `\`\`\`${label}\n${omitted}\n\`\`\``;
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function truncateTail(value: string, maxCharacters: number): { content: string; truncated: boolean } {
  if (value.length <= maxCharacters) return { content: value, truncated: false };
  const available = Math.max(0, maxCharacters - OMITTED_PREFIX.length);
  return { content: `${OMITTED_PREFIX}${value.slice(-available)}`, truncated: true };
}

function sanitizeTurn(
  turn: ConversationTurn,
  maxTurnCharacters: number,
  maxCodeBlockCharacters: number,
): SanitizedTurn | undefined {
  const originalLength = turn.content.length;
  const cleaned = normalizeText(minimizeCodeBlocks(redactSecrets(turn.content), maxCodeBlockCharacters));
  if (cleaned.length === 0) return undefined;
  const bounded = truncateTail(cleaned, maxTurnCharacters);
  return {
    role: turn.role,
    content: bounded.content,
    originalLength,
    truncated: bounded.truncated || cleaned.length !== originalLength,
  };
}

export function sanitizeContext(
  turns: readonly ConversationTurn[],
  options: ContextSanitizerOptions = {},
): SanitizedContext {
  const maxTurns = clampInteger(options.maxTurns, DEFAULT_MAX_TURNS, 1, 8);
  const maxTurnCharacters = clampInteger(
    options.maxTurnCharacters,
    DEFAULT_MAX_TURN_CHARACTERS,
    256,
    12_000,
  );
  const maxTotalCharacters = clampInteger(
    options.maxTotalCharacters,
    DEFAULT_MAX_TOTAL_CHARACTERS,
    512,
    24_000,
  );
  const maxCodeBlockCharacters = clampInteger(
    options.maxCodeBlockCharacters,
    DEFAULT_MAX_CODE_BLOCK_CHARACTERS,
    128,
    4_000,
  );

  const recent = turns.slice(-maxTurns);
  const sanitized = recent
    .map((turn) => sanitizeTurn(turn, maxTurnCharacters, maxCodeBlockCharacters))
    .filter((turn): turn is SanitizedTurn => turn !== undefined);

  const selected: SanitizedTurn[] = [];
  let totalCharacters = 0;
  let totalTruncated = recent.length !== turns.length;

  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const turn = sanitized[index];
    if (turn === undefined) continue;
    const remaining = maxTotalCharacters - totalCharacters;
    if (remaining <= 0) {
      totalTruncated = true;
      break;
    }

    if (turn.content.length <= remaining) {
      selected.unshift(turn);
      totalCharacters += turn.content.length;
      totalTruncated ||= turn.truncated;
      continue;
    }

    const bounded = truncateTail(turn.content, remaining);
    selected.unshift({ ...turn, content: bounded.content, truncated: true });
    totalCharacters += bounded.content.length;
    totalTruncated = true;
    break;
  }

  return { turns: selected, totalCharacters, truncated: totalTruncated };
}
