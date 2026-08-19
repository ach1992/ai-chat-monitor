import { isPageObservation, type PageObservation } from "./observation.js";
import type { ControlEligibility } from "../core/session-registry.js";
import type {
  AutomationPolicyDefaults,
  ChatAutomationPolicy,
  ChatAutomationPolicyPatch,
} from "../automation/policy.js";
import type {
  AutomationRuntimeStatus,
  NotificationTrigger,
  ResolvedAutomationPolicy,
} from "../automation/types.js";
import {
  isProviderProfile,
  type RedactedProviderProfile,
} from "../providers/settings.js";
import type { ProviderProfile } from "../providers/types.js";
import type { AuditEvent } from "../reliability/audit.js";

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

export interface PanelAutomationPolicyUpdate {
  type: "panel:automation-policy-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
  conversationId: string;
  patch: ChatAutomationPolicyPatch;
}

export interface PanelAutomationDefaultsUpdate {
  type: "panel:automation-defaults-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  patch: Partial<AutomationPolicyDefaults>;
}

export interface PanelEmergencyPauseUpdate {
  type: "panel:emergency-pause-update";
  protocolVersion: typeof PROTOCOL_VERSION;
  paused: boolean;
}

export interface PanelProviderProfileUpsert {
  type: "panel:provider-profile-upsert";
  protocolVersion: typeof PROTOCOL_VERSION;
  profile: ProviderProfile;
  makePrimary?: boolean;
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

export interface PanelAuditClear {
  type: "panel:audit-clear";
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
  automationPolicy?: ResolvedAutomationPolicy;
  automationRuntime?: AutomationRuntimeStatus;
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
  overrides?: ChatAutomationPolicy;
  policy?: ResolvedAutomationPolicy;
  runtime?: AutomationRuntimeStatus;
}

export interface RedactedProviderSettings {
  profiles: RedactedProviderProfile[];
  order: string[];
}

export interface PanelOverviewResponse {
  type: "background:overview";
  protocolVersion: typeof PROTOCOL_VERSION;
  policyRevision: number;
  emergencyPaused: boolean;
  defaults: AutomationPolicyDefaults;
  chats: ManagedChatStatus[];
  providers: RedactedProviderSettings;
  audit: AuditEvent[];
}

export interface AutomationPolicyResponse {
  type: "background:automation-policy";
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  emergencyPaused: boolean;
  tabId?: number;
  policy?: ResolvedAutomationPolicy;
  runtime?: AutomationRuntimeStatus;
}

export interface ProviderSettingsResponse {
  type: "background:provider-settings";
  protocolVersion: typeof PROTOCOL_VERSION;
  providers: RedactedProviderSettings;
}

export interface AuditClearResponse {
  type: "background:audit-cleared";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface ProtocolErrorResponse {
  type: "background:error";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: "INVALID_SENDER" | "INVALID_MESSAGE" | "STALE_EVENT" | "STORAGE_FAILURE";
  message: string;
}

export type GuardianRequest =
  | ContentHello
  | ContentNavigation
  | ContentObservation
  | ContentUserInteraction
  | PanelStatusRequest
  | PanelOverviewRequest
  | PanelAutomationPolicyUpdate
  | PanelAutomationDefaultsUpdate
  | PanelEmergencyPauseUpdate
  | PanelProviderProfileUpsert
  | PanelProviderProfileRemove
  | PanelProviderOrderUpdate
  | PanelAuditClear;

export type GuardianResponse =
  | ContentAgentAck
  | PanelStatusResponse
  | PanelOverviewResponse
  | AutomationPolicyResponse
  | ProviderSettingsResponse
  | AuditClearResponse
  | ProtocolErrorResponse;

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

function validMode(value: unknown): boolean {
  return value === "OFF" || value === "OBSERVE" || value === "AUTO" || value === "NOTIFY_ONLY";
}

function validDelayPatch(value: unknown, maximum: number): boolean {
  return value === undefined || value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum);
}

function validHardFuse(value: unknown, allowNull: boolean): boolean {
  return value === undefined || (allowNull && value === null) || (typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 500);
}

function validNotificationTriggers(value: unknown, allowNull: boolean): value is NotificationTrigger[] | null {
  if (value === null) return allowNull;
  if (!Array.isArray(value) || value.length > 5) return false;
  const allowed = new Set(["RESPONSE_FINISHED", "HOLD", "UNSURE", "ERROR", "STAGNATION"]);
  return value.every((entry) => typeof entry === "string" && allowed.has(entry)) && new Set(value).size === value.length;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isProviderOrder(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 32 &&
    value.every(isProviderId) &&
    new Set(value).size === value.length;
}

function isChatPolicyPatch(value: unknown): value is ChatAutomationPolicyPatch {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "mode",
    "settleDelayMs",
    "continueDelayMs",
    "cooldownMs",
    "continuationText",
    "notificationTriggers",
    "hardFuseMaxAutoContinues",
  ]);
  if (!hasOnlyKeys(value, allowed) || Object.keys(value).length === 0) return false;
  return (
    (value.mode === undefined || validMode(value.mode)) &&
    validDelayPatch(value.settleDelayMs, 60_000) &&
    validDelayPatch(value.continueDelayMs, 60_000) &&
    validDelayPatch(value.cooldownMs, 300_000) &&
    (value.continuationText === undefined || value.continuationText === null ||
      (typeof value.continuationText === "string" && value.continuationText.trim().length > 0 && value.continuationText.length <= 200)) &&
    (value.notificationTriggers === undefined || validNotificationTriggers(value.notificationTriggers, true)) &&
    validHardFuse(value.hardFuseMaxAutoContinues, true)
  );
}

