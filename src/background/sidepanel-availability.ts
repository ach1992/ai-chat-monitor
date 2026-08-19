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

async function syncSidePanelForTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const enabled = isSupportedChatGptUrl(tab.url);
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      ...(enabled ? { path: SIDE_PANEL_PATH } : {}),
      enabled,
    });
  } catch {
    // Availability is UX-only. Failure must never influence supervision state.
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(syncSidePanelForTab, () => undefined);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status === "complete") void syncSidePanelForTab(tab);
  if (changeInfo.status === "complete") void reannounceCompletedChatGptTab(tab);
});

void chrome.tabs.query({}).then((tabs) => Promise.allSettled(tabs.map(syncSidePanelForTab))).catch(() => undefined);
