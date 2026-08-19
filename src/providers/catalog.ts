import { DEFAULT_PROVIDER_TIMEOUT_MS, providerBaseUrl } from "./settings.js";
import {
  ProviderFailure,
  type FetchLike,
  type ProviderModelCatalogEntry,
  type ProviderModelPricingTier,
  type ProviderProfile,
} from "./types.js";

const MAX_CATALOG_CHARACTERS = 4_000_000;
const MAX_CATALOG_MODELS = 2_000;
const MAX_MODEL_ID_CHARACTERS = 200;
const MAX_MODEL_NAME_CHARACTERS = 300;

export type ProviderModelFilter = "ALL" | "FREE" | "PAID";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function requestHeaders(profile: ProviderProfile): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${profile.apiKey}`,
    ...(profile.headers ?? {}),
  };
  if (profile.kind === "OPENROUTER") {
    if (profile.siteUrl !== undefined) headers["HTTP-Referer"] = profile.siteUrl;
    if (profile.siteTitle !== undefined) headers["X-OpenRouter-Title"] = profile.siteTitle;
  }
  return headers;
}

function openRouterPricingTier(id: string, pricing: unknown): ProviderModelPricingTier {
  if (id.endsWith(":free")) return "FREE";
  if (!isRecord(pricing)) return "UNKNOWN";
  const numeric = Object.values(pricing)
    .map((value) => typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (numeric.some((value) => value > 0)) return "PAID";
  return numeric.length > 0 && numeric.every((value) => value === 0) ? "FREE" : "UNKNOWN";
}

function normalizeModelEntry(value: unknown, profile: ProviderProfile): ProviderModelCatalogEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const id = value.id.trim();
  if (id.length === 0 || id.length > MAX_MODEL_ID_CHARACTERS) return undefined;
  const rawName = typeof value.name === "string" ? value.name.trim() : "";
  const name = rawName.length === 0 || rawName.length > MAX_MODEL_NAME_CHARACTERS ? id : rawName;
  const contextLength = typeof value.context_length === "number" && Number.isInteger(value.context_length) && value.context_length > 0
    ? value.context_length
    : undefined;
  const pricingTier = profile.kind === "OPENROUTER" ? openRouterPricingTier(id, value.pricing) : "UNKNOWN";
  return {
    id,
    name,
    pricingTier,
    ...(contextLength === undefined ? {} : { contextLength }),
  };
}

export function normalizeProviderModelCatalog(payload: unknown, profile: ProviderProfile): ProviderModelCatalogEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ProviderFailure("INVALID_RESPONSE", "Provider model catalog did not contain a data array.");
  }
  if (payload.data.length > MAX_CATALOG_MODELS) {
    throw new ProviderFailure("INVALID_RESPONSE", "Provider model catalog exceeded the allowed model count.");
  }
  const models: ProviderModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of payload.data) {
    const model = normalizeModelEntry(candidate, profile);
    if (model === undefined || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function filterProviderModelCatalog(
  models: readonly ProviderModelCatalogEntry[],
  filter: ProviderModelFilter,
): ProviderModelCatalogEntry[] {
  if (filter === "ALL") return [...models];
  return models.filter((model) => model.pricingTier === filter);
}

export async function fetchProviderModelCatalog(
  profile: ProviderProfile,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderModelCatalogEntry[]> {
  const timeoutMs = profile.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(joinEndpoint(providerBaseUrl(profile), "models"), {
      method: "GET",
      headers: requestHeaders(profile),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 429) throw new ProviderFailure("RATE_LIMITED", "Provider model catalog rate limit was reached.");
    if (!response.ok) throw new ProviderFailure("HTTP_ERROR", `Provider model catalog request failed with HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_CHARACTERS) {
      throw new ProviderFailure("INVALID_RESPONSE", "Provider model catalog response exceeded the allowed size.");
    }
    const raw = await response.text();
    if (raw.length > MAX_CATALOG_CHARACTERS) {
      throw new ProviderFailure("INVALID_RESPONSE", "Provider model catalog response exceeded the allowed size.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ProviderFailure("INVALID_RESPONSE", "Provider model catalog returned invalid JSON.");
    }
    return normalizeProviderModelCatalog(payload, profile);
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    if (controller.signal.aborted) throw new ProviderFailure("TIMEOUT", "Provider model catalog request timed out.");
    throw new ProviderFailure("NETWORK_ERROR", "Provider model catalog network request failed.");
  } finally {
    clearTimeout(timeout);
  }
}
