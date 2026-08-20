import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const textExtensions = new Set([".ts", ".mjs", ".json", ".md", ".html", ".css", ".yml"]);
const roots = ["src", "scripts", "tests", ".github"];
const rootFiles = [
  "README.md",
  "PRIVACY.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.content.json",
  ".gitignore",
];
const failures = [];
const remoteCodePatterns = [
  [/\beval\s*\(/, "eval() is not allowed in extension source"],
  [/\bnew\s+Function\s*\(/, "new Function() is not allowed in extension source"],
  [/\bimportScripts\s*\(\s*["']https?:\/\//, "remote importScripts() is not allowed in extension source"],
  [/\bimport\s*\(\s*["']https?:\/\//, "remote dynamic import is not allowed in extension source"],
  [/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i, "remote script source is not allowed in extension source"],
];

async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(entryPath)));
    } else if (textExtensions.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = [
  ...rootFiles.map((file) => resolve(file)),
  ...(await Promise.all(roots.map((root) => collect(resolve(root))))).flat(),
];

for (const file of files) {
  const content = await readFile(file, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      failures.push(`${file}:${index + 1}: trailing whitespace`);
    }
    if (line.includes("\t")) {
      failures.push(`${file}:${index + 1}: tab character`);
    }
  });

  if (file.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (error) {
      failures.push(`${file}: invalid JSON: ${String(error)}`);
    }
  }

  if (file.includes("/src/")) {
    for (const [pattern, message] of remoteCodePatterns) {
      if (pattern.test(content)) failures.push(`${file}: ${message}`);
    }
  }

  if (file.includes("/src/") && /\.innerHTML\s*=/.test(content)) {
    failures.push(`${file}: assign text safely instead of using innerHTML`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log(`Linted ${files.length} text files.`);