function isDefaultsPatch(value: unknown): value is Partial<AutomationPolicyDefaults> {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "settleDelayMs",
    "continueDelayMs",
    "cooldownMs",
    "continuationText",
    "notificationTriggers",
    "hardFuseMaxAutoContinues",
  ]);
  if (!hasOnlyKeys(value, allowed) || Object.keys(value).length === 0) return false;
  return (
    (value.settleDelayMs === undefined || validDelayPatch(value.settleDelayMs, 60_000)) && value.settleDelayMs !== null &&
    (value.continueDelayMs === undefined || validDelayPatch(value.continueDelayMs, 60_000)) && value.continueDelayMs !== null &&
    (value.cooldownMs === undefined || validDelayPatch(value.cooldownMs, 300_000)) && value.cooldownMs !== null &&
    (value.continuationText === undefined ||
      (typeof value.continuationText === "string" && value.continuationText.trim().length > 0 && value.continuationText.length <= 200)) &&
    (value.notificationTriggers === undefined || validNotificationTriggers(value.notificationTriggers, false)) &&
    validHardFuse(value.hardFuseMaxAutoContinues, false)
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

export function isPanelAutomationPolicyUpdate(value: unknown): value is PanelAutomationPolicyUpdate {
  return (
    isRecord(value) &&
    hasProtocolVersion(value) &&
    value.type === "panel:automation-policy-update" &&
    isTabId(value.tabId) &&
    typeof value.conversationId === "string" &&
    /^[A-Za-z0-9_-]{4,200}$/.test(value.conversationId) &&
    isChatPolicyPatch(value.patch)
  );
}

export function isPanelAutomationDefaultsUpdate(value: unknown): value is PanelAutomationDefaultsUpdate {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:automation-defaults-update" && isDefaultsPatch(value.patch);
}

export function isPanelEmergencyPauseUpdate(value: unknown): value is PanelEmergencyPauseUpdate {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:emergency-pause-update" && typeof value.paused === "boolean";
}

export function isPanelProviderProfileUpsert(value: unknown): value is PanelProviderProfileUpsert {
  return (
    isRecord(value) &&
    hasProtocolVersion(value) &&
    value.type === "panel:provider-profile-upsert" &&
    isProviderProfile(value.profile) &&
    (value.makePrimary === undefined || typeof value.makePrimary === "boolean")
  );
}

export function isPanelProviderProfileRemove(value: unknown): value is PanelProviderProfileRemove {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-profile-remove" && isProviderId(value.providerId);
}

export function isPanelProviderOrderUpdate(value: unknown): value is PanelProviderOrderUpdate {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:provider-order-update" && isProviderOrder(value.order);
}

export function isPanelAuditClear(value: unknown): value is PanelAuditClear {
  return isRecord(value) && hasProtocolVersion(value) && value.type === "panel:audit-clear";
}
