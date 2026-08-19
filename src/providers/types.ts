import type { ClassificationRequest, ClassificationResult } from "../classification/types.js";

export type ProviderKind = "OPENROUTER" | "NARAROUTER" | "OPENAI_COMPATIBLE";

export interface ProviderTransportOptions {
  timeoutMs?: number;
  minConfidence?: number;
  headers?: Record<string, string>;
}

export interface OpenRouterProviderProfile extends ProviderTransportOptions {
  kind: "OPENROUTER";
  id: string;
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteTitle?: string;
}

export interface NaraRouterProviderProfile extends ProviderTransportOptions {
  kind: "NARAROUTER";
  id: string;
  apiKey: string;
  model: string;
}

export interface OpenAICompatibleProviderProfile extends ProviderTransportOptions {
  kind: "OPENAI_COMPATIBLE";
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ProviderProfile = OpenRouterProviderProfile | NaraRouterProviderProfile | OpenAICompatibleProviderProfile;

export interface OpenRouterProviderProfileMutation {
  kind: "OPENROUTER";
  id: string;
  apiKey?: string;
  model: string;
}

export interface NaraRouterProviderProfileMutation {
  kind: "NARAROUTER";
  id: string;
  apiKey?: string;
  model: string;
}

export interface OpenAICompatibleProviderProfileMutation {
  kind: "OPENAI_COMPATIBLE";
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export type ProviderProfileMutation =
  | OpenRouterProviderProfileMutation
  | NaraRouterProviderProfileMutation
  | OpenAICompatibleProviderProfileMutation;

export interface OpenRouterCatalogSpec {
  kind: "OPENROUTER";
  providerId?: string;
  apiKey?: string;
}

export interface NaraRouterCatalogSpec {
  kind: "NARAROUTER";
  providerId?: string;
  apiKey?: string;
}

export interface OpenAICompatibleCatalogSpec {
  kind: "OPENAI_COMPATIBLE";
  providerId?: string;
  baseUrl: string;
  apiKey?: string;
}

export type ProviderCatalogSpec = OpenRouterCatalogSpec | NaraRouterCatalogSpec | OpenAICompatibleCatalogSpec;

export type ProviderModelPricingTier = "FREE" | "PAID" | "UNKNOWN";

export interface ProviderModelCatalogEntry {
  id: string;
  name: string;
  pricingTier: ProviderModelPricingTier;
  contextLength?: number;
}

export interface ProviderSettingsState {
  version: 1;
  profiles: ProviderProfile[];
  order: string[];
}

export type ProviderHealthCode =
  | "OK"
  | "MISSING_CONFIG"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

export interface ProviderHealth {
  ok: boolean;
  code: ProviderHealthCode;
  message: string;
}

export interface AIProvider {
  readonly id: string;
  classify(request: ClassificationRequest): Promise<ClassificationResult>;
  testConnection(): Promise<ProviderHealth>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProviderFailureCode =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "INVALID_CONFIG";

export class ProviderFailure extends Error {
  override readonly name = "ProviderFailure";
  readonly code: ProviderFailureCode;

  constructor(code: ProviderFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}
