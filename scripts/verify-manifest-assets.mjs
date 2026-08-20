import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

function valuesFromIconDeclaration(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).filter((path) => typeof path === "string");
}

export async function verifyManifestAssets(extensionRoot) {
  const manifestPath = resolve(extensionRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const paths = new Set([
    ...valuesFromIconDeclaration(manifest.icons),
    ...valuesFromIconDeclaration(manifest.action?.default_icon),
  ]);

  for (const path of paths) {
    if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
      throw new Error(`Manifest asset path is invalid: ${path}`);
    }
    const absolute = resolve(extensionRoot, path);
    const relativePath = relative(extensionRoot, absolute);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      throw new Error(`Manifest asset escapes extension root: ${path}`);
    }
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isFile() !== true) {
      throw new Error(`Manifest references a missing asset: ${path}`);
    }
  }

  return { manifest, assetPaths: [...paths].sort() };
}
