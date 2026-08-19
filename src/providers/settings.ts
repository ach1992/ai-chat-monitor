import type {
  NaraRouterProviderProfile,
  OpenAICompatibleProviderProfile,
  OpenRouterProviderProfile,
  ProviderCatalogSpec,
  ProviderProfile,
  ProviderProfileMutation,
  ProviderSettingsState,
} from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const NARAROUTER_BASE_URL = "https://router.bynara.id/v1";
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

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
}

function invalid(message: string): never {
  throw new ProviderConfigurationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid("Provider base URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") invalid("Provider base URL must use HTTPS.");
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    invalid("Provider base URL cannot contain credentials, query parameters, or fragments.");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function validateId(value: string): string {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) invalid("Provider id must be a short token.");
  return normalized;
}

function validateModel(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) invalid("Provider model is missing or too large.");
  return normalized;
}

function normalizeOptionalApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 4_096) invalid("Provider API key is too large.");
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function validateCommon(profile: ProviderProfile): void {
  validateId(profile.id);
  if (profile.apiKey.trim().length === 0 || profile.apiKey.length > 4_096) {
    invalid("Provider API key is missing or too large.");
  }
  validateModel(profile.model);
  const timeoutMs = profile.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    invalid("Provider timeout must be between 1000 and 60000 milliseconds.");
  }
  const minConfidence = profile.minConfidence ?? DEFAULT_PROVIDER_MIN_CONFIDENCE;
  if (!Number.isFinite(minConfidence) || minConfidence < 0.5 || minConfidence > 1) {
    invalid("Provider minimum confidence must be between 0.5 and 1.");
  }
  const headers = profile.headers ?? {};
  if (Object.keys(headers).length > 16) invalid("Provider custom headers are limited to 16 entries.");
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.trim().toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || FORBIDDEN_HEADERS.has(normalizedName)) {
      invalid(`Provider custom header is not allowed: ${name}`);
    }
    if (value.length > 512 || /[\r\n]/.test(value)) {
      invalid(`Provider custom header has an invalid value: ${name}`);
    }
  }
}

function validateOpenRouterMetadata(profile: OpenRouterProviderProfile): void {
  if (profile.siteUrl !== undefined) {
    let site: URL;
    try {
      site = new URL(profile.siteUrl);
    } catch {
      return invalid("OpenRouter site URL must be valid.");
    }
    if (site.protocol !== "https:" && site.protocol !== "http:") {
      invalid("OpenRouter site URL must use HTTP or HTTPS.");
    }
    if (site.username.length > 0 || site.password.length > 0) {
      invalid("OpenRouter site URL cannot contain credentials.");
    }
  }
  if (profile.siteTitle !== undefined && profile.siteTitle.length > 120) {
    invalid("OpenRouter site title is too large.");
  }
}

export function providerBaseUrl(profile: ProviderProfile): string {
  if (profile.kind === "OPENROUTER") return OPENROUTER_BASE_URL;
  if (profile.kind === "NARAROUTER") return NARAROUTER_BASE_URL;
  return normalizeBaseUrl(profile.baseUrl);
}

export function normalizeProviderProfile(profile: ProviderProfile): ProviderProfile {
  validateCommon(profile);
  if (profile.kind === "OPENROUTER") {
    validateOpenRouterMetadata(profile);
    return {
      ...profile,
      id: validateId(profile.id),
      apiKey: profile.apiKey.trim(),
      model: validateModel(profile.model),
    };
  }
  if (profile.kind === "NARAROUTER") {
    return {
      ...profile,
      id: validateId(profile.id),
      apiKey: profile.apiKey.trim(),
      model: validateModel(profile.model),
    };
  }
  return {
    ...profile,
    id: validateId(profile.id),
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    apiKey: profile.apiKey.trim(),
    model: validateModel(profile.model),
  };
}

export function createOpenRouterProfile(
  options: Omit<OpenRouterProviderProfile, "kind">,
): OpenRouterProviderProfile {
  return normalizeProviderProfile({ kind: "OPENROUTER", ...options }) as OpenRouterProviderProfile;
}

export function createNaraRouterProfile(
  options: Omit<NaraRouterProviderProfile, "kind">,
): NaraRouterProviderProfile {
  return normalizeProviderProfile({ kind: "NARAROUTER", ...options }) as NaraRouterProviderProfile;
}

