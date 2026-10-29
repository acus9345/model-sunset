import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "model-sunset-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src", "chat.ts"), `\n\nconst model = "claude-3-opus-20240229";\n`);
writeFileSync(join(dir, "src", "embed.ts"), `export const MODEL = "claude-sonnet-4-5-20250929";\n`);

function run(...args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args, "--offline", "--today", "2026-10-29"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

describe("cli", () => {
  it("prints the version", () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.equal(run("--version").out.trim(), version);
  });

  it("reports retired and deprecated IDs and exits 1", () => {
    const { code, out } = run(".");
    assert.equal(code, 1);
    assert.match(out, /src\/chat\.ts:3 +claude-3-opus-20240229 +RETIRED +→ suggested: claude-opus-4-8/);
    assert.match(out, /src\/embed\.ts:1 +claude-sonnet-4-5-20250929 +sunset 2026-11-30 \(in 32 days\) +→ suggested: claude-sonnet-5-5/);
  });

  it("--fail-on retired ignores deprecated-only results", () => {
    assert.equal(run("src/embed.ts", "--fail-on", "retired").code, 0);
    assert.equal(run("src/chat.ts", "--fail-on", "retired").code, 1);
    assert.equal(run(".", "--fail-on", "none").code, 0);
  });

  it("--within filters far-off shutdowns", () => {
    const { code, out } = run("src/embed.ts", "--within", "10");
    assert.equal(code, 0);
    assert.match(out, /No retired or deprecated/);
  });

  it("prints JSON", () => {
    const parsed = JSON.parse(run(".", "--format", "json").out);
    assert.equal(parsed.findings.length, 2);
    assert.equal(parsed.findings[0].status, "retired");
  });

  it("rejects bad options with exit code 2", () => {
    assert.equal(run("--format", "xml").code, 2);
    assert.equal(run("--within", "soon").code, 2);
    const missing = run("nope");
    assert.equal(missing.code, 2);
    assert.match(missing.err, /no such file/);
  });
});
