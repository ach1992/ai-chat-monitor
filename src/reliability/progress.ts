const MASK_64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MAX_PROGRESS_TAIL = 3_000;
const MAX_PROGRESS_TOKENS = 512;

export type ProgressSafetyResult =
  | { hold: false }
  | { hold: true; reason: "REPEATED_OUTCOME" | "HARD_FUSE" };

function normalizedProgressTail(value: string): string {
  return value
    .slice(-MAX_PROGRESS_TAIL)
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/https?:\/\/\S+/g, " [url] ")
    .replace(/\b[0-9a-f]{8,}\b/gi, " [id] ")
    .replace(/\b\d+(?:[.,:]\d+)*\b/g, " [number] ")
    .replace(/[^\p{L}\p{N}_\[\]-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashToken(token: string): bigint {
  let hash = FNV_OFFSET;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= BigInt(token.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

export function outcomeSignature(value: string): string {
  const normalized = normalizedProgressTail(value);
  if (normalized.length === 0) return "0000000000000000";
  const tokens = normalized.split(" ").filter((token) => token.length >= 2).slice(-MAX_PROGRESS_TOKENS);
  if (tokens.length === 0) return "0000000000000000";
  const weights = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = hashToken(token);
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] = (weights[bit] ?? 0) + (((hash >> BigInt(bit)) & 1n) === 1n ? 1 : -1);
    }
  }
  let signature = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] ?? 0) >= 0) signature |= 1n << BigInt(bit);
  }
  return signature.toString(16).padStart(16, "0");
}

function hammingDistance(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/.test(left) || !/^[0-9a-f]{16}$/.test(right)) return 64;
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (difference !== 0n) {
    difference &= difference - 1n;
    distance += 1;
  }
  return distance;
}

export function materiallySimilarOutcome(left: string, right: string): boolean {
  return hammingDistance(left, right) <= 5;
}

export function evaluateProgressSafety(
  currentSignature: string,
  priorSignatures: readonly string[],
  verifiedCount: number,
  hardFuseMaxAutoContinues: number,
): ProgressSafetyResult {
  const recentComparable = priorSignatures.filter((signature) => /^[a-f0-9]{16}$/.test(signature)).slice(-2);
  if (
    recentComparable.length === 2 &&
    recentComparable.every((signature) => materiallySimilarOutcome(currentSignature, signature))
  ) {
    return { hold: true, reason: "REPEATED_OUTCOME" };
  }
  if (verifiedCount >= hardFuseMaxAutoContinues) return { hold: true, reason: "HARD_FUSE" };
  return { hold: false };
}