export function createOpenAICompatibleProfile(
  options: Omit<OpenAICompatibleProviderProfile, "kind">,
): OpenAICompatibleProviderProfile {
  return normalizeProviderProfile({ kind: "OPENAI_COMPATIBLE", ...options }) as OpenAICompatibleProviderProfile;
}

export function isProviderProfile(value: unknown): value is ProviderProfile {
  if (!isRecord(value)) return false;
  if (value.kind !== "OPENROUTER" && value.kind !== "NARAROUTER" && value.kind !== "OPENAI_COMPATIBLE") return false;
  if (typeof value.id !== "string" || typeof value.apiKey !== "string" || typeof value.model !== "string") return false;
  if (value.kind === "OPENAI_COMPATIBLE" && typeof value.baseUrl !== "string") return false;
  try {
    normalizeProviderProfile(value as unknown as ProviderProfile);
    return true;
  } catch {
    return false;
  }
}

export function normalizeProviderProfileMutation(mutation: ProviderProfileMutation): ProviderProfileMutation {
  const id = validateId(mutation.id);
  const model = validateModel(mutation.model);
  const apiKey = normalizeOptionalApiKey(mutation.apiKey);
  if (mutation.kind === "OPENROUTER") return { kind: "OPENROUTER", id, model, ...(apiKey === undefined ? {} : { apiKey }) };
  if (mutation.kind === "NARAROUTER") return { kind: "NARAROUTER", id, model, ...(apiKey === undefined ? {} : { apiKey }) };
  return {
    kind: "OPENAI_COMPATIBLE",
    id,
    model,
    baseUrl: normalizeBaseUrl(mutation.baseUrl),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export function isProviderProfileMutation(value: unknown): value is ProviderProfileMutation {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.model !== "string") return false;
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") return false;
  const common = new Set(["kind", "id", "model", "apiKey"]);
  if (value.kind === "OPENROUTER" || value.kind === "NARAROUTER") {
    if (!hasOnlyKeys(value, common)) return false;
  } else if (value.kind === "OPENAI_COMPATIBLE") {
    if (typeof value.baseUrl !== "string" || !hasOnlyKeys(value, new Set([...common, "baseUrl"]))) return false;
  } else {
    return false;
  }
  try {
    normalizeProviderProfileMutation(value as unknown as ProviderProfileMutation);
    return true;
  } catch {
    return false;
  }
}

export function providerMutationOriginPattern(mutation: ProviderProfileMutation): string {
  if (mutation.kind === "OPENROUTER") return `${new URL(OPENROUTER_BASE_URL).origin}/*`;
  if (mutation.kind === "NARAROUTER") return `${new URL(NARAROUTER_BASE_URL).origin}/*`;
  return `${new URL(normalizeBaseUrl(mutation.baseUrl)).origin}/*`;
}

export function resolveProviderProfileMutation(
  mutation: ProviderProfileMutation,
  existing?: ProviderProfile,
): ProviderProfile {
  const normalized = normalizeProviderProfileMutation(mutation);
  let apiKey = normalized.apiKey;
  if (apiKey === undefined) {
    if (existing === undefined) invalid("Provider API key is required for a new profile.");
    if (existing.kind !== normalized.kind || providerOriginPattern(existing) !== providerMutationOriginPattern(normalized)) {
      invalid("Enter a new API key when changing provider type or origin.");
    }
    apiKey = existing.apiKey;
  }

  if (normalized.kind === "OPENROUTER") {
    const preserved = existing?.kind === "OPENROUTER" ? existing : undefined;
    return normalizeProviderProfile({
      ...(preserved ?? {}),
      kind: "OPENROUTER",
      id: normalized.id,
      model: normalized.model,
      apiKey,
    } as OpenRouterProviderProfile);
  }
  if (normalized.kind === "NARAROUTER") {
    const preserved = existing?.kind === "NARAROUTER" ? existing : undefined;
    return normalizeProviderProfile({
      ...(preserved ?? {}),
      kind: "NARAROUTER",
      id: normalized.id,
      model: normalized.model,
      apiKey,
    } as NaraRouterProviderProfile);
  }
  const preserved = existing?.kind === "OPENAI_COMPATIBLE" ? existing : undefined;
  return normalizeProviderProfile({
    ...(preserved ?? {}),
    kind: "OPENAI_COMPATIBLE",
    id: normalized.id,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    apiKey,
  } as OpenAICompatibleProviderProfile);
}

export function normalizeProviderCatalogSpec(spec: ProviderCatalogSpec): ProviderCatalogSpec {
  const providerId = spec.providerId === undefined || spec.providerId.trim().length === 0 ? undefined : validateId(spec.providerId);
  const apiKey = normalizeOptionalApiKey(spec.apiKey);
  if (spec.kind === "OPENROUTER") return { kind: "OPENROUTER", ...(providerId === undefined ? {} : { providerId }), ...(apiKey === undefined ? {} : { apiKey }) };
  if (spec.kind === "NARAROUTER") return { kind: "NARAROUTER", ...(providerId === undefined ? {} : { providerId }), ...(apiKey === undefined ? {} : { apiKey }) };
  return {
    kind: "OPENAI_COMPATIBLE",
    baseUrl: normalizeBaseUrl(spec.baseUrl),
    ...(providerId === undefined ? {} : { providerId }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export function isProviderCatalogSpec(value: unknown): value is ProviderCatalogSpec {
  if (!isRecord(value)) return false;
  if (value.providerId !== undefined && typeof value.providerId !== "string") return false;
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") return false;
  const common = new Set(["kind", "providerId", "apiKey"]);
  if (value.kind === "OPENROUTER" || value.kind === "NARAROUTER") {
    if (!hasOnlyKeys(value, common)) return false;
  } else if (value.kind === "OPENAI_COMPATIBLE") {
    if (typeof value.baseUrl !== "string" || !hasOnlyKeys(value, new Set([...common, "baseUrl"]))) return false;
  } else {
    return false;
  }
  try {
    normalizeProviderCatalogSpec(value as unknown as ProviderCatalogSpec);
    return true;
  } catch {
    return false;
  }
}

export function providerCatalogOriginPattern(spec: ProviderCatalogSpec): string {
  const normalized = normalizeProviderCatalogSpec(spec);
  if (normalized.kind === "OPENROUTER") return `${new URL(OPENROUTER_BASE_URL).origin}/*`;
  if (normalized.kind === "NARAROUTER") return `${new URL(NARAROUTER_BASE_URL).origin}/*`;
  return `${new URL(normalized.baseUrl).origin}/*`;
}

export function resolveProviderCatalogProfile(spec: ProviderCatalogSpec, existing?: ProviderProfile): ProviderProfile {
  const normalized = normalizeProviderCatalogSpec(spec);
  const id = existing?.id ?? normalized.providerId ?? "catalog";
  const model = existing?.model ?? "catalog";
  if (normalized.kind === "OPENROUTER") {
    return resolveProviderProfileMutation({ kind: "OPENROUTER", id, model, ...(normalized.apiKey === undefined ? {} : { apiKey: normalized.apiKey }) }, existing);
  }
  if (normalized.kind === "NARAROUTER") {
    return resolveProviderProfileMutation({ kind: "NARAROUTER", id, model, ...(normalized.apiKey === undefined ? {} : { apiKey: normalized.apiKey }) }, existing);
  }
  return resolveProviderProfileMutation({
    kind: "OPENAI_COMPATIBLE",
    id,
    model,
    baseUrl: normalized.baseUrl,
    ...(normalized.apiKey === undefined ? {} : { apiKey: normalized.apiKey }),
  }, existing);
}

export function normalizeProviderSettings(state: ProviderSettingsState): ProviderSettingsState {
  if (state.version !== 1 || !Array.isArray(state.profiles) || !Array.isArray(state.order)) {
    invalid("Provider settings schema is invalid.");
  }
  const profiles = state.profiles.map(normalizeProviderProfile);
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) invalid(`Duplicate provider id: ${profile.id}`);
    ids.add(profile.id);
  }
  const order = state.order.map((id) => id.trim());
  if (new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
    invalid("Provider order contains duplicate or unknown ids.");
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
  const url = new URL(providerBaseUrl(profile));
  return `${url.origin}/*`;
}

export function redactProviderProfile(profile: ProviderProfile): RedactedProviderProfile {
  return {
    id: profile.id,
    kind: profile.kind,
    model: profile.model,
    endpoint: providerBaseUrl(profile),
  };
}
