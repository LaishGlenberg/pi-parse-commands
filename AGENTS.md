# AGENTS.md — pi-parse-commands

Guidance for agents working in this repository. The global instructions at
`~/.pi/agent/AGENTS.md` still apply; this file covers repo specifics.

## What this is

A pi coding-agent extension (published to npm as `@lglen/pi-parse-commands`) that
overrides the built-in `bash` tool renderer. Execution is untouched; it replaces
`renderCall` to print the normal `$ <command>` line plus a numbered breakdown box
for chained commands, and highlights configured executables.

The npm package is extracted from the in-tree pi example
`packages/coding-agent/examples/extensions/bash-command-breakdown/`. Keep the
package name, README install commands, and changelog links aligned if either moves.

## pi source tree (reference — important)

The authoritative pi source lives in the local monorepo at `/home/lg/projects/pi/`.
Treat it as the reference for the extension API, TUI components, and idiomatic
examples. Read it before inventing patterns:

- `packages/coding-agent/docs/extensions.md` — the full extension API (commands,
  tools, UI context, events). Companion docs: `tui.md`, `themes.md`,
  `keybindings.md`, `sdk.md`, `packages.md`.
- `packages/coding-agent/examples/extensions/` — canonical, copy-pasteable examples
  (`commands.ts`, `modal-editor.ts`, `preset.ts`, `sudo-helper/`, …). Check here
  first for command UI, editors, overlays, and tool renderers.
- `packages/coding-agent/examples/extensions/bash-command-breakdown/` — the in-tree
  copy this npm package is extracted from. Keep the two in sync when the extension
  changes.
- `packages/coding-agent/src/` — implementation when docs are ambiguous; the
  built `.d.ts` files are also under `node_modules/@earendil-works/pi-coding-agent/dist/`.

The installed devDependency (`node_modules/@earendil-works/pi-coding-agent/`) ships
its own `docs/` and `examples/` mirroring the monorepo at the pinned version
(currently `0.85.1`). The monorepo can be ahead of that pin, so confirm API
signatures against the installed `dist/*.d.ts` before shipping code that uses them.

The monorepo is a **separate git repository**. Do not create branches or commit
there unless explicitly asked; all work happens in this repo.

## Layout

| Path | Purpose |
| --- | --- |
| `index.ts` | Extension factory: registers the `bash` override and the `/parcom` command. |
| `config.ts` | Config discovery/parsing (JSONC + YAML), separators, defaults, migration helpers. |
| `highlight.ts` | Executable-name highlighting for one command / the whole line. |
| `test/*.test.ts` | Vitest; `e2e.test.ts` is opt-in. |
| `docs/development.md` | Deep technical notes (parser, rendering, testing, release). |
| `docs/parcom-config-command-plan.md` | Pending rework of `/parcom config`. |
| `scripts/release-version.ts` | Version resolver used by the release workflow. |

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint --deny-warnings
npm test            # vitest, offline, excludes e2e
npm run test:e2e    # real pi install + real model; on demand only
```

Always run `typecheck`, `lint`, and `test` before considering work done. Add or
update tests for every behavior change; the parser and config code have large
coverage matrices.

## Conventions

- ESM + TypeScript, Node >= 22.19, `"type": "module"`, `.ts` import extensions.
- Tabs for indentation, double quotes, semicolons. Match the surrounding file.
- `strict`, `noUnusedLocals`, and `noUnusedParameters` are on; `verbatimModuleSyntax`
  means type-only imports must use `import type`.
- Keep files under ~300 lines; prefer targeted edits over full rewrites.
- Public API surface: `parseShellCommands`, `splitShellCommands`,
  `formatCommandBreakdown`, `MAX_BREAKDOWN_COMMANDS` from `index.ts`, and the
  config helpers from `config.ts`. Exports are covered by tests; keep them stable.
- Tests mock `@earendil-works/pi-coding-agent` (only `createBashToolDefinition` is
  needed) and use a fake `Theme`; do not import the real interactive runtime.

## Parser at a glance

`index.ts` exports `parseShellCommands(command, separators?)` (segments carry the
trailing operator) and `splitShellCommands(command)` (command strings only).

- Default split operators: `&&`, `||`, `;`, plus newlines.
- Opt-in operators via the config `separators` array: `|&`, `|`, `&`. An explicit
  empty array means newline-only splitting.
- Never splits inside single/double quotes, on backslash-escaped separators, inside a
  `#` comment that starts a word, or on redirection `&` (`2>&1`, `&>file`, `>&2`).
- Command substitution, here-docs, and `case` are parsed naively on purpose;
  separators inside them become boundaries. Details in `docs/development.md`.
- `MAX_BREAKDOWN_COMMANDS` (25) caps rendered lines; the rest is summarized.

## Extension behavior

- The factory takes `(pi, options)`; `options.config` injects a config for tests and
  `options.configDirectory` overrides the config directory.
