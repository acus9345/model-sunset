import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ModelEntry } from "./data.js";

export type Status = "retired" | "deprecated";

export interface Finding {
  /** Path relative to the current directory, with forward slashes. */
  file: string;
  line: number;
  column: number;
  /** The text that matched, which can be an alias of `model.id`. */
  match: string;
  model: ModelEntry;
  status: Status;
  /** Days until shutdown; negative once it has passed, `undefined` when no date is announced. */
  daysLeft?: number;
}

export interface Matcher {
  /** Finds model IDs in one line of text. */
  matchLine(line: string): { match: string; column: number; model: ModelEntry }[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Builds a matcher for every model in the list. */
export function createMatcher(models: ModelEntry[]): Matcher {
  const byName = new Map<string, ModelEntry>();
  const loose: string[] = [];
  const strict: string[] = [];
  for (const model of models) {
    const names = [model.id, ...(model.aliases ?? [])];
    // Vertex AI spells dated Claude IDs as `claude-3-opus@20240229`.
    const dated = /^(claude-.+)-(\d{8})$/.exec(model.id);
    if (dated) names.push(`${dated[1]}@${dated[2]}`);
    for (const name of names) {
      if (byName.has(name)) continue;
      byName.set(name, model);
      (model.strict ?? name.length <= 10 ? strict : loose).push(name);
    }
  }
  const alternation = (names: string[]) =>
    names
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|");
  // A model ID ends at anything that can't continue it. `-v1:0` is allowed after it for
  // Bedrock IDs (`anthropic.claude-3-opus-20240229-v1:0`).
  const end = String.raw`(?=$|-v\d|[^A-Za-z0-9_.\-]|[.\-](?![A-Za-z0-9]))`;
  const patterns: RegExp[] = [];
  if (loose.length) patterns.push(new RegExp(String.raw`(?<![A-Za-z0-9_\-])(?:${alternation(loose)})${end}`, "g"));
  if (strict.length) {
    const names = alternation(strict);
    patterns.push(
      new RegExp(
        String.raw`(?<=["'\x60/])(?:${names})(?=["'\x60])|(?<=[Mm][Oo][Dd][Ee][Ll][A-Za-z_]*["']?\s*[:=]\s*)(?:${names})(?![A-Za-z0-9_.\-])`,
        "g",
      ),
    );
  }

  return {
    matchLine(line) {
      const hits: { match: string; column: number; model: ModelEntry }[] = [];
      for (const re of patterns) {
        re.lastIndex = 0;
        for (let m = re.exec(line); m; m = re.exec(line)) {
          const model = byName.get(m[0]);
          if (model && !hits.some((h) => h.column === m!.index + 1)) hits.push({ match: m[0], column: m.index + 1, model });
        }
      }
      return hits.sort((a, b) => a.column - b.column);
    },
  };
}

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

export function todayString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function statusOf(model: ModelEntry, today: string): { status: Status; daysLeft?: number } {
  if (!model.shutdown) return { status: "deprecated" };
  const daysLeft = daysBetween(today, model.shutdown);
  return { status: daysLeft <= 0 ? "retired" : "deprecated", daysLeft };
}

const IGNORE_LINE = "model-sunset-ignore";

/** Scans text and returns every model ID it mentions. Lines containing `model-sunset-ignore` are skipped. */
export function scanText(text: string, file: string, matcher: Matcher, today: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 5000 || line.includes(IGNORE_LINE)) continue;
    for (const hit of matcher.matchLine(line)) {
      findings.push({ file, line: i + 1, column: hit.column, match: hit.match, model: hit.model, ...statusOf(hit.model, today) });
    }
  }
  return findings;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", "vendor", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", "target", "venv", ".venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache",
]);
const SKIP_FILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "poetry.lock", "uv.lock", "Pipfile.lock", "Cargo.lock", "Gemfile.lock", "composer.lock", "go.sum",
]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|flac|sqlite|db|pyc|class|o|a|lib|node|map)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

export interface ListOptions {
  /** Glob patterns to skip, matched against the path relative to the current directory. */
  ignore?: string[];
}

/** Lists the text files to scan under each path. Inside a git repository it uses `git ls-files`, so `.gitignore` is respected. */
export async function listFiles(paths: string[], options: ListOptions = {}): Promise<string[]> {
  const ignore = (options.ignore ?? []).map(globToRegExp);
  const files = new Set<string>();
  for (const p of paths) {
    const info = await stat(p);
    if (info.isFile()) {
      files.add(resolve(p));
      continue;
    }
    const fromGit = await gitFiles(p);
    for (const f of fromGit ?? (await walk(resolve(p)))) files.add(f);
  }
  return [...files]
    .filter((f) => {
      const parts = f.split(sep);
      const name = parts[parts.length - 1]!;
      if (SKIP_FILES.has(name) || BINARY_EXT.test(name) || /\.min\.(js|css)$/.test(name)) return false;
      if (parts.some((part) => SKIP_DIRS.has(part))) return false;
      const rel = displayPath(f);
      return !ignore.some((re) => re.test(rel));
    })
    .sort();
}

function gitFiles(dir: string): Promise<string[] | undefined> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return done(undefined);
        done(stdout.split("\0").filter(Boolean).map((f) => resolve(dir, f)));
      },
    );
  });
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Reads a file as text, or returns `undefined` for binary or very large files. */
export async function readText(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    if (size > MAX_BYTES) return undefined;
    const buf = await handle.readFile();
    if (buf.subarray(0, 8000).includes(0)) return undefined;
    return buf.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return (rel && !rel.startsWith("..") ? rel : file).split(sep).join("/");
}

/** Converts a glob (`*`, `**`, `?`) to a regular expression. A pattern without `/` matches at any depth. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escape(c);
  }
  const anchored = g.includes("/") ? `^${re}` : `(?:^|/)${re}`;
  return new RegExp(`${anchored}(?:/.*)?$`);
}

export interface ScanOptions extends ListOptions {
  /** Date to compare shutdown dates against (YYYY-MM-DD). Defaults to today (UTC). */
  today?: string;
}

/** Scans files and directories for hardcoded model IDs that are retired or deprecated. */
export async function scanPaths(paths: string[], models: ModelEntry[], options: ScanOptions = {}): Promise<Finding[]> {
  const matcher = createMatcher(models);
  const today = options.today ?? todayString();
  const findings: Finding[] = [];
  for (const file of await listFiles(paths, options)) {
    const text = await readText(file);
    if (text !== undefined) findings.push(...scanText(text, displayPath(file), matcher, today));
  }
  return findings;
}
