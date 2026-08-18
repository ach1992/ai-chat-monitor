import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { copyStaticFiles } from "./copy-static.mjs";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

const result = spawnSync("tsc", ["-p", "tsconfig.build.json"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error !== undefined) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await copyStaticFiles();
