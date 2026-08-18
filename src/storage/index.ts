import { NamespacedStorage } from "./namespaced-storage.js";

export function createDurableStorage<T>(namespace: string): NamespacedStorage<T> {
  return new NamespacedStorage<T>(namespace, chrome.storage.local);
}

export function createEphemeralStorage<T>(namespace: string): NamespacedStorage<T> {
  return new NamespacedStorage<T>(namespace, chrome.storage.session);
}
