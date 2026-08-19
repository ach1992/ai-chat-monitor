import { filterProviderModelCatalog, type ProviderModelFilter } from "../providers/catalog.js";
import {
  NARAROUTER_BASE_URL,
  OPENROUTER_BASE_URL,
  providerCatalogOriginPattern,
  type RedactedProviderProfile,
} from "../providers/settings.js";
import type {
  ProviderCatalogSpec,
  ProviderKind,
  ProviderModelCatalogEntry,
  ProviderProfileMutation,
} from "../providers/types.js";
import {
  PROTOCOL_VERSION,
  type GuardianResponse,
  type PanelOverviewRequest,
  type PanelOverviewResponse,
  type PanelProviderModelCatalogRequest,
  type PanelProviderOrderUpdate,
  type PanelProviderProfileRemove,
  type PanelProviderProfileUpsert,
  type RedactedProviderSettings,
} from "../shared/protocol.js";

function q<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Provider UI is missing required element: ${selector}`);
  return element;
}

function e<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const manager = q<HTMLElement>("[data-provider-manager-v2]");
const providerList = q<HTMLElement>("[data-provider-list-v2]", manager);
const form = q<HTMLFormElement>("[data-provider-form-v2]", manager);
const kindSelect = q<HTMLSelectElement>("[data-provider-kind-v2]", form);
const idInput = q<HTMLInputElement>("[data-provider-id-v2]", form);
const modelInput = q<HTMLInputElement>("[data-provider-model-v2]", form);
const modelList = q<HTMLDataListElement>("[data-provider-model-list-v2]", form);
const baseUrlField = q<HTMLElement>("[data-provider-base-url-field-v2]", form);
const baseUrlInput = q<HTMLInputElement>("[data-provider-base-url-v2]", form);
const fixedEndpoint = q<HTMLElement>("[data-provider-fixed-endpoint-v2]", form);
const apiKeyInput = q<HTMLInputElement>("[data-provider-api-key-v2]", form);
const primaryInput = q<HTMLInputElement>("[data-provider-primary-v2]", form);
const loadModelsButton = q<HTMLButtonElement>("[data-provider-load-models-v2]", form);
const filterField = q<HTMLElement>("[data-provider-filter-field-v2]", form);
const filterSelect = q<HTMLSelectElement>("[data-provider-filter-v2]", form);
const editorTitle = q<HTMLElement>("[data-provider-editor-title-v2]", manager);
const editorNote = q<HTMLElement>("[data-provider-editor-note-v2]", manager);
const statusElement = q<HTMLElement>("[data-provider-status-v2]", manager);
const cancelButton = q<HTMLButtonElement>("[data-provider-cancel-v2]", form);
const addButton = q<HTMLButtonElement>("[data-provider-add-v2]", manager);

let settings: RedactedProviderSettings = { profiles: [], order: [] };
let editingId: string | undefined;
let catalog: ProviderModelCatalogEntry[] = [];
let catalogFilter: ProviderModelFilter = "ALL";
let busy = false;

function status(message: string): void {
  statusElement.textContent = message;
}

function setEditorVisible(visible: boolean): void {
  form.hidden = !visible;
  addButton.setAttribute("aria-expanded", String(visible));
}

function providerKind(): ProviderKind {
  if (kindSelect.value === "OPENROUTER") return "OPENROUTER";
  if (kindSelect.value === "NARAROUTER") return "NARAROUTER";
  return "OPENAI_COMPATIBLE";
}

function providerLabel(kind: ProviderKind): string {
  if (kind === "OPENROUTER") return "OpenRouter";
  if (kind === "NARAROUTER") return "NaraRouter";
  return "Generic OpenAI-compatible";
}

function primaryId(): string | undefined {
  return settings.order[0];
}

function currentProfile(id: string): RedactedProviderProfile | undefined {
  return settings.profiles.find((profile) => profile.id === id);
}

function setBusy(next: boolean): void {
  busy = next;
  manager.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select").forEach((control) => {
    control.disabled = next;
  });
  if (!next && editingId !== undefined) idInput.readOnly = true;
}

async function loadOverview(): Promise<PanelOverviewResponse> {
  const request: PanelOverviewRequest = { type: "panel:overview-request", protocolVersion: PROTOCOL_VERSION };
  const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
  if (response.type === "background:error") throw new Error(response.message);
  if (response.type !== "background:overview") throw new Error("Guardian returned an unexpected provider overview response.");
  return response;
}

async function refreshProviders(): Promise<void> {
  const overview = await loadOverview();
  settings = overview.providers;
  renderProviderList();
}

function clearCatalog(message = "Model catalogs are optional; manual model entry remains available."): void {
  catalog = [];
  catalogFilter = "ALL";
  filterSelect.value = "ALL";
  modelList.replaceChildren();
  status(message);
}

function renderCatalog(): void {
  modelList.replaceChildren();
  const visible = filterProviderModelCatalog(catalog, catalogFilter);
  for (const model of visible) {
    const option = document.createElement("option");
    option.value = model.id;
    option.label = `${model.name}${model.pricingTier === "UNKNOWN" ? "" : ` - ${model.pricingTier}`}`;
    modelList.append(option);
  }
  status(`${visible.length} of ${catalog.length} catalog models shown. You can still type a model ID manually.`);
}

function updateKindFields(resetCatalog = true): void {
  const kind = providerKind();
  const generic = kind === "OPENAI_COMPATIBLE";
  baseUrlField.hidden = !generic;
  baseUrlInput.required = generic;
  fixedEndpoint.hidden = generic;
  if (kind === "OPENROUTER") fixedEndpoint.textContent = `Fixed endpoint: ${OPENROUTER_BASE_URL}`;
  else if (kind === "NARAROUTER") fixedEndpoint.textContent = `Fixed endpoint: ${NARAROUTER_BASE_URL}`;
  else fixedEndpoint.textContent = "";
  filterField.hidden = kind !== "OPENROUTER";
  loadModelsButton.textContent = kind === "OPENAI_COMPATIBLE" ? "Try loading models" : "Load models";
  if (resetCatalog) clearCatalog();
}

function resetEditor(visible = false): void {
  editingId = undefined;
  form.reset();
  kindSelect.value = "OPENROUTER";
  idInput.readOnly = false;
  apiKeyInput.required = true;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "Required for a new profile";
  editorTitle.textContent = "Add provider";
  editorNote.textContent = "Choose a preset, optionally load its live model catalog, or enter a model ID manually.";
  updateKindFields();
  setEditorVisible(visible);
  if (!visible) status("");
}

function beginEdit(profile: RedactedProviderProfile): void {
  editingId = profile.id;
  kindSelect.value = profile.kind;
  idInput.value = profile.id;
  idInput.readOnly = true;
  modelInput.value = profile.model;
  apiKeyInput.value = "";
  apiKeyInput.required = false;
  apiKeyInput.placeholder = "Leave blank to keep the stored key";
  primaryInput.checked = primaryId() === profile.id;
  if (profile.kind === "OPENAI_COMPATIBLE") baseUrlInput.value = profile.endpoint;
  else baseUrlInput.value = "";
  editorTitle.textContent = `Edit ${profile.id}`;
  editorNote.textContent = "Stored API keys are never displayed. Leave API key blank to retain it when provider type/origin is unchanged.";
  updateKindFields();
  modelInput.value = profile.model;
  setEditorVisible(true);
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderProviderList(): void {
  providerList.replaceChildren();
  if (settings.profiles.length === 0) {
    providerList.append(e("div", "empty-state", "No AI provider is configured. Ambiguous classifier cases fail closed to UNSURE."));
    return;
  }
  for (const providerId of settings.order) {
    const profile = currentProfile(providerId);
    if (profile === undefined) continue;
    const row = e("div", "provider-row");
    const copy = e("div", "provider-copy");
    const heading = e("strong", undefined, profile.id);
    const metadata = e("span", "meta", `${providerLabel(profile.kind)} - ${profile.model}`);
    const endpoint = e("span", "meta", profile.endpoint);
    copy.append(heading, metadata, endpoint);
    if (providerId === primaryId()) copy.append(e("span", "badge", "Primary"));

    const actions = e("div", "provider-actions");
    const edit = e("button", "secondary small", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => beginEdit(profile));
    actions.append(edit);

    const index = settings.order.indexOf(providerId);
    const up = e("button", "secondary small", "Up");
    up.type = "button";
    up.disabled = busy || index === 0;
    up.addEventListener("click", () => { void moveProvider(providerId, -1); });
    const down = e("button", "secondary small", "Down");
    down.type = "button";
    down.disabled = busy || index === settings.order.length - 1;
    down.addEventListener("click", () => { void moveProvider(providerId, 1); });
    const remove = e("button", "secondary small", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => { void removeProvider(providerId); });
    actions.append(up, down, remove);
    row.append(copy, actions);
    providerList.append(row);
  }
}

function catalogSpecFromForm(): ProviderCatalogSpec {
  const kind = providerKind();
  const providerId = editingId ?? (idInput.value.trim().length === 0 ? undefined : idInput.value.trim());
  const apiKey = apiKeyInput.value;
  if (kind === "OPENROUTER") return { kind, ...(providerId === undefined ? {} : { providerId }), apiKey };
  if (kind === "NARAROUTER") return { kind, ...(providerId === undefined ? {} : { providerId }), apiKey };
  return { kind, ...(providerId === undefined ? {} : { providerId }), apiKey, baseUrl: baseUrlInput.value.trim() };
}

function mutationFromForm(): ProviderProfileMutation {
  const kind = providerKind();
  const id = idInput.value.trim();
  const model = modelInput.value.trim();
  const apiKey = apiKeyInput.value;
  if (kind === "OPENROUTER") return { kind, id, model, apiKey };
  if (kind === "NARAROUTER") return { kind, id, model, apiKey };
  return { kind, id, model, apiKey, baseUrl: baseUrlInput.value.trim() };
}

function requestExactOrigin(spec: ProviderCatalogSpec): Promise<boolean> {
  const origin = providerCatalogOriginPattern(spec);
  return chrome.permissions.request({ origins: [origin] });
}

async function loadModels(): Promise<void> {
  if (busy) return;
  let spec: ProviderCatalogSpec;
  try {
    spec = catalogSpecFromForm();
  } catch (error) {
    status(error instanceof Error ? error.message : "Provider catalog configuration is invalid.");
    return;
  }
  setBusy(true);
  status("Requesting exact provider-origin access…");
  try {
    if (!await requestExactOrigin(spec)) {
      status("Provider-origin permission was not granted. Manual model entry is still available.");
      return;
    }
    status("Loading provider model catalog…");
    const request: PanelProviderModelCatalogRequest = {
      type: "panel:provider-model-catalog-request",
      protocolVersion: PROTOCOL_VERSION,
      spec,
    };
    const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
    if (response.type === "background:error") throw new Error(response.message);
    if (response.type !== "background:provider-model-catalog") throw new Error("Guardian returned an unexpected model catalog response.");
    catalog = response.models;
    catalogFilter = "ALL";
    filterSelect.value = "ALL";
    renderCatalog();
  } catch (error) {
    clearCatalog(providerKind() === "OPENAI_COMPATIBLE"
      ? `Catalog unavailable: ${error instanceof Error ? error.message : "request failed"}. Enter a model ID manually.`
      : `Catalog load failed: ${error instanceof Error ? error.message : "request failed"}.`);
  } finally {
    setBusy(false);
    renderProviderList();
  }
}

async function saveProvider(): Promise<void> {
  if (busy) return;
  let mutation: ProviderProfileMutation;
  let spec: ProviderCatalogSpec;
  try {
    mutation = mutationFromForm();
    spec = catalogSpecFromForm();
  } catch (error) {
    status(error instanceof Error ? error.message : "Provider configuration is invalid.");
    return;
  }
  setBusy(true);
  status("Requesting exact provider-origin access…");
  try {
    if (!await requestExactOrigin(spec)) {
      status("Provider-origin permission was not granted; the profile was not changed.");
      return;
    }
    const request: PanelProviderProfileUpsert = {
      type: "panel:provider-profile-upsert",
      protocolVersion: PROTOCOL_VERSION,
      profile: mutation,
      makePrimary: primaryInput.checked,
    };
    const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
    if (response.type === "background:error") throw new Error(response.message);
    if (response.type !== "background:provider-settings") throw new Error("Guardian returned an unexpected provider-settings response.");
    settings = response.providers;
    const savedId = mutation.id;
    const saved = currentProfile(savedId);
    resetEditor(false);
    status(saved === undefined ? "Provider saved." : `Saved ${saved.id} with model ${saved.model}. Stored API key remains hidden.`);
    renderProviderList();
  } catch (error) {
    status(error instanceof Error ? error.message : "Provider profile save failed.");
  } finally {
    setBusy(false);
    renderProviderList();
  }
}

async function removeProvider(providerId: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const request: PanelProviderProfileRemove = {
      type: "panel:provider-profile-remove",
      protocolVersion: PROTOCOL_VERSION,
      providerId,
    };
    const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
    if (response.type === "background:error") throw new Error(response.message);
    if (response.type !== "background:provider-settings") throw new Error("Guardian returned an unexpected provider-settings response.");
    settings = response.providers;
    if (editingId === providerId) resetEditor(false);
    status(`Removed ${providerId}. Unused provider-origin permission cleanup runs in the background.`);
  } catch (error) {
    status(error instanceof Error ? error.message : "Provider removal failed.");
  } finally {
    setBusy(false);
    renderProviderList();
  }
}

async function moveProvider(providerId: string, offset: -1 | 1): Promise<void> {
  if (busy) return;
  const currentIndex = settings.order.indexOf(providerId);
  const nextIndex = currentIndex + offset;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= settings.order.length) return;
  const currentProvider = settings.order[currentIndex];
  const nextProvider = settings.order[nextIndex];
  if (currentProvider === undefined || nextProvider === undefined) return;
  const order = [...settings.order];
  order[currentIndex] = nextProvider;
  order[nextIndex] = currentProvider;
  setBusy(true);
  try {
    const request: PanelProviderOrderUpdate = {
      type: "panel:provider-order-update",
      protocolVersion: PROTOCOL_VERSION,
      order,
    };
    const response = await chrome.runtime.sendMessage<GuardianResponse>(request);
    if (response.type === "background:error") throw new Error(response.message);
    if (response.type !== "background:provider-settings") throw new Error("Guardian returned an unexpected provider-order response.");
    settings = response.providers;
    status(`Updated provider priority. ${settings.order[0] ?? "No provider"} is primary.`);
  } catch (error) {
    status(error instanceof Error ? error.message : "Provider priority update failed.");
  } finally {
    setBusy(false);
    renderProviderList();
  }
}

kindSelect.addEventListener("change", () => updateKindFields());
baseUrlInput.addEventListener("input", () => clearCatalog("Base URL changed. Reload the catalog for this exact endpoint or enter a model manually."));
filterSelect.addEventListener("change", () => {
  const next = filterSelect.value;
  catalogFilter = next === "FREE" ? "FREE" : next === "PAID" ? "PAID" : "ALL";
  renderCatalog();
});
loadModelsButton.addEventListener("click", () => { void loadModels(); });
addButton.addEventListener("click", () => {
  resetEditor(true);
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
cancelButton.addEventListener("click", () => resetEditor(false));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveProvider();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !busy) void refreshProviders().catch(() => undefined);
});

resetEditor(false);
void refreshProviders().catch((error) => {
  status(error instanceof Error ? error.message : "Provider settings could not be loaded.");
});
