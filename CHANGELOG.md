# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `/parse-commands on` and `/parse-commands off` to enable or disable the breakdown for the
  current session. The toggle is session-scoped and resets when pi starts.
- Add `/parse-commands config` to manage the config from the TUI: create `config.jsonc`
  from the default template when none exists, insert newly introduced top-level
  options in place (keeping comments, with a `.bak` backup), or offer to
  regenerate a current config from the default. Malformed configs are only
  overwritten after confirmation, and the command is TUI-only.
- Add `extensionConfigDirectory`, `extensionConfigPath`,
  `applyCommandConfigMigration`, and `saveCommandConfig` config helpers.

### Changed

- Rename the runtime slash command from `/parcom` to `/parse-commands`.
- Read and write configs in the single extension config directory
  (`<agentDir>/extensions/pi-parse-commands-config/`). The former cwd, module
  sibling, and home-fallback search is removed.
- Move config migration out of extension load: nothing writes a config until you
  run `/parse-commands config`, and the on-load migration was removed.

### Fixed

- Recognize here-documents (`<<`, `<<-`, and quoted/escaped delimiters) so an
  embedded Python, Node, or bash program is no longer split into a bogus
  breakdown line per line. The body stays with the command that opened it, and
  a multi-line command is collapsed in the box to its first line plus a
  muted `… (+N lines)` marker instead of being reprinted.
- Do not mistake a here-string (`<<<word`) or an arithmetic left shift
  (`$((1 << 2))`) for a here-document.

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
