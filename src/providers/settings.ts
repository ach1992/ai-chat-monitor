import type {
  OpenAICompatibleProviderProfile,
  OpenRouterProviderProfile,
  ProviderProfile,
  ProviderSettingsState,
} from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_PROVIDER_TIMEOUT_MS = 12_000;
export const DEFAULT_PROVIDER_MIN_CONFIDENCE = 0.9;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "host",
  "content-length",
  "origin",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider base URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") throw new Error("Provider base URL must use HTTPS.");
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Provider base URL cannot contain credentials, query parameters, or fragments.");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function validateCommon(profile: ProviderProfile): void {
  if (!ID_PATTERN.test(profile.id)) throw new Error("Provider id must be a short token.");
  if (profile.apiKey.trim().length === 0 || profile.apiKey.length > 4_096) {
    throw new Error("Provider API key is missing or too large.");
  }
  if (profile.model.trim().length === 0 || profile.model.length > 200) {
    throw new Error("Provider model is missing or too large.");
  }
  const timeoutMs = profile.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("Provider timeout must be between 1000 and 60000 milliseconds.");
  }
  const minConfidence = profile.minConfidence ?? DEFAULT_PROVIDER_MIN_CONFIDENCE;
  if (!Number.isFinite(minConfidence) || minConfidence < 0.5 || minConfidence > 1) {
    throw new Error("Provider minimum confidence must be between 0.5 and 1.");
  }
  const headers = profile.headers ?? {};
  if (Object.keys(headers).length > 16) throw new Error("Provider custom headers are limited to 16 entries.");
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.trim().toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || FORBIDDEN_HEADERS.has(normalizedName)) {
      throw new Error(`Provider custom header is not allowed: ${name}`);
    }
    if (value.length > 512 || /[\r\n]/.test(value)) {
      throw new Error(`Provider custom header has an invalid value: ${name}`);
    }
  }
}

export function normalizeProviderProfile(profile: ProviderProfile): ProviderProfile {
  validateCommon(profile);
  if (profile.kind === "OPENROUTER") {
    if (profile.siteUrl !== undefined) {
      const site = new URL(profile.siteUrl);
      if (site.protocol !== "https:" && site.protocol !== "http:") {
        throw new Error("OpenRouter site URL must use HTTP or HTTPS.");
      }
      if (site.username.length > 0 || site.password.length > 0) {
        throw new Error("OpenRouter site URL cannot contain credentials.");
      }
    }
    if (profile.siteTitle !== undefined && profile.siteTitle.length > 120) {
      throw new Error("OpenRouter site title is too large.");
    }
    return {
      ...profile,
      id: profile.id.trim(),
      apiKey: profile.apiKey.trim(),
      model: profile.model.trim(),
    };
  }

  return {
    ...profile,
    id: profile.id.trim(),
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    apiKey: profile.apiKey.trim(),
    model: profile.model.trim(),
  };
}

export function createOpenRouterProfile(
  options: Omit<OpenRouterProviderProfile, "kind">,
): OpenRouterProviderProfile {
  return normalizeProviderProfile({ kind: "OPENROUTER", ...options }) as OpenRouterProviderProfile;
}

export function createOpenAICompatibleProfile(
  options: Omit<OpenAICompatibleProviderProfile, "kind">,
): OpenAICompatibleProviderProfile {
  return normalizeProviderProfile({ kind: "OPENAI_COMPATIBLE", ...options }) as OpenAICompatibleProviderProfile;
}

export function isProviderProfile(value: unknown): value is ProviderProfile {
  if (!isRecord(value)) return false;
  if (value.kind !== "OPENROUTER" && value.kind !== "OPENAI_COMPATIBLE") return false;
  if (typeof value.id !== "string" || typeof value.apiKey !== "string" || typeof value.model !== "string") return false;
  if (value.kind === "OPENAI_COMPATIBLE" && typeof value.baseUrl !== "string") return false;
  try {
    normalizeProviderProfile(value as unknown as ProviderProfile);
    return true;
  } catch {
    return false;
  }
}

export function normalizeProviderSettings(state: ProviderSettingsState): ProviderSettingsState {
  if (state.version !== 1 || !Array.isArray(state.profiles) || !Array.isArray(state.order)) {
    throw new Error("Provider settings schema is invalid.");
  }
  const profiles = state.profiles.map(normalizeProviderProfile);
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`Duplicate provider id: ${profile.id}`);
    ids.add(profile.id);
  }
  const order = state.order.map((id) => id.trim());
  if (new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
    throw new Error("Provider order contains duplicate or unknown ids.");
  }
  return { version: 1, profiles, order };
}

export function isProviderSettingsState(value: unknown): value is ProviderSettingsState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles) || !Array.isArray(value.order)) {
    return false;
  }
  if (!value.profiles.every(isProviderProfile) || !value.order.every((entry) => typeof entry === "string")) {
    return false;
  }
  try {
    normalizeProviderSettings(value as unknown as ProviderSettingsState);
    return true;
  } catch {
    return false;
  }
}

export interface RedactedProviderProfile {
  id: string;
  kind: ProviderProfile["kind"];
  model: string;
  endpoint: string;
}

export function providerOriginPattern(profile: ProviderProfile): string {
  const endpoint = profile.kind === "OPENROUTER" ? OPENROUTER_BASE_URL : normalizeBaseUrl(profile.baseUrl);
  const url = new URL(endpoint);
  return `${url.origin}/*`;
}

export function redactProviderProfile(profile: ProviderProfile): RedactedProviderProfile {
  return {
    id: profile.id,
    kind: profile.kind,
    model: profile.model,
    endpoint: profile.kind === "OPENROUTER" ? OPENROUTER_BASE_URL : normalizeBaseUrl(profile.baseUrl),
  };
}