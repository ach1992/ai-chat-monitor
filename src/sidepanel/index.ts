import {
  PROTOCOL_VERSION,
  type GuardianResponse,
  type PanelStatusRequest,
} from "../shared/protocol.js";

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Side panel markup is missing required element: ${selector}`);
  }

  return element;
}

const statusElement = requireElement<HTMLElement>("[data-status]");
const detailsElement = requireElement<HTMLElement>("[data-details]");
const refreshButton = requireElement<HTMLButtonElement>("[data-refresh]");

function render(message: string, details: string): void {
  statusElement.textContent = message;
  detailsElement.textContent = details;
}

async function refreshStatus(): Promise<void> {
  refreshButton.disabled = true;
  render("Checking current tab...", "No automatic chat action is enabled in the foundation build.");

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = activeTab?.id;

    if (tabId === undefined) {
      render("No active tab detected.", "Open a ChatGPT tab and refresh this panel.");
      return;
    }

    const request: PanelStatusRequest = {
      type: "panel:status-request",
      protocolVersion: PROTOCOL_VERSION,
      tabId,
    };
    const response = await chrome.runtime.sendMessage<GuardianResponse>(request);

    if (response.type === "background:error") {
      render("Status unavailable.", response.message);
      return;
    }

    if (response.type !== "background:status" || response.tabId !== tabId) {
      render("Status rejected.", "The response did not match the requested tab identity.");
      return;
    }

    if (!response.connected) {
      render(
        `Tab ${tabId}: not connected`,
        "The current tab does not have an active Chat Turn Guardian content agent.",
      );
      return;
    }

    const documentDetails =
      response.documentId === undefined
        ? "document identity unavailable"
        : `document ${response.documentId}`;
    render(`Tab ${tabId}: connected`, documentDetails);
  } catch {
    render("Status unavailable.", "The extension service worker could not answer the request.");
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  void refreshStatus();
});

void refreshStatus();
