declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab;
      documentId?: string;
    }

    interface MessageEvent {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    }

    const onMessage: MessageEvent;

    function sendMessage<TResponse = unknown>(message: unknown): Promise<TResponse>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
    }

    interface TabChangeInfo {
      status?: "loading" | "complete";
    }

    interface RemovedEvent {
      addListener(callback: (tabId: number) => void): void;
    }

    interface UpdatedEvent {
      addListener(
        callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void,
      ): void;
    }

    interface MessageSendOptions {
      documentId?: string;
      frameId?: number;
    }

    const onRemoved: RemovedEvent;
    const onUpdated: UpdatedEvent;

    function query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<Tab[]>;

    function sendMessage<TResponse = unknown>(
      tabId: number,
      message: unknown,
      options?: MessageSendOptions,
    ): Promise<TResponse>;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
      setAccessLevel(options: {
        accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS";
      }): Promise<void>;
    }

    const local: StorageArea;
    const session: StorageArea;
  }
}
