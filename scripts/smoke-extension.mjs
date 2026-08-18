import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = await realpath(resolve(repoRoot, "dist"));
const profilePath = await mkdtemp(resolve(tmpdir(), "chat-turn-guardian-chrome-"));

const browserCandidates = [
  process.env.CHROME_BIN,
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
].filter(Boolean);

function findOnPath(command) {
  if (command.includes("/")) {
    return command;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, command);
    try {
      if (process.getBuiltinModule("node:fs").existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Continue through PATH candidates.
    }
  }

  return undefined;
}

const browser = browserCandidates.map(findOnPath).find(Boolean);
if (browser === undefined) {
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run the unpacked-extension smoke test.");
}

const stderrChunks = [];
const browserArgs = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--disable-default-apps",
  "--enable-logging=stderr",
  "--v=1",
  "--remote-debugging-port=0",
  `--user-data-dir=${profilePath}`,
  `--load-extension=${extensionPath}`,
  "about:blank",
];

if (typeof process.getuid === "function" && process.getuid() === 0) {
  browserArgs.unshift("--no-sandbox");
}

const child = spawn(browser, browserArgs, { stdio: ["ignore", "ignore", "pipe"] });

child.stderr.on("data", (chunk) => {
  stderrChunks.push(Buffer.from(chunk));
});

async function waitForDevToolsPort() {
  const portFile = resolve(profilePath, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Browser exited before DevTools became ready (code ${child.exitCode}).`);
    }

    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split("\n");
      if (port !== undefined && /^\d+$/.test(port)) {
        return Number(port);
      }
    } catch {
      // Browser has not created the file yet.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  throw new Error("Browser did not expose DevTools within 15 seconds.");
}

async function closeBrowser(port) {
  try {
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
    const version = await versionResponse.json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);

    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("Timed out closing browser.")), 5_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) {
          clearTimeout(timeout);
          socket.close();
          resolvePromise();
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        rejectPromise(new Error("DevTools browser connection failed."));
      });
    });
  } catch {
    child.kill("SIGTERM");
  }
}

try {
  const port = await waitForDevToolsPort();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  await closeBrowser(port);

  await new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise();
      return;
    }
    child.once("exit", resolvePromise);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5_000).unref();
  });

  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const loadFailure = stderr.match(/Extension error:.*Failed to load extension[^\n]*/i)?.[0];
  if (loadFailure !== undefined) {
    throw new Error(loadFailure);
  }

  const preferences = JSON.parse(
    await readFile(resolve(profilePath, "Default", "Preferences"), "utf8"),
  );
  const settings = preferences.extensions?.settings ?? {};
  const loadedEntry = Object.entries(settings).find(([, entry]) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }

    const path = entry.path;
    const manifestName = entry.manifest?.name;
    return path === extensionPath || manifestName === "Chat Turn Guardian";
  });

  if (loadedEntry === undefined) {
    throw new Error("Chrome started, but the unpacked Chat Turn Guardian extension was not registered.");
  }

  const [extensionId] = loadedEntry;
  console.log(`Unpacked extension loaded successfully (${extensionId}).`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await rm(profilePath, { recursive: true, force: true });
}
