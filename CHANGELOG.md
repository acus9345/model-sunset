# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/). Changes to `data/models.json` alone don't get a release; the CLI downloads the list.

## [0.1.0] - 2026-10-29

### Added

- `model-sunset` CLI: finds hardcoded model IDs and reports retired ones and upcoming shutdowns with a suggested replacement.
- Shutdown list for 225 Anthropic, OpenAI and Google models, checked against the providers' pages on 2026-10-29. The CLI downloads the latest list (cached for 24 hours) and falls back to the bundled copy.
- Matching for Bedrock and Vertex AI spellings, strict matching for short IDs, `.gitignore` support and `model-sunset-ignore` comments.
- `text`, `json`, `github` and `markdown` output, `--within`, `--fail-on`, `--ignore`, `--offline`, `--data` and `--today`.
- GitHub Action that annotates files, writes a job summary and keeps an issue up to date.
- Library API: `loadData`, `scanPaths`, `scanText`, `createMatcher` and formatters.

[0.1.0]: https://github.com/acus9345/model-sunset/releases/tag/v0.1.0