- `renderCall` reuses `context.lastComponent` and clears it before re-drawing so
  repeated renders do not duplicate. It mirrors the built-in timing state
  (`startedAt`/`endedAt`) so `renderResult` can show elapsed time.
- The breakdown uses `theme.bg("customMessageBg", ...)` and must restore the parent
  tool background after each line via `theme.getBgAnsi(...)`.
- `/parcom on` / `/parcom off` are session-scoped and flip an `enabled` flag read
  inside `renderCall`. `/parcom config` is TUI-only and is the only writer of the
  config file (generate / upgrade / regenerate).

## Config

- Location: `<PI_CODING_AGENT_DIR or ~/.pi/agent>/extensions/pi-parse-commands-config/`.
- Supported filenames in priority order: `config.jsonc`, `config.json`,
  `config.yaml`, `config.yml`.
- Defaults when no config exists: no highlighted commands and separators
  `["&&", "||", ";"]`.
- JSONC comments/trailing commas and YAML are supported. Never create or modify a
  config implicitly; `/parcom config` is the only writer, and only in the TUI.
- Highlight levels are `0`–`3` and map to theme colors: `0` `success` (green),
  `1` `warning` (yellow), `2` `mdHeading` (orange), `3` `error` (red).
- Only the executable at the start of each command is highlighted; leading
  `VAR=value` assignments are skipped. Normalization drops unknown/duplicate
  separators and out-of-range levels.
- `/parcom config` generates `config.jsonc` from the template when none exists,
  calls `applyCommandConfigMigration` when a top-level option is missing (in place,
  `.bak` first), or offers a confirmed regenerate of a current config. Reads and
  writes use the one `extensionConfigDirectory`; `extensionConfigPath` picks the
  target file. There is no migration on load. See
  `docs/parcom-config-command-plan.md` for the design record.

### Adding a config option

1. Extend `CommandHighlightConfig` and `normalizeConfig` in `config.ts`.
2. Add a `CONFIG_FEATURES` entry with its JSON default and YAML block so the upgrade
   path can insert it non-destructively.
3. Consume it in `index.ts` / `highlight.ts`.
4. Update the README example, `docs/development.md`, and the changelog.
5. Add parse/load/upgrade tests plus the default-template test.

## Docs

- `README.md` is public/npm-facing: no workflow, tagging, or internal dev details.
- `docs/development.md` is the technical companion — update it with architecture,
  parsing, rendering, testing, or release changes.
- `CHANGELOG.md` follows Keep a Changelog; add entries under `[Unreleased]` and keep
  the version-compare links at the bottom current.

## Testing patterns

- `test/parse-commands.test.ts` exposes `collectExtension(options)` (returns the
  registered `bash` tool plus the `/parcom` command) and `collectTool(options)`. A
  `createCommandContext(mode)` fake wires `notify`, `setStatus`, `confirm`, and
  `theme.fg`, and defaults to `"tui"` mode.
- The fake `Theme` renders colors as `{color:text}`, so assertions can check for
  `{muted:1.}`, `{warning:node}`, `{dim:&&}`, etc.
- Config tests create temp dirs with `mkdtempSync` and restore `HOME` /
  `PI_CODING_AGENT_DIR` in `afterEach`.
- `test/package.test.ts` runs `npm pack` and the real `pi` CLI against the tarball
  inside a throwaway `PI_CODING_AGENT_DIR`.

## Local development

- Symlink the whole repo so pi loads the package manifest, not just the entry file:
  `ln -s <repo> ~/.pi/agent/extensions/pi-parse-commands`.
- Keep personal config in the sibling
  `~/.pi/agent/extensions/pi-parse-commands-config/`.
- If pi does not discover it, add `+extensions/pi-parse-commands/index.ts` to the
  `extensions` list in `~/.pi/agent/settings.json`.
- Reload extensions from the TUI (or restart pi) after edits; the symlink means no
  reinstall is needed.

## Release & packaging

- Publishing is manual (`npm publish --access public`); never publish from an agent
  session without explicit permission.
- The release workflow (`.github/workflows/release.yml`) runs on push to `main` and
  uses `scripts/release-version.ts`: if `v<package.json version>` is untagged it
  releases the current version, otherwise it bumps patch, commits (`[skip ci]`), and
  tags. It opens a GitHub release; it does not publish to npm.
- `package.json#files` is the published allowlist; `test/package.test.ts` asserts the
  tarball contents. Update both when adding shipped files.
- Quirk: the `major` script currently bumps a minor version (copy-paste of `minor`).
  Fix it rather than relying on it.

## Git

- Branch names: `lg/<feat|chore|docs|fix>/<slug>`.
- Conventional commit messages, e.g. `feat(commands): ...`, `test(config): ...`,
  `chore(release): ...`.
- Ask before pushing and before opening a PR. Never force-push `main`.
- Do not add node matrices to workflows.
