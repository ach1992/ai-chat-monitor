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

async function syncTab(tab: chrome.tabs.Tab): Promise<void> {
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

async function syncActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab !== undefined) await syncTab(tab);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(syncTab, () => undefined);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status === "complete") void syncTab(tab);
});

void syncActiveTab();
