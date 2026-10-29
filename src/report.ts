import type { Finding } from "./scan.js";

export type Format = "text" | "json" | "github" | "markdown";

export interface ReportOptions {
  color?: boolean;
  /** Date of the model list, shown in the summary. */
  updated?: string;
}

const paint = (on: boolean, code: string, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export function describe(f: Finding): string {
  if (f.status === "retired") return "RETIRED";
  if (f.daysLeft === undefined) return "DEPRECATED (shutdown date not announced)";
  return `sunset ${f.model.shutdown} (in ${f.daysLeft} day${f.daysLeft === 1 ? "" : "s"})`;
}

function suggestion(f: Finding): string {
  return f.model.replacement ? `suggested: ${f.model.replacement}` : "";
}

export function summary(findings: Finding[], updated?: string): string {
  const retired = findings.filter((f) => f.status === "retired").length;
  const deprecated = findings.length - retired;
  const list = updated ? ` (model list from ${updated})` : "";
  if (!findings.length) return `No retired or deprecated model IDs found${list}.`;
  return `${findings.length} hardcoded model ID${findings.length === 1 ? "" : "s"}: ${retired} retired, ${deprecated} deprecated${list}.`;
}

export function formatText(findings: Finding[], options: ReportOptions = {}): string {
  const color = options.color ?? false;
  const rows = findings.map((f) => [`${f.file}:${f.line}`, f.match, describe(f), suggestion(f)] as const);
  const w0 = Math.max(0, ...rows.map((r) => r[0].length));
  const w1 = Math.max(0, ...rows.map((r) => r[1].length));
  const w2 = Math.max(0, ...rows.map((r) => r[2].length));
  const lines = rows.map(([loc, id, status, next], i) => {
    const f = findings[i]!;
    const statusCell = paint(color, f.status === "retired" ? "31;1" : "33", status.padEnd(w2));
    const arrow = next ? `  → ${next}` : "";
    return `${paint(color, "2", loc.padEnd(w0))}   ${id.padEnd(w1)}   ${statusCell}${arrow}`.trimEnd();
  });
  if (lines.length) lines.push("");
  lines.push(summary(findings, options.updated));
  return lines.join("\n");
}

export function formatJson(findings: Finding[], options: ReportOptions = {}): string {
  return JSON.stringify(
    {
      updated: options.updated,
      findings: findings.map((f) => ({
        file: f.file,
        line: f.line,
        column: f.column,
        match: f.match,
        id: f.model.id,
        provider: f.model.provider,
        status: f.status,
        shutdown: f.model.shutdown,
        daysLeft: f.daysLeft ?? null,
        replacement: f.model.replacement ?? null,
      })),
    },
    null,
    2,
  );
}

const ghEscape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const ghProp = (s: string) => ghEscape(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** GitHub Actions workflow commands, which show up as annotations on the files. */
export function formatGithub(findings: Finding[], options: ReportOptions = {}): string {
  const lines = findings.map((f) => {
    const level = f.status === "retired" ? "error" : "warning";
    const next = f.model.replacement ? ` Suggested replacement: ${f.model.replacement}.` : "";
    const title = `${f.match} is ${f.status === "retired" ? "retired" : "deprecated"}`;
    return `::${level} file=${ghProp(f.file)},line=${f.line},col=${f.column},title=${ghProp(title)}::${ghEscape(`${f.match}: ${describe(f)}.${next}`)}`;
  });
  lines.push(summary(findings, options.updated));
  return lines.join("\n");
}

/** A Markdown table, used for the issue the GitHub Action opens. */
export function formatMarkdown(findings: Finding[], options: ReportOptions = {}): string {
  const out = [summary(findings, options.updated)];
  if (findings.length) {
    out.push("", "| Location | Model | Status | Suggested replacement |", "| --- | --- | --- | --- |");
    for (const f of findings) {
      const status = f.status === "retired" ? "**Retired**" : describe(f).replace(/^sunset/, "Shuts down");
      out.push(`| \`${f.file}:${f.line}\` | \`${f.match}\` | ${status} | ${f.model.replacement ? `\`${f.model.replacement}\`` : ""} |`);
    }
  }
  return out.join("\n");
}

export function format(findings: Finding[], fmt: Format, options: ReportOptions = {}): string {
  switch (fmt) {
    case "json":
      return formatJson(findings, options);
    case "github":
      return formatGithub(findings, options);
    case "markdown":
      return formatMarkdown(findings, options);
    default:
      return formatText(findings, options);
  }
}
