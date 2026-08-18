import { NamespacedStorage } from "./namespaced-storage.js";

export async function restrictDurableStorageToTrustedContexts(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export function createDurableStorage<T>(namespace: string): NamespacedStorage<T> {
  return new NamespacedStorage<T>(namespace, chrome.storage.local);
}

export function createEphemeralStorage<T>(namespace: string): NamespacedStorage<T> {
  return new NamespacedStorage<T>(namespace, chrome.storage.session);
}
