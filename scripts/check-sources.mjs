#!/usr/bin/env node
// Checks the providers' deprecation pages for model names that weren't there when
// data/models.json was last reviewed. Prints a Markdown report and exits 1 when a page
// mentions new names, so the weekly workflow can open an issue.
//
//   node scripts/check-sources.mjs          compare against data/sources.lock.json
//   node scripts/check-sources.mjs --write  record the current names after updating models.json
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const data = JSON.parse(readFileSync(new URL("data/models.json", root), "utf8"));
const lockUrl = new URL("data/sources.lock.json", root);
const write = process.argv.includes("--write");

const TOKEN =
  /\b(?:claude-[a-z0-9][a-z0-9.@-]*[a-z0-9]|gpt-[a-z0-9][a-z0-9.-]*[a-z0-9]|chatgpt-[a-z0-9.-]*[a-z0-9]|o[1-9](?:-[a-z0-9]+)*|gemini-[a-z0-9][a-z0-9.-]*[a-z0-9]|imagen-[a-z0-9.-]*[a-z0-9]|veo-[a-z0-9.-]*[a-z0-9]|text-embedding-[a-z0-9-]*[a-z0-9]|dall-e-\d|tts-1(?:-hd)?|whisper-\d|sora-[a-z0-9-]*[a-z0-9])\b/g;

async function names(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "model-sunset data check" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const html = await res.text();
  return [...new Set(html.match(TOKEN) ?? [])].sort();
}

let lock = {};
try {
  lock = JSON.parse(readFileSync(lockUrl, "utf8"));
} catch {}

const report = [];
const next = {};
let changed = false;
for (const [provider, url] of Object.entries(data.sources)) {
  let current;
  try {
    current = await names(url);
  } catch (err) {
    report.push(`- **${provider}**: could not fetch ${url} (${err.message})`);
    changed = true;
    next[provider] = lock[provider] ?? [];
    continue;
  }
  next[provider] = current;
  const before = new Set(lock[provider] ?? []);
  const added = current.filter((n) => !before.has(n));
  if (added.length && lock[provider]) {
    changed = true;
    report.push(`- **${provider}** ([deprecations page](${url})) now mentions: ${added.map((n) => `\`${n}\``).join(", ")}`);
  }
}

if (write) {
  writeFileSync(lockUrl, JSON.stringify(next, null, 2) + "\n");
  console.log(`Recorded ${Object.values(next).flat().length} names in data/sources.lock.json.`);
} else if (changed) {
  console.log(
    [
      "The providers' deprecation pages changed since `data/models.json` was last reviewed.",
      "",
      ...report,
      "",
      "Update `data/models.json` (and its `updated` date), then run `node scripts/check-sources.mjs --write` and commit both files.",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log("No new model names on the providers' deprecation pages.");
}
