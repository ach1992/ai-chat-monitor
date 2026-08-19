import type { ChatAutomationPolicyPatch } from "../automation/policy.js";
import type { AuditEvent } from "../reliability/audit.js";
import {
  PROTOCOL_VERSION,
  type GuardianResponse,
  type ManagedChatStatus,
  type PanelAuditClear,
  type PanelAutomationDefaultsUpdate,
  type PanelAutomationPolicyUpdate,
  type PanelOverviewRequest,
  type PanelOverviewResponse,
} from "../shared/protocol.js";

function q<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Reliability panel is missing required element: ${selector}`);
  return element;
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const refreshButton = q<HTMLButtonElement>("[data-reliability-refresh]");
const statusElement = q<HTMLElement>("[data-reliability-status]");
const defaultForm = q<HTMLFormElement>("[data-fuse-default-form]");
const chatList = q<HTMLElement>("[data-fuse-chat-list]");
const auditList = q<HTMLElement>("[data-audit-list]");
const clearAuditButton = q<HTMLButtonElement>("[data-audit-clear]");
let overview: PanelOverviewResponse | undefined;
let refreshing = false;

function status(message: string): void {
  statusElement.textContent = message;
}

async function send(request: object): Promise<GuardianResponse> {
  return chrome.runtime.sendMessage<GuardianResponse>(request);
}

function requireSuccess(response: GuardianResponse): GuardianResponse {
  if (response.type === "background:error") throw new Error(response.message);
  return response;
}

function namedInput(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement)) throw new Error(`Missing input ${name}.`);
  return control;
}

function parseFuse(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 500) {
    throw new Error("Hard fuse must be an integer between 5 and 500.");
  }
  return parsed;
}

function chatTitle(chat: ManagedChatStatus): string {
  const title = chat.pageTitle?.trim();
  if (title !== undefined && title.length > 0) return title;
  return chat.conversationId === undefined ? `Tab ${chat.tabId}` : `Conversation ${chat.conversationId.slice(0, 12)}`;
}

function renderFuseDefaults(): void {
  const defaults = overview?.defaults;
  if (defaults === undefined) return;
  namedInput(defaultForm, "hardFuseMaxAutoContinues").value = String(defaults.hardFuseMaxAutoContinues);
}

function renderFuseChats(): void {
  chatList.replaceChildren();
  const chats = (overview?.chats ?? []).filter(
    (chat): chat is ManagedChatStatus & { conversationId: string; policy: NonNullable<ManagedChatStatus["policy"]> } =>
      chat.conversationId !== undefined && chat.policy !== undefined,
  );
  if (chats.length === 0) {
    chatList.append(e("div", "empty-state", "No connected ChatGPT conversations are available for per-chat fuse overrides."));
    return;
  }

  for (const chat of chats) {
    const row = e("div", "reliability-row");
    const copy = e("div", "provider-copy");
    copy.append(
      e("strong", undefined, chatTitle(chat)),
      e("span", "meta", `Effective fuse: ${chat.policy.hardFuseMaxAutoContinues} verified auto-continues`),
    );
    const controls = e("div", "reliability-controls");
    const input = e("input");
    input.type = "number";
    input.min = "5";
    input.max = "500";
    input.step = "1";
    input.placeholder = `Inherit ${overview?.defaults.hardFuseMaxAutoContinues ?? 50}`;
    input.value = chat.overrides?.hardFuseMaxAutoContinues === undefined ? "" : String(chat.overrides.hardFuseMaxAutoContinues);
    input.setAttribute("aria-label", `Hard fuse override for ${chatTitle(chat)}`);
    const save = e("button", "secondary small", "Save");
    save.type = "button";
    save.addEventListener("click", () => {
      try {
        const trimmed = input.value.trim();
        const patch: ChatAutomationPolicyPatch = {
          hardFuseMaxAutoContinues: trimmed.length === 0 ? null : parseFuse(trimmed),
        };
        const request: PanelAutomationPolicyUpdate = {
          type: "panel:automation-policy-update",
          protocolVersion: PROTOCOL_VERSION,
          tabId: chat.tabId,
          conversationId: chat.conversationId,
          patch,
        };
        void mutate(request, `Saving hard fuse for ${chatTitle(chat)}…`);
      } catch (error) {
        status(error instanceof Error ? error.message : "Invalid hard fuse override.");
      }
    });
    controls.append(input, save);
    row.append(copy, controls);
    chatList.append(row);
  }
}

function auditSummary(event: AuditEvent): string {
  const decision = event.decision === undefined ? "" : ` · ${event.decision}`;
  const reasonCode = event.reasonCode === undefined ? "" : ` · ${event.reasonCode}`;
  return `${event.kind}${decision}${reasonCode}`;
}

function renderAudit(): void {
  auditList.replaceChildren();
  const events = [...(overview?.audit ?? [])].reverse();
  if (events.length === 0) {
    auditList.append(e("div", "empty-state", "No audit events yet."));
    return;
  }
  for (const event of events) {
    const row = e("div", "audit-row");
    const head = e("div", "audit-row-head");
    head.append(
      e("strong", undefined, auditSummary(event)),
      e("span", "meta", new Date(event.at).toLocaleString()),
    );
    const meta = e("div", "meta", [
      `Tab ${event.tabId}`,
      event.mode,
      event.phase,
      event.providerId === undefined ? undefined : `provider ${event.providerId}`,
    ].filter((value): value is string => value !== undefined).join(" · "));
    row.append(head, meta);
    if (event.reason !== undefined) row.append(e("div", "reason", event.reason));
    auditList.append(row);
  }
}

function render(): void {
  renderFuseDefaults();
  renderFuseChats();
  renderAudit();
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  refreshButton.disabled = true;
  try {
    const request: PanelOverviewRequest = { type: "panel:overview-request", protocolVersion: PROTOCOL_VERSION };
    const response = requireSuccess(await send(request));
    if (response.type !== "background:overview") throw new Error("Unexpected reliability overview response.");
    overview = response;
    render();
    status(`${response.audit.length} recent audit event${response.audit.length === 1 ? "" : "s"}.`);
  } catch (error) {
    status(error instanceof Error ? error.message : "Unable to load reliability state.");
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

async function mutate(request: object, message: string): Promise<void> {
  status(message);
  try {
    requireSuccess(await send(request));
    await refresh();
  } catch (error) {
    status(error instanceof Error ? error.message : "Reliability update failed.");
  }
}

refreshButton.addEventListener("click", () => void refresh());

defaultForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const hardFuseMaxAutoContinues = parseFuse(namedInput(defaultForm, "hardFuseMaxAutoContinues").value);
    const request: PanelAutomationDefaultsUpdate = {
      type: "panel:automation-defaults-update",
      protocolVersion: PROTOCOL_VERSION,
      patch: { hardFuseMaxAutoContinues },
    };
    void mutate(request, "Saving global hard fuse…");
  } catch (error) {
    status(error instanceof Error ? error.message : "Invalid global hard fuse.");
  }
});

clearAuditButton.addEventListener("click", () => {
  if (!window.confirm("Clear the bounded Chat Turn Guardian audit history?")) return;
  const request: PanelAuditClear = { type: "panel:audit-clear", protocolVersion: PROTOCOL_VERSION };
  void mutate(request, "Clearing audit history…");
});

void refresh();
