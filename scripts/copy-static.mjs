import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const staticFiles = [
  ["src/manifest.json", "dist/manifest.json"],
  ["src/sidepanel/index.html", "dist/sidepanel/index.html"],
  ["src/sidepanel/styles.css", "dist/sidepanel/styles.css"],
  ["src/offscreen/audio.html", "dist/offscreen/audio.html"],
  ["src/assets/icon-16.png", "dist/assets/icon-16.png"],
  ["src/assets/icon-32.png", "dist/assets/icon-32.png"],
  ["src/assets/icon-48.png", "dist/assets/icon-48.png"],
  ["src/assets/icon-128.png", "dist/assets/icon-128.png"],
];

export async function copyStaticFiles() {
  for (const [source, destination] of staticFiles) {
    const sourcePath = resolve(repoRoot, source);
    const destinationPath = resolve(repoRoot, destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}
