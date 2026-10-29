# model-sunset

Find hardcoded LLM model IDs in your code and warn when one is retired or about to be.

[![npm](https://img.shields.io/npm/v/model-sunset)](https://www.npmjs.com/package/model-sunset)
[![CI](https://github.com/acus9345/model-sunset/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/model-sunset/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/model-sunset)](LICENSE)

```
$ npx model-sunset .
src/chat.ts:14   claude-3-opus-20240229   RETIRED                         → suggested: claude-opus-4-8
src/embed.ts:3   gpt-5-mini               sunset 2026-12-11 (in 43 days)  → suggested: gpt-5.6-terra

2 hardcoded model IDs: 1 retired, 1 deprecated (model list from 2026-10-29).
```

Providers retire model IDs on a schedule. On the shutdown date every request to the old ID fails, and nobody remembers which files hardcode it. `model-sunset` keeps a list of shutdown dates for Anthropic, OpenAI and Google models and tells you where your code still uses them.

- **The list updates without a release.** The CLI downloads the latest [`data/models.json`](data/models.json) from this repository (cached for 24 hours) and falls back to the copy shipped in the package when it's offline.
- **Finds the real spellings:** quoted IDs, `.env` and YAML values, Bedrock IDs (`anthropic.claude-3-opus-20240229-v1:0`), Vertex IDs (`claude-3-opus@20240229`) and `models/gemini-...` paths.
- **Few false positives:** `gpt-4` doesn't match inside `gpt-4o` or `gpt-4.1`, and short IDs such as `o1` only match when quoted or assigned to a `model` key.
- **Respects `.gitignore`**, and skips `node_modules`, build output, lockfiles and binaries.
- Text, JSON, Markdown and GitHub annotation output, plus a [GitHub Action](#github-action) that runs weekly and opens an issue.

## Usage

```bash
npx model-sunset              # scan the current directory
npx model-sunset src lib      # scan some paths
npx model-sunset --within 90  # only deprecations that hit within 90 days
npx model-sunset --format json
```

| Option | Default | What it does |
| --- | --- | --- |
| `-f, --format` | `text` | `text`, `json`, `github` (workflow annotations) or `markdown`. |
| `--fail-on` | `deprecated` | Exit 1 on any finding (`deprecated`), only on `retired` IDs, or never (`none`). |
| `-w, --within <days>` | | Only report deprecated models that shut down within this many days. Retired ones are always reported. |
| `-i, --ignore <glob>` | | Skip paths, e.g. `-i "docs/**" -i "*.snap"`. Repeatable. |
| `--offline` | | Use the list shipped with the installed version; no network. |
| `--data <file\|url>` | | Use your own list in the same format. |
| `--today <date>` | today | Pretend it's another day, e.g. to see what breaks next quarter. |

Exit codes: `0` nothing at or above `--fail-on`, `1` something is, `2` bad usage.

To keep a line on purpose (a migration test, a changelog), put `model-sunset-ignore` in a comment on that line.

## GitHub Action

Copy [`examples/model-sunset.yml`](examples/model-sunset.yml) to `.github/workflows/` in your repository. It runs every Monday, keeps one issue up to date with what it found, and closes the issue once the IDs are gone. On pull requests it adds annotations to the changed files instead.

```yaml
on:
  schedule:
    - cron: "0 9 * * 1"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  model-sunset:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: acus9345/model-sunset@v0
        with:
          fail-on: retired
          create-issue: true
```

| Input | Default | What it does |
| --- | --- | --- |
| `path` | `.` | Paths to scan, separated by spaces. |
| `fail-on` | `retired` | `retired`, `deprecated` or `none`. |
| `within` | | Same as `--within`. |
| `ignore` | | Glob patterns, one per line. |
| `create-issue` | `false` | Open, update and close an issue with the findings. Needs `issues: write`. |
| `issue-title` | `Hardcoded model IDs are retired or deprecated` | Title of that issue. |
| `version` | `0` | Version of the CLI to run from npm. |

The findings also go to the job summary, and the action sets the outputs `count` and `retired`.

## The data

[`data/models.json`](data/models.json) is the whole product, so it's kept separate from the code:

```json
{
  "id": "claude-sonnet-4-5-20250929",
  "provider": "anthropic",
  "deprecated": "2026-09-30",
  "shutdown": "2026-11-30",
  "replacement": "claude-sonnet-5-5"
}
```

`shutdown` is `null` when a model is deprecated but has no date yet. `aliases` lists other spellings, and `strict: true` limits an ID to quoted or `model =` matches.

The dates come from the providers' own pages: [Anthropic](https://platform.claude.com/docs/en/about-claude/model-deprecations), [OpenAI](https://developers.openai.com/api/docs/deprecations) and [Google Gemini API](https://ai.google.dev/gemini-api/docs/deprecations). A [weekly workflow](.github/workflows/data-watch.yml) opens an issue here when one of those pages starts mentioning model names the list hasn't been checked against. Suggested replacements are followed to their end, so a suggestion is never itself on the list.

Cloud platforms (Amazon Bedrock, Google Cloud Vertex AI, Azure) can retire the same model on a different date. The list uses each provider's own API dates.

Found a wrong date or a missing model? A pull request that changes only `data/models.json` reaches every user within a day, with no new release needed.

## Library

```js
import { loadData, scanPaths, formatText } from "model-sunset";

const { data } = await loadData();
const findings = await scanPaths(["src"], data.models);
console.log(formatText(findings, { updated: data.updated }));
```

`createMatcher(models)` and `scanText(text, file, matcher, today)` let you scan text you already have, for example in a pre-commit hook. The list is also importable as `model-sunset/models.json`.

## Limits

It finds IDs written out in your code, configs and docs. An ID built at runtime (`` `claude-3-${size}` ``), read from a database or set in a provider dashboard won't be found. The list covers Anthropic, OpenAI and Google's Gemini API; pull requests for other providers are welcome.

## License

MIT
