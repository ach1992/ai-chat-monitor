interface ContentHelloAck {
  type: "background:hello-ack";
  protocolVersion: 1;
  tabId: number;
  documentId?: string;
}

async function announceContentAgent(): Promise<void> {
  try {
    await chrome.runtime.sendMessage<ContentHelloAck>({
      type: "content:hello",
      protocolVersion: 1,
      sentAt: Date.now(),
    });
  } catch {
    // The service worker may be between wake cycles. A later page lifecycle event
    // or panel request will recover without granting any automation authority.
  }
}

void announceContentAgent();
