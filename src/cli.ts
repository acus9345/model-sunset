#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadData } from "./data.js";
import { format, type Format } from "./report.js";
import { scanPaths, todayString, type Finding } from "./scan.js";

const HELP = `model-sunset - find hardcoded model IDs that are retired or about to be

Usage:
  model-sunset [paths...] [options]

Scans files and directories (default ".") for model IDs from Anthropic, OpenAI
and Google that have a shutdown date. Inside a git repository only tracked and
unignored files are read.

Exit code 0 when nothing reaches --fail-on, 1 when something does, 2 on bad usage.

Options:
  -f, --format <fmt>      text (default), json, github (annotations) or markdown.
      --fail-on <level>   retired, deprecated (default) or none.
  -w, --within <days>     Only report deprecated models that shut down within this
                          many days. Retired models are always reported.
  -i, --ignore <glob>     Skip matching paths. Repeatable, e.g. -i "docs/**".
      --offline           Use the model list shipped with this version. By default
                          the latest list is downloaded from GitHub (cached 24h).
      --data <file|url>   Use your own models.json instead.
      --today <date>      Compare against this date (YYYY-MM-DD) instead of today.
      --no-color          Don't color the output.
  -h, --help              Show this help.
  -v, --version           Show the version number.

Add "model-sunset-ignore" in a comment on a line to skip it.

Examples:
  model-sunset .
  model-sunset src --within 90
  model-sunset --format json > sunset.json
`;

const FORMATS = new Set(["text", "json", "github", "markdown"]);
const FAIL_ON = new Set(["retired", "deprecated", "none"]);

class UsageError extends Error {}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", short: "f", default: "text" },
        "fail-on": { type: "string", default: "deprecated" },
        within: { type: "string", short: "w" },
        ignore: { type: "string", short: "i", multiple: true, default: [] },
        offline: { type: "boolean", default: false },
        data: { type: "string" },
        today: { type: "string" },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const fmt = values.format as Format;
  if (!FORMATS.has(fmt)) throw new UsageError(`--format must be text, json, github or markdown, not "${fmt}"`);
  const failOn = values["fail-on"]!;
  if (!FAIL_ON.has(failOn)) throw new UsageError(`--fail-on must be retired, deprecated or none, not "${failOn}"`);
  let within: number | undefined;
  if (values.within !== undefined) {
    within = Number(values.within);
    if (!Number.isInteger(within) || within < 0) throw new UsageError(`--within must be a whole number of days`);
  }
  const today = values.today ?? process.env.MODEL_SUNSET_TODAY ?? todayString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(Date.parse(today))) {
    throw new UsageError(`--today must be a date like 2026-12-01`);
  }

  const loaded = await loadData({ offline: values.offline, source: values.data });
  if (loaded.warning) process.stderr.write(`model-sunset: ${loaded.warning}\n`);

  const paths = positionals.length ? positionals : ["."];
  let findings: Finding[];
  try {
    findings = await scanPaths(paths, loaded.data.models, { today, ignore: values.ignore });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new UsageError(`no such file or directory: ${e.path ?? paths.join(", ")}`);
    throw err;
  }
  if (within !== undefined) {
    findings = findings.filter((f) => f.status === "retired" || (f.daysLeft !== undefined && f.daysLeft <= within));
  }

  const color = !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  process.stdout.write(`${format(findings, fmt, { color, updated: loaded.data.updated })}\n`);

  if (failOn === "none") return 0;
  return findings.some((f) => failOn === "deprecated" || f.status === "retired") ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`model-sunset: ${(err as Error).message}\n`);
    if (err instanceof UsageError) process.stderr.write("Run with --help for usage.\n");
    process.exitCode = 2;
  },
);
