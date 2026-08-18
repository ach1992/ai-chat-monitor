import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { copyStaticFiles, staticFiles } from "./copy-static.mjs";

await copyStaticFiles();

const watchers = staticFiles.map(([source]) =>
  watch(new URL(`../${source}`, import.meta.url), () => {
    void copyStaticFiles();
  }),
);

const compiler = spawn("tsc", ["-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
  shell: process.platform === "win32",
});

function shutdown(signal) {
  for (const watcher of watchers) {
    watcher.close();
  }
  compiler.kill(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

compiler.once("exit", (code) => {
  for (const watcher of watchers) {
    watcher.close();
  }
  process.exit(code ?? 0);
});
