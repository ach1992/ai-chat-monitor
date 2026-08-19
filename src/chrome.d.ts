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
    const lastError: { message?: string } | undefined;

    function sendMessage<TResponse = unknown>(message: unknown): Promise<TResponse>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      active?: boolean;
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

    function update(
      tabId: number,
      updateProperties: { active?: boolean },
    ): Promise<Tab>;

    function sendMessage<TResponse = unknown>(
      tabId: number,
      message: unknown,
      options?: MessageSendOptions,
    ): Promise<TResponse>;
  }

  namespace permissions {
    interface Permissions {
      permissions?: string[];
      origins?: string[];
    }

    function request(permissions: Permissions): Promise<boolean>;
    function contains(permissions: Permissions): Promise<boolean>;
  }

  namespace notifications {
    interface NotificationOptions {
      type: "basic";
      iconUrl: string;
      title: string;
      message: string;
      priority?: number;
    }

    function create(
      notificationId: string,
      options: NotificationOptions,
      callback?: (notificationId: string) => void,
    ): void;
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
