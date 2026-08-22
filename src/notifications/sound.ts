import type { GuardianNotification, GuardianNotificationEvent, NotificationChannel } from "./types.js";

type SoundProfile = "SUBTLE" | "ATTENTION" | "ERROR";

let offscreenReady: Promise<void> | undefined;

function profileFor(event: GuardianNotificationEvent): SoundProfile {
  switch (event) {
    case "PLATFORM_ERROR":
    case "NETWORK_ERROR":
    case "RATE_LIMIT":
    case "AUTH_REQUIRED":
    case "VERIFICATION_REQUIRED":
    case "CONVERSATION_FULL":
    case "PROVIDER_ERROR":
    case "EXTENSION_ERROR":
      return "ERROR";
    case "APPROVAL_REQUIRED":
    case "DECISION_REQUIRED":
    case "HUMAN_OPERATION_REQUIRED":
    case "RETRY_AVAILABLE":
    case "GENERATION_STALLED":
      return "ATTENTION";
    default:
      return "SUBTLE";
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady !== undefined) return offscreenReady;
  offscreenReady = chrome.offscreen.createDocument({
    url: "offscreen/audio.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play user-enabled local Chat Turn Guardian notification sounds.",
  }).catch(() => undefined);
  await offscreenReady;
}

export async function playNotificationSound(notification: GuardianNotification): Promise<void> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage<{ ok?: boolean }>({
    type: "guardian:play-sound",
    profile: profileFor(notification.event),
  });
  if (response?.ok !== true) throw new Error("Notification sound playback failed.");
}

export class SoundNotificationChannel implements NotificationChannel {
  send(notification: GuardianNotification): Promise<void> {
    return playNotificationSound(notification);
  }
}
