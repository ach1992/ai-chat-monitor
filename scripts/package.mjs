import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyManifestAssets } from "./verify-manifest-assets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(repoRoot, "dist");
const artifactsRoot = resolve(repoRoot, "artifacts");
const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const archiveName = `chat-turn-guardian-${packageJson.version}.zip`;
const archivePath = resolve(artifactsRoot, archiveName);

const build = spawnSync(process.execPath, [resolve(repoRoot, "scripts/build.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const { manifest } = await verifyManifestAssets(distRoot);
if (manifest.version !== packageJson.version) {
  throw new Error(`Release version mismatch: manifest ${manifest.version ?? "missing"} != package ${packageJson.version}.`);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile() && !entry.name.endsWith(".map")) files.push(absolute);
  }
  return files.sort();
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

function localHeader(name, data, crc) {
  const nameBuffer = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer]);
}

function centralHeader(name, data, crc, offset) {
  const nameBuffer = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function endOfCentralDirectory(entries, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

await rm(artifactsRoot, { recursive: true, force: true });
await mkdir(artifactsRoot, { recursive: true });

const sourceFiles = await filesUnder(distRoot);
if (sourceFiles.length === 0) throw new Error("Release package has no extension files.");

const localParts = [];
const centralParts = [];
let offset = 0;
const names = [];
for (const absolute of sourceFiles) {
  const name = relative(distRoot, absolute).split(sep).join("/");
  if (name.startsWith("../") || name.includes("/../")) throw new Error(`Unsafe archive path: ${name}`);
  const data = await readFile(absolute);
  const crc = crc32(data);
  const local = localHeader(name, data, crc);
  localParts.push(local, data);
  centralParts.push(centralHeader(name, data, crc, offset));
  offset += local.length + data.length;
  names.push(name);
}

if (!names.includes("manifest.json")) throw new Error("Release package is missing manifest.json.");
for (const name of names) {
  if (name.endsWith(".map") || name.endsWith(".ts") || name.includes(".env")) {
    throw new Error(`Release package contains forbidden development file: ${name}`);
  }
}

const centralOffset = offset;
const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
const archive = Buffer.concat([
  ...localParts,
  ...centralParts,
  endOfCentralDirectory(names.length, centralSize, centralOffset),
]);
await writeFile(archivePath, archive);

const sha256 = createHash("sha256").update(archive).digest("hex");
await writeFile(resolve(artifactsRoot, "SHA256SUMS.txt"), `${sha256}  ${archiveName}\n`, "utf8");
await writeFile(
  resolve(artifactsRoot, "build-info.json"),
  `${JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    archive: archiveName,
    sha256,
    sourceSha: process.env.VALIDATION_SHA ?? process.env.GITHUB_SHA ?? null,
    fileCount: names.length,
  }, null, 2)}\n`,
  "utf8",
);

console.log(`Created ${relative(repoRoot, archivePath)} with ${names.length} extension files.`);
console.log(`SHA-256 ${sha256}`);
