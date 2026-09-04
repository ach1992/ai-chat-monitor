import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { verifyManifestAssets } from "./verify-manifest-assets.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = await realpath(resolve(repoRoot, "dist"));
await verifyManifestAssets(extensionPath);
const profilePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-chrome-"));

function findOnPath(command) {
  if (command.includes("/")) {
    return existsSync(command) ? command : undefined;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

const browser = [
  process.env.CHROME_BIN,
  "google-chrome-for-testing",
  "chromium",
  "chromium-browser",
]
  .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
  .map(findOnPath)
  .find((candidate) => candidate !== undefined);

if (browser === undefined) {
  throw new Error(
    "Chrome/Chromium was not found. Set CHROME_BIN to run the unpacked-extension smoke test.",
  );
}

const browserArgs = [
  "--disable-gpu",
  "--no-first-run",
  "--disable-default-apps",
  "--enable-logging=stderr",
  "--v=1",
  `--user-data-dir=${profilePath}`,
  "--remote-debugging-port=0",
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  "about:blank",
];

if ((typeof process.getuid === "function" && process.getuid() === 0) || process.env.CI === "true") {
  browserArgs.unshift("--no-sandbox");
}

const xvfbRun = findOnPath("xvfb-run");
const command = xvfbRun ?? browser;
const commandArgs =
  xvfbRun === undefined
    ? ["--headless=new", ...browserArgs]
    : ["-a", browser, ...browserArgs];
const detached = process.platform !== "win32";
const stderrChunks = [];
const child = spawn(command, commandArgs, {
  detached,
  stdio: ["ignore", "ignore", "pipe"],
});

child.stderr.on("data", (chunk) => {
  stderrChunks.push(Buffer.from(chunk));
});

function stderrText() {
  return Buffer.concat(stderrChunks).toString("utf8");
}

function stderrTail() {
  return stderrText().split("\n").slice(-30).join("\n");
}

function terminateProcessGroup(signal) {
  if (child.pid === undefined) {
    return;
  }

  try {
    if (detached) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The browser process tree has already exited.
  }
}

async function devToolsPort() {
  const portFile = resolve(profilePath, "DevToolsActivePort");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Browser exited during unpacked-extension smoke test (code ${child.exitCode}).\n${stderrTail()}`);
    }
    try {
      const [rawPort] = (await readFile(portFile, "utf8")).trim().split("\n");
      const port = Number(rawPort);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* browser has not exposed DevTools yet */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Browser did not expose DevTools during unpacked-extension smoke test.\n${stderrTail()}`);
}

async function verifyUnpackedLoad() {
  const port = await devToolsPort();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const loadFailure = stderrText().match(/Extension error:.*Failed to load extension[^\n]*/i)?.[0];
    if (loadFailure !== undefined) throw new Error(loadFailure);
    if (child.exitCode !== null) {
      throw new Error(`Browser exited during unpacked-extension smoke test (code ${child.exitCode}).\n${stderrTail()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const worker = Array.isArray(targets)
          ? targets.find((target) => target?.type === "service_worker" && /chrome-extension:\/\/[^/]+\/background\/worker\.js$/.test(target?.url ?? ""))
          : undefined;
        if (worker !== undefined) return worker.url;
      }
    } catch { /* DevTools target list is still starting */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    "The unpacked AI Chat Monitor service worker never loaded. " +
    "Use Chromium or Chrome for Testing; current branded Google Chrome builds ignore --load-extension.",
  );
}

try {
  const workerUrl = await verifyUnpackedLoad();
  console.log(`Verified unpacked AI Chat Monitor service worker: ${workerUrl}`);
} finally {
  terminateProcessGroup("SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  terminateProcessGroup("SIGKILL");
  await rm(profilePath, { recursive: true, force: true });
}
