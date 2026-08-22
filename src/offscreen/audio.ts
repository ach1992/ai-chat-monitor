type SoundProfile = "SUBTLE" | "ATTENTION" | "ERROR";

interface PlaySoundMessage {
  type: "guardian:play-sound";
  profile: SoundProfile;
}

function isPlaySoundMessage(value: unknown): value is PlaySoundMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "guardian:play-sound" &&
    (record.profile === "SUBTLE" || record.profile === "ATTENTION" || record.profile === "ERROR");
}

function frequencies(profile: SoundProfile): number[] {
  switch (profile) {
    case "ERROR": return [440, 330];
    case "ATTENTION": return [660, 880];
    default: return [660];
  }
}

async function play(profile: SoundProfile): Promise<void> {
  const AudioContextCtor = window.AudioContext;
  const context = new AudioContextCtor();
  const gain = context.createGain();
  gain.gain.value = 0.055;
  gain.connect(context.destination);

  let cursor = context.currentTime;
  for (const frequency of frequencies(profile)) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(cursor);
    oscillator.stop(cursor + 0.12);
    cursor += 0.15;
  }

  await new Promise((resolve) => setTimeout(resolve, Math.ceil((cursor - context.currentTime + 0.05) * 1_000)));
  await context.close();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPlaySoundMessage(message)) return false;
  void play(message.profile).then(
    () => sendResponse({ ok: true }),
    () => sendResponse({ ok: false }),
  );
  return true;
});
