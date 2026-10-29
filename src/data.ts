import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelEntry {
  /** The model ID as it appears in API calls, e.g. `"claude-3-opus-20240229"`. */
  id: string;
  provider: string;
  /** Date the provider announced the deprecation (YYYY-MM-DD), when known. */
  deprecated?: string;
  /** Date requests start failing (YYYY-MM-DD), or `null` when not announced yet. */
  shutdown: string | null;
  /** Suggested replacement model ID. */
  replacement?: string;
  note?: string;
  /** Other spellings of the same model, e.g. a cloud-platform ID. */
  aliases?: string[];
  /**
   * Only match when the ID is quoted or assigned to a `model` key. Defaults to `true`
   * for IDs of 10 characters or fewer (`o1`, `gpt-4`), which are too short to match anywhere.
   */
  strict?: boolean;
}

export interface ModelData {
  version: number;
  /** Date the list was last checked against the providers' pages (YYYY-MM-DD). */
  updated: string;
  sources?: Record<string, string>;
  models: ModelEntry[];
}

export const DATA_URL = "https://raw.githubusercontent.com/acus9345/model-sunset/main/data/models.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const BUNDLED_URL = new URL("../data/models.json", import.meta.url);

export async function loadBundledData(): Promise<ModelData> {
  return parseData(await readFile(BUNDLED_URL, "utf8"), "bundled data");
}

/** Parses and validates a models.json document. Throws with a readable message when it's malformed. */
export function parseData(json: string, label = "data"): ModelData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${(err as Error).message}`);
  }
  const data = raw as ModelData;
  if (!data || typeof data !== "object" || !Array.isArray(data.models) || typeof data.updated !== "string") {
    throw new Error(`${label} is missing "updated" or "models"`);
  }
  for (const m of data.models) {
    if (!m || typeof m.id !== "string" || !m.id || typeof m.provider !== "string") {
      throw new Error(`${label} has a model without "id" or "provider"`);
    }
    if (m.shutdown !== null && !isDate(m.shutdown)) {
      throw new Error(`${label}: ${m.id} has an invalid shutdown date ${JSON.stringify(m.shutdown)}`);
    }
  }
  return data;
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export interface LoadOptions {
  /** Use only the data shipped with the package. */
  offline?: boolean;
  /** A local file path or URL to load instead of the default list. */
  source?: string;
  /** Directory for the cached download. */
  cacheDir?: string;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds to wait for the download. */
  timeout?: number;
}

export interface LoadResult {
  data: ModelData;
  /** Where the data came from: `"bundled"`, `"cache"`, `"remote"` or the `source` you passed. */
  from: string;
  /** Set when the download failed and the bundled or cached list was used instead. */
  warning?: string;
}

/**
 * Loads the deprecation list. By default it downloads the latest list from GitHub (cached for
 * 24 hours), so new shutdown dates reach you without a new release, and falls back to the
 * bundled copy when offline. Whichever list has the newer `updated` date wins.
 */
export async function loadData(options: LoadOptions = {}): Promise<LoadResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (options.source) {
    const text = /^https?:\/\//.test(options.source)
      ? await download(options.source, doFetch, options.timeout ?? 10_000)
      : await readFile(options.source, "utf8");
    return { data: parseData(text, options.source), from: options.source };
  }

  const bundled = await loadBundledData();
  if (options.offline) return { data: bundled, from: "bundled" };

  const cacheFile = join(options.cacheDir ?? defaultCacheDir(), "models.json");
  const cached = await readCache(cacheFile);
  if (cached && Date.now() - cached.mtime < CACHE_TTL_MS) {
    return newer(cached.data, bundled) === cached.data ? { data: cached.data, from: "cache" } : { data: bundled, from: "bundled" };
  }

  try {
    const text = await download(DATA_URL, doFetch, options.timeout ?? 3000);
    const remote = parseData(text, DATA_URL);
    await mkdir(join(cacheFile, ".."), { recursive: true })
      .then(() => writeFile(cacheFile, text))
      .catch(() => {});
    return newer(remote, bundled) === remote ? { data: remote, from: "remote" } : { data: bundled, from: "bundled" };
  } catch (err) {
    const fallback = cached && newer(cached.data, bundled) === cached.data ? cached : undefined;
    return {
      data: fallback?.data ?? bundled,
      from: fallback ? "cache" : "bundled",
      warning: `could not download the latest model list (${(err as Error).message}); using the ${fallback ? "cached" : "bundled"} copy from ${(fallback?.data ?? bundled).updated}`,
    };
  }
}

function newer(a: ModelData, b: ModelData): ModelData {
  return a.updated >= b.updated ? a : b;
}

async function download(url: string, doFetch: typeof globalThis.fetch, timeout: number): Promise<string> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function readCache(file: string): Promise<{ data: ModelData; mtime: number } | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { data: parseData(text, file), mtime: info.mtimeMs };
  } catch {
    return undefined;
  }
}

function defaultCacheDir(): string {
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
    join(homedir(), ".cache");
  return join(base || homedir(), "model-sunset");
}
