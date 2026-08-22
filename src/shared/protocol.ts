import { isPageObservation, type PageObservation } from "./observation.js";
import type { ControlEligibility } from "../core/session-registry.js";
import { MONITORING_EVENTS } from "../monitoring/policy.js";
import type {
  ChatMonitoringPolicy,
  ChatMonitoringPolicyPatch,
  MonitoringEvent,
  MonitoringEventType,
  MonitoringPolicyDefaults,
  MonitoringRuntimeStatus,
  ResolvedMonitoringPolicy,
} from "../monitoring/types.js";
import {
  isProviderCatalogSpec,
  isProviderProfileMutation,
  type RedactedProviderProfile,
} from "../providers/settings.js";
import type {
  ProviderCatalogSpec,
  ProviderClassifierReadinessResult,
  ProviderModelCatalogEntry,
  ProviderProfileMutation,
} from "../providers/types.js";

export const PROTOCOL_VERSION = 2 as const;

export type UserInteractionKind =
  | "COMPOSER_INPUT"
  | "COMPOSER_FOCUS"
  | "MANUAL_SEND"
  | "STOP_GENERATION"
  | "EDIT_TURN"
  | "BLOCKING_INTERACTION";

interface ContentSessionBase {
  protocolVersion: typeof PROTOCOL_VERSION;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  sentAt: number;
}

export interface ContentHello extends ContentSessionBase {
  type: "content:hello";
  routeKey: string;
  conversationId?: string;
}

export interface ContentNavigation extends ContentSessionBase {
  type: "content:navigation";
  routeKey: string;
  conversationId?: string;
}

export interface ContentObservation extends ContentSessionBase {
  type: "content:observation";
  observation: PageObservation;
}

export interface ContentUserInteraction extends ContentSessionBase {
  type: "content:user-interaction";
  interaction: UserInteractionKind;
}

export interface PanelStatusRequest {
  type: "panel:status-request";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
}

