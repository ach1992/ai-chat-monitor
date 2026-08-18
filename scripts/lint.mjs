import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const textExtensions = new Set([".ts", ".mjs", ".json", ".md", ".html", ".css", ".yml"]);
const roots = ["src", "scripts", "tests", ".github"];
const rootFiles = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", ".gitignore"];
const failures = [];

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

  if (file.includes("/src/") && /\beval\s*\(/.test(content)) {
    failures.push(`${file}: eval() is not allowed in extension source`);
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
