import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createMatcher,
  formatGithub,
  formatMarkdown,
  formatText,
  globToRegExp,
  loadBundledData,
  loadData,
  parseData,
  scanPaths,
  scanText,
  type ModelEntry,
} from "../dist/index.js";

const MODELS: ModelEntry[] = [
  { id: "claude-3-opus-20240229", provider: "anthropic", shutdown: "2026-01-05", replacement: "claude-opus-4-8" },
  { id: "gpt-4", provider: "openai", shutdown: "2026-10-23", replacement: "gpt-5.6-sol" },
  { id: "gpt-4-turbo", provider: "openai", shutdown: "2026-10-23" },
  { id: "o1", provider: "openai", shutdown: "2026-10-23" },
  { id: "gemini-2.0-flash", provider: "google", shutdown: "2026-06-01" },
  { id: "text-embedding-ada-002", provider: "openai", shutdown: "2026-12-01", replacement: "text-embedding-3-small" },
  { id: "claude-mythos-preview", provider: "anthropic", shutdown: null },
];
const TODAY = "2026-10-29";
const matcher = createMatcher(MODELS);
const ids = (line: string) => matcher.matchLine(line).map((h) => h.match);

describe("matcher", () => {
  it("finds IDs in string literals", () => {
    assert.deepEqual(ids(`model: "claude-3-opus-20240229",`), ["claude-3-opus-20240229"]);
    assert.deepEqual(ids(`model="text-embedding-ada-002"`), ["text-embedding-ada-002"]);
  });

  it("does not match a longer ID that starts with a listed one", () => {
    assert.deepEqual(ids(`"gpt-4o"`), []);
    assert.deepEqual(ids(`"gpt-4.1"`), []);
    assert.deepEqual(ids(`"gpt-4-turbo"`), ["gpt-4-turbo"]);
    assert.deepEqual(ids(`"gemini-2.0-flash-lite"`), []);
    assert.deepEqual(ids(`"my-claude-3-opus-20240229"`), []);
  });

  it("matches cloud-platform spellings", () => {
    assert.deepEqual(ids(`"anthropic.claude-3-opus-20240229-v1:0"`), ["claude-3-opus-20240229"]);
    assert.deepEqual(ids(`"claude-3-opus@20240229"`), ["claude-3-opus@20240229"]);
    assert.deepEqual(ids(`"models/gemini-2.0-flash"`), ["gemini-2.0-flash"]);
  });

  it("only matches short IDs when quoted or assigned to a model key", () => {
    assert.deepEqual(ids(`const o1 = 3; // gpt-4 era`), []);
    assert.deepEqual(ids(`{ model: "o1" }`), ["o1"]);
    assert.deepEqual(ids(`MODEL_NAME=gpt-4`), ["gpt-4"]);
    assert.deepEqual(ids(`model: gpt-4`), ["gpt-4"]);
    assert.deepEqual(ids(`"openai/gpt-4"`), ["gpt-4"]);
  });

  it("matches long IDs in prose and config", () => {
    assert.deepEqual(ids(`We use claude-3-opus-20240229.`), ["claude-3-opus-20240229"]);
    assert.deepEqual(ids(`EMBED=text-embedding-ada-002`), ["text-embedding-ada-002"]);
  });
});

describe("scanText", () => {
  it("reports status, days left and position", () => {
    const text = `import x from "y";\nconst a = "claude-3-opus-20240229";\nconst b = 'text-embedding-ada-002';\nconst c = "claude-mythos-preview";\n`;
    const findings = scanText(text, "src/a.ts", matcher, TODAY);
    assert.equal(findings.length, 3);
    assert.deepEqual(
      findings.map((f) => [f.line, f.column, f.status, f.daysLeft]),
      [
        [2, 12, "retired", -297],
        [3, 12, "deprecated", 33],
        [4, 12, "deprecated", undefined],
      ],
    );
  });

  it("treats the shutdown day itself as retired", () => {
    const [f] = scanText(`"gemini-2.0-flash"`, "a", matcher, "2026-06-01");
    assert.equal(f?.status, "retired");
  });

  it("skips lines marked model-sunset-ignore", () => {
    assert.equal(scanText(`const a = "gpt-4"; // model-sunset-ignore`, "a", matcher, TODAY).length, 0);
  });
});

