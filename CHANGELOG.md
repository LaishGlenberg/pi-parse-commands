# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-25

### Added

- Split dense chained bash commands on `&&`, `||`, `|&`, `|`, `;`, `&`, and newlines.
- Draw a numbered breakdown box below the bash tool call with a distinct background.
- Preserve separators inside quotes, escaped separators, comments, and redirections.
- Cap the breakdown at 25 commands and summarize the remainder.
- Keep built-in execution, truncation, timing, and expanded output unchanged.
- Add standalone Vitest coverage for the parser and the tool override.
- Add an MIT license, package metadata, and a `typecheck` script.

[Unreleased]: https://github.com/LaishGlenberg/pi-parse-commands/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/LaishGlenberg/pi-parse-commands/releases/tag/v1.0.0
