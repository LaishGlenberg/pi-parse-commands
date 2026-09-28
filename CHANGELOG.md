# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `/parcom on` and `/parcom off` to enable or disable the breakdown for the
  current session, with a `parcom:on`/`parcom:off` status indicator. The toggle
  is session-scoped and resets when pi starts.
- Add `/parcom config` to edit the highlight config in the multi-line TUI editor.
  The content is validated as JSONC/YAML before writing, an invalid document
  re-opens the editor instead of clobbering the file, and a missing config is
  created from a template on save. Saving applies the new config immediately.
- Add `resolveCommandConfigPath`, `saveCommandConfig`, and
  `DEFAULT_CONFIG_TEMPLATE` config helpers used by the editor.
- Upgrade an existing config on load when it predates a new top-level option:
  insert the option with its default, preserve comments, and write a `.bak`
  backup first. Migration runs before the config is loaded, reuses an existing
  trailing comma instead of emitting a second one, is idempotent, never creates
  a config, and skips malformed files.

## [1.1.0] - 2026-09-26

### Added

- Highlight configured command names using JSON, JSONC, or YAML config files.
- Add default green/yellow/orange/red levels (`0` through `3`).
- Fill the multiline breakdown background through the full rendered width.
- Split on the main command-list operators (`&&`, `||`, `;`) by default and make
  the pipe/background operators (`|&`, `|`, `&`) opt-in through a `separators`
  config option.
- Expand config tests to cover file loading, filename precedence, malformed
  JSON/YAML fallback, scanner edge cases, and default discovery through
  `PI_CODING_AGENT_DIR`/`HOME`.

## [1.0.0] - 2026-09-25

### Added

- Split dense chained bash commands on `&&`, `||`, `|&`, `|`, `;`, `&`, and newlines.
- Draw a numbered breakdown box below the bash tool call with a distinct background.
- Preserve separators inside quotes, escaped separators, comments, and redirections.
- Cap the breakdown at 25 commands and summarize the remainder.
- Keep built-in execution, truncation, timing, and expanded output unchanged.
- Add standalone Vitest coverage for the parser and the tool override.
- Add package metadata tests plus an end-to-end install smoke test that packs the
  tarball and installs it with the `pi` CLI.
- Publish to npm as `@lglen/pi-parse-commands` with public access.
- Automate the GitHub release: resolve the version, bump if needed, and tag.
- Add an MIT license, package metadata, and a `typecheck` script.

[Unreleased]: https://github.com/LaishGlenberg/pi-parse-commands/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/LaishGlenberg/pi-parse-commands/releases/tag/v1.1.0
[1.0.0]: https://github.com/LaishGlenberg/pi-parse-commands/releases/tag/v1.0.0