describe("report", () => {
  const findings = scanText(
    `"claude-3-opus-20240229"\n\n"text-embedding-ada-002"`,
    "src/chat.ts",
    matcher,
    TODAY,
  );

  it("prints aligned text", () => {
    const out = formatText(findings, { updated: "2026-10-29" });
    assert.match(out, /^src\/chat\.ts:1 {3}claude-3-opus-20240229 {3}RETIRED {25}→ suggested: claude-opus-4-8$/m);
    assert.match(out, /src\/chat\.ts:3 {3}text-embedding-ada-002 {3}sunset 2026-12-01 \(in 33 days\) {2}→ suggested: text-embedding-3-small/);
    assert.match(out, /2 hardcoded model IDs: 1 retired, 1 deprecated \(model list from 2026-10-29\)\.$/);
  });

  it("prints GitHub annotations", () => {
    const out = formatGithub(findings);
    assert.match(out, /^::error file=src\/chat\.ts,line=1,col=2,title=claude-3-opus-20240229 is retired::/m);
    assert.match(out, /^::warning file=src\/chat\.ts,line=3,/m);
  });

  it("prints a markdown table", () => {
    const out = formatMarkdown(findings);
    assert.match(out, /\| `src\/chat\.ts:1` \| `claude-3-opus-20240229` \| \*\*Retired\*\* \| `claude-opus-4-8` \|/);
  });

  it("says when nothing was found", () => {
    assert.equal(formatText([]), "No retired or deprecated model IDs found.");
  });
});

describe("globToRegExp", () => {
  it("matches at any depth without a slash", () => {
    assert.ok(globToRegExp("*.md").test("docs/a/readme.md"));
    assert.ok(!globToRegExp("*.md").test("docs/readme.mdx"));
  });
  it("anchors patterns with a slash", () => {
    assert.ok(globToRegExp("docs/**").test("docs/a/b.ts"));
    assert.ok(!globToRegExp("docs/**").test("src/docs/b.ts"));
    assert.ok(globToRegExp("src/**/*.test.ts").test("src/a.test.ts"));
    assert.ok(globToRegExp("fixtures").test("test/fixtures/a.json"));
  });
});

describe("scanPaths", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-sunset-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(dir, "src", "chat.ts"), `client.messages.create({ model: "claude-3-opus-20240229" });\n`);
  writeFileSync(join(dir, "src", "image.png"), Buffer.from([0x89, 0x50, 0, 0, 0x22]));
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), `"claude-3-opus-20240229"`);
  writeFileSync(join(dir, "package-lock.json"), `"claude-3-opus-20240229"`);
  writeFileSync(join(dir, "notes.md"), `"gpt-4"`);

  it("skips dependencies, lockfiles and binaries", async () => {
    const findings = await scanPaths([dir], MODELS, { today: TODAY });
    assert.deepEqual(findings.map((f) => f.file.split("/").slice(-2).join("/")).sort(), [
      `${dir.split(/[\\/]/).pop()}/notes.md`,
      "src/chat.ts",
    ]);
  });

  it("honors ignore globs", async () => {
    const findings = await scanPaths([dir], MODELS, { today: TODAY, ignore: ["*.md"] });
    assert.equal(findings.length, 1);
  });
});

describe("data", () => {
  it("ships a valid list with unique IDs", async () => {
    const data = await loadBundledData();
    assert.ok(data.models.length > 100);
    const seen = new Set<string>();
    for (const m of data.models) {
      assert.ok(!seen.has(m.id), `duplicate ${m.id}`);
      seen.add(m.id);
      assert.ok(m.shutdown === null || /^\d{4}-\d{2}-\d{2}$/.test(m.shutdown), m.id);
    }
  });

  it("never suggests a replacement that is itself on the list", async () => {
    const data = await loadBundledData();
    const listed = new Set(data.models.map((m) => m.id));
    for (const m of data.models) {
      if (m.replacement) assert.ok(!listed.has(m.replacement), `${m.id} → ${m.replacement} is deprecated too`);
    }
  });

  it("rejects malformed data", () => {
    assert.throws(() => parseData("{"), /not valid JSON/);
    assert.throws(() => parseData(`{"updated":"2026-01-01"}`), /missing/);
    assert.throws(
      () => parseData(`{"updated":"2026-01-01","models":[{"id":"x","provider":"y","shutdown":"soon"}]}`),
      /invalid shutdown date/,
    );
  });

  it("uses a newer remote list and caches it", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "model-sunset-cache-"));
    try {
      const remote = JSON.stringify({ version: 1, updated: "2999-01-01", models: [{ id: "x-1", provider: "p", shutdown: null }] });
      let calls = 0;
      const fetch = (async () => {
        calls++;
        return new Response(remote);
      }) as typeof globalThis.fetch;
      const first = await loadData({ cacheDir, fetch });
      assert.equal(first.from, "remote");
      assert.equal(first.data.models[0]?.id, "x-1");
      const second = await loadData({ cacheDir, fetch });
      assert.equal(second.from, "cache");
      assert.equal(calls, 1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("falls back to the bundled list when the download fails", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "model-sunset-cache-"));
    try {
      const fetch = (async () => new Response("nope", { status: 503 })) as typeof globalThis.fetch;
      const result = await loadData({ cacheDir, fetch });
      assert.equal(result.from, "bundled");
      assert.match(result.warning ?? "", /HTTP 503/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("keeps the bundled list when the remote one is older", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "model-sunset-cache-"));
    try {
      const old = JSON.stringify({ version: 1, updated: "2000-01-01", models: [] });
      const fetch = (async () => new Response(old)) as typeof globalThis.fetch;
      assert.equal((await loadData({ cacheDir, fetch })).from, "bundled");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
