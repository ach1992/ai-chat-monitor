import { PROTOCOL_VERSION } from "../shared/protocol.js";

const SIDE_PANEL_PATH = "sidepanel/index.html";
const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function isSupportedChatGptUrl(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && CHATGPT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function repairLegacyDisabledTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  try {
    const options = await chrome.sidePanel.getOptions({ tabId });
    if (options.enabled === false) await chrome.sidePanel.setOptions({ tabId, enabled: true });
  } catch {
    // This is a one-time UX repair for tab-specific disabled overrides from older builds.
  }
}

async function reannounceCompletedChatGptTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined || !isSupportedChatGptUrl(tab.url)) return;
  try {
    await chrome.tabs.sendMessage<unknown>(tabId, {
      type: "panel:agent-reconnect",
      protocolVersion: PROTOCOL_VERSION,
    });
  } catch {
    // If document_idle has not injected the agent yet, its initial hello is sufficient.
  }
}

async function initializeSidePanelAvailability(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Toolbar opening is UX-only. The panel remains independently available below.
  }

  try {
    await chrome.sidePanel.setOptions({ path: SIDE_PANEL_PATH, enabled: true });
  } catch {
    // Per-tab repair below clears any stale disabled option when tabs are encountered.
  }

  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(repairLegacyDisabledTab));
  } catch {
    // Availability is UX-only. Later tab activation will retry the relevant tab.
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(repairLegacyDisabledTab, () => undefined);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") void reannounceCompletedChatGptTab(tab);
});

void initializeSidePanelAvailability();
