import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { copyStaticFiles, staticFiles } from "./copy-static.mjs";

await copyStaticFiles();

const watchers = staticFiles.map(([source]) =>
  watch(new URL(`../${source}`, import.meta.url), () => {
    void copyStaticFiles();
  }),
);

const compilerProjects = ["tsconfig.build.json", "tsconfig.content.json"];
const compilers = compilerProjects.map((project) =>
  spawn("tsc", ["-p", project, "--watch", "--preserveWatchOutput"], {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
);

let remainingCompilers = compilers.length;
let exitCode = 0;
let shuttingDown = false;

function closeWatchers() {
  for (const watcher of watchers) watcher.close();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  closeWatchers();
  for (const compiler of compilers) compiler.kill(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

for (const compiler of compilers) {
  compiler.once("error", () => {
    exitCode = 1;
    shutdown("SIGTERM");
  });
  compiler.once("exit", (code) => {
    if (code !== null && code !== 0) exitCode = code;
    remainingCompilers -= 1;
    if (remainingCompilers === 0) {
      closeWatchers();
      process.exit(exitCode);
    }
  });
}