export interface PanelOverviewRequest {
  type: "panel:overview-request";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface PanelMonitoringPolicyUpdate {
  type: "panel:monitoring-policy-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
  conversationId: string;
  patch: ChatMonitoringPolicyPatch;
}

export interface PanelMonitoringDefaultsUpdate {
  type: "panel:monitoring-defaults-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  patch: Partial<MonitoringPolicyDefaults>;
}

export interface PanelProviderProfileUpsert {
  type: "panel:provider-profile-upsert";
  protocolVersion: typeof PROTOCOL_VERSION;
  profile: ProviderProfileMutation;
  makePrimary?: boolean;
}

export interface PanelProviderModelCatalogRequest {
  type: "panel:provider-model-catalog-request";
  protocolVersion: typeof PROTOCOL_VERSION;
  spec: ProviderCatalogSpec;
}

export interface PanelProviderClassifierReadinessRequest {
  type: "panel:provider-classifier-readiness-request";
  protocolVersion: typeof PROTOCOL_VERSION;
  providerId: string;
}

export interface PanelProviderProfileRemove {
  type: "panel:provider-profile-remove";
  protocolVersion: typeof PROTOCOL_VERSION;
  providerId: string;
}

export interface PanelProviderOrderUpdate {
  type: "panel:provider-order-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  order: string[];
}

export interface PanelHistoryClear {
  type: "panel:history-clear";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface ContentAgentAck {
  type: "background:agent-ack";
  protocolVersion: typeof PROTOCOL_VERSION;
  accepted: boolean;
  tabId: number;
  documentId: string;
  controlEligibility?: ControlEligibility;
}

export interface PanelStatusResponse {
  type: "background:status";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
  connected: boolean;
  documentId?: string;
  conversationId?: string;
  controlEligibility?: ControlEligibility;
  monitoringPolicy?: ResolvedMonitoringPolicy;
  monitoringRuntime?: MonitoringRuntimeStatus;
  lastSeenAt?: number;
}

export interface ManagedChatStatus {
  tabId: number;
  conversationId?: string;
  routeKey: string;
  pageTitle?: string;
  controlEligibility: ControlEligibility;
  lastSeenAt: number;
  generation?: PageObservation["generation"];
  overrides?: ChatMonitoringPolicy;
  policy?: ResolvedMonitoringPolicy;
  runtime?: MonitoringRuntimeStatus;
}

export interface RedactedProviderSettings {
  profiles: RedactedProviderProfile[];
  order: string[];
}

export interface PanelOverviewResponse {
  type: "background:overview";
  protocolVersion: typeof PROTOCOL_VERSION;
  policyRevision: number;
  defaults: MonitoringPolicyDefaults;
  chats: ManagedChatStatus[];
  providers: RedactedProviderSettings;
  events: MonitoringEvent[];
}

export interface MonitoringPolicyResponse {
  type: "background:monitoring-policy";
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  tabId?: number;
  policy?: ResolvedMonitoringPolicy;
  runtime?: MonitoringRuntimeStatus;
}

export interface ProviderSettingsResponse {
  type: "background:provider-settings";
  protocolVersion: typeof PROTOCOL_VERSION;
  providers: RedactedProviderSettings;
}

export interface ProviderModelCatalogResponse {
  type: "background:provider-model-catalog";
  protocolVersion: typeof PROTOCOL_VERSION;
  models: ProviderModelCatalogEntry[];
}

export interface ProviderClassifierReadinessResponse {
  type: "background:provider-classifier-readiness";
  protocolVersion: typeof PROTOCOL_VERSION;
  result: ProviderClassifierReadinessResult;
}

export interface HistoryClearResponse {
  type: "background:history-cleared";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface ProtocolErrorResponse {
  type: "background:error";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: "INVALID_SENDER" | "INVALID_MESSAGE" | "STALE_EVENT" | "STORAGE_FAILURE" | "PROVIDER_FAILURE";
  message: string;
}

export type GuardianRequest =
  | ContentHello
  | ContentNavigation
  | ContentObservation
  | ContentUserInteraction
  | PanelStatusRequest
  | PanelOverviewRequest
  | PanelMonitoringPolicyUpdate
  | PanelMonitoringDefaultsUpdate
  | PanelProviderProfileUpsert
  | PanelProviderModelCatalogRequest
  | PanelProviderClassifierReadinessRequest
  | PanelProviderProfileRemove
  | PanelProviderOrderUpdate
  | PanelHistoryClear;

export type GuardianResponse =
  | ContentAgentAck
  | PanelStatusResponse
  | PanelOverviewResponse
  | MonitoringPolicyResponse
  | ProviderSettingsResponse
  | ProviderModelCatalogResponse
  | ProviderClassifierReadinessResponse
  | HistoryClearResponse
  | ProtocolErrorResponse;

const EVENT_SET = new Set<MonitoringEventType>(MONITORING_EVENTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasProtocolVersion(value: Record<string, unknown>): boolean {
  return value.protocolVersion === PROTOCOL_VERSION;
}

function isSessionBase(value: Record<string, unknown>): boolean {
  return (
    hasProtocolVersion(value) &&
    typeof value.agentInstanceId === "string" && value.agentInstanceId.length > 0 && value.agentInstanceId.length <= 128 &&
    typeof value.pageEpoch === "number" && Number.isInteger(value.pageEpoch) && value.pageEpoch >= 1 &&
    typeof value.sequence === "number" && Number.isInteger(value.sequence) && value.sequence >= 1 &&
    typeof value.sentAt === "number" && Number.isFinite(value.sentAt)
  );
}

function hasRouteIdentity(value: Record<string, unknown>): boolean {
  return typeof value.routeKey === "string" && value.routeKey.length > 0 && value.routeKey.length <= 512 &&
    (value.conversationId === undefined ||
      (typeof value.conversationId === "string" && /^[A-Za-z0-9_-]{4,200}$/.test(value.conversationId)));
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isProviderOrder(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(isProviderId) && new Set(value).size === value.length;
}

function isEventList(value: unknown, allowNull: boolean): value is MonitoringEventType[] | null {
  if (value === null) return allowNull;
  return Array.isArray(value) &&
    value.length <= EVENT_SET.size &&
    value.every((entry) => typeof entry === "string" && EVENT_SET.has(entry as MonitoringEventType)) &&
    new Set(value).size === value.length;
}

function validStallThreshold(value: unknown, allowNull: boolean): boolean {
  return value === undefined ||
    (allowNull && value === null) ||
    (typeof value === "number" && Number.isInteger(value) && value >= 30_000 && value <= 3_600_000);
}

function isChatMonitoringPatch(value: unknown): value is ChatMonitoringPolicyPatch {
  if (!isRecord(value)) return false;
  const allowed = new Set(["enabled", "browserEvents", "soundEvents", "stallThresholdMs", "suppressLowPriorityWhileFocused"]);
  if (!hasOnlyKeys(value, allowed) || Object.keys(value).length === 0) return false;
  return (
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.browserEvents === undefined || isEventList(value.browserEvents, true)) &&
    (value.soundEvents === undefined || isEventList(value.soundEvents, true)) &&
    validStallThreshold(value.stallThresholdMs, true) &&
    (value.suppressLowPriorityWhileFocused === undefined || value.suppressLowPriorityWhileFocused === null ||
      typeof value.suppressLowPriorityWhileFocused === "boolean")
  );
}

function isDefaultsPatch(value: unknown): value is Partial<MonitoringPolicyDefaults> {
  if (!isRecord(value)) return false;
  const allowed = new Set(["browserEvents", "soundEvents", "stallThresholdMs", "suppressLowPriorityWhileFocused"]);
  if (!hasOnlyKeys(value, allowed) || Object.keys(value).length === 0) return false;
  return (
    (value.browserEvents === undefined || isEventList(value.browserEvents, false)) &&
    (value.soundEvents === undefined || isEventList(value.soundEvents, false)) &&
    validStallThreshold(value.stallThresholdMs, false) && value.stallThresholdMs !== null &&
    (value.suppressLowPriorityWhileFocused === undefined || typeof value.suppressLowPriorityWhileFocused === "boolean")
  );
}

export function isContentHello(value: unknown): value is ContentHello {
  return isRecord(value) && value.type === "content:hello" && isSessionBase(value) && hasRouteIdentity(value);
}

export function isContentNavigation(value: unknown): value is ContentNavigation {
  return isRecord(value) && value.type === "content:navigation" && isSessionBase(value) && hasRouteIdentity(value);
}

export function isContentObservation(value: unknown): value is ContentObservation {
  return isRecord(value) && value.type === "content:observation" && isSessionBase(value) && isPageObservation(value.observation);
}

export function isContentUserInteraction(value: unknown): value is ContentUserInteraction {
  return (
    isRecord(value) && value.type === "content:user-interaction" && isSessionBase(value) &&
    (value.interaction === "COMPOSER_INPUT" ||
      value.interaction === "COMPOSER_FOCUS" ||
      value.interaction === "MANUAL_SEND" ||
      value.interaction === "STOP_GENERATION" ||
      value.interaction === "EDIT_TURN" ||
      value.interaction === "BLOCKING_INTERACTION")
  );
}

export function isPanelStatusRequest(value: unknown): value is PanelStatusRequest {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:status-request" && isTabId(value.tabId);
}

export function isPanelOverviewRequest(value: unknown): value is PanelOverviewRequest {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:overview-request";
}

export function isPanelMonitoringPolicyUpdate(value: unknown): value is PanelMonitoringPolicyUpdate {
  return (
    isRecord(value) && hasProtocolVersion(value) && value.type === "panel:monitoring-policy-update" &&
    isTabId(value.tabId) && typeof value.conversationId === "string" &&
    /^[A-Za-z0-9_-]{4,200}$/.test(value.conversationId) && isChatMonitoringPatch(value.patch)
  );
}

export function isPanelMonitoringDefaultsUpdate(value: unknown): value is PanelMonitoringDefaultsUpdate {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:monitoring-defaults-update" && isDefaultsPatch(value.patch);
}

export function isPanelProviderProfileUpsert(value: unknown): value is PanelProviderProfileUpsert {
  return (
    isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-profile-upsert" &&
    isProviderProfileMutation(value.profile) && (value.makePrimary === undefined || typeof value.makePrimary === "boolean")
  );
}

export function isPanelProviderModelCatalogRequest(value: unknown): value is PanelProviderModelCatalogRequest {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-model-catalog-request" && isProviderCatalogSpec(value.spec);
}

export function isPanelProviderClassifierReadinessRequest(value: unknown): value is PanelProviderClassifierReadinessRequest {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-classifier-readiness-request" && isProviderId(value.providerId);
}

export function isPanelProviderProfileRemove(value: unknown): value is PanelProviderProfileRemove {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-profile-remove" && isProviderId(value.providerId);
}

export function isPanelProviderOrderUpdate(value: unknown): value is PanelProviderOrderUpdate {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-order-update" && isProviderOrder(value.order);
}

export function isPanelHistoryClear(value: unknown): value is PanelHistoryClear {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:history-clear";
}
