# Development Notes

Technical details for `pi-parse-commands`.

## Architecture

The extension wraps the built-in `bash` tool:

- `createBashToolDefinition(process.cwd())` produces the original definition.
- `pi.registerTool` re-registers `bash` with the same name, delegating
  `execute` and `renderResult` to the original.
- A custom `renderCall` prints the normal `$ <command>` line and then, when the
  command contains more than one segment, adds a nested box with one line per
  command.

Re-registering a built-in tool by name replaces it; only rendering changes.
Execution, truncation, timing, and expansion are the original implementation.

A `/parse-commands` command controls the extension at runtime. `on`/`off` flip a
session-scoped `enabled` flag: when off, `renderCall` skips the breakdown and
renders the plain `$ <command>` line instead. Because the bash tool is registered
once, the flag is read inside `renderCall` rather than by re-registering the
tool. The flag resets to enabled when the extension loads for a new session.

`/parse-commands config` is TUI-only (any other `ctx.mode` gets a notification and no
write) and is the only thing that ever writes config. It resolves the target with
`extensionConfigPath` in the single config directory and does one of three
things: with no config it writes `DEFAULT_CONFIG_TEMPLATE` to `config.jsonc`;
with a config missing a newer top-level option it calls
`applyCommandConfigMigration` (in-place insert, `.bak` first); with a current
config it reports it is already up to date and offers a confirmed regenerate from
the template. A malformed config is never overwritten without that confirmation.
Every write re-loads the config into the renderer without a restart.

## Parsing

`parseShellCommands` is a small single-pass scanner. It tracks single quotes,
double quotes, and backslash escapes, and only recognizes a separator when the
scanner is outside both quote states.

Segment separators:

- default: `&&`, `||`, `;`
- optional, enabled through the `separators` config: `|&`, `|`, `&`
- newlines (recorded without an operator label)

An explicit empty `separators` list is honored, leaving only newline
splitting. Unknown entries are dropped and duplicates are collapsed.

The scanner deliberately keeps these out of the split:

- separators inside quotes or escaped with a backslash;
- `#` comments, but only when the `#` starts a word;
- `&` that belongs to a redirection (`2>&1`, `>&2`, `&>file`);
- here-document bodies (see below).

### Here-documents

A here-document redirection (`<<`, `<<-`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`) is
recognized and its body is swallowed whole, up to and including the terminator
line. This is what keeps an embedded Python, Node, or bash program from being
split into one bogus segment per line: the body stays in the segment that
opened it, and parsing resumes on the line after the terminator.

- `<<-` terminators may be indented with tabs; a quoted or escaped delimiter
  matches the same literal word.
- Multiple here-documents on one line are consumed in declaration order.
- An unterminated body simply runs to the end of the command.
- A here-string (`<<<word`) is not a here-document and is left untouched.
- `$(( ... ))` arithmetic is consumed verbatim so a left shift (`1 << 2`) is
  not mistaken for a here-document.

Command substitution (`$(...)`) and `case` statements are still not parsed as
nested constructs. Separators inside them become command boundaries. This is a
known limitation kept intentionally for a quick visual overview. Genuine
multi-line control flow outside a here-document splits per line.

The result is a `ShellCommandSegment[]` where each segment carries the command
text and the operator that terminates it (the last segment has no operator).

## Rendering

`formatCommandBreakdown` numbers the segments, colors the number with `muted`,
appends the trailing operator with `dim`, and highlights configured executable
names. A segment that spans multiple lines (a here-document body) is collapsed
to its first line plus a muted `… (+N lines)` marker, so the embedded program is
never reprinted inside the box. At most `MAX_BREAKDOWN_COMMANDS` (25) lines are
drawn; the remainder is summarized as `... and N more`.

`config.ts` loads the first `config.jsonc`, `config.json`, `config.yaml`, or
`config.yml` found in `~/.pi/agent/extensions/pi-parse-commands-config/` (or the
configured directory). JSONC comments/trailing commas and YAML are supported.
Levels 0 through 3 map to the theme's green, yellow, orange, and red colors.
The optional `separators` array selects which list operators split the
breakdown; it defaults to `["&&", "||", ";"]`.

`applyCommandConfigMigration` keeps an existing config current as new top-level
options are introduced. It feature-detects missing keys against `CONFIG_FEATURES`
(no schema-version field), inserts them before the root close brace for JSON/JSONC
or appends a block for YAML, and writes a `.bak` copy first. Editing the text in
place preserves user comments and formatting; re-serializing would discard both.
It targets an explicit `configPath`, so there is no multi-directory search and no
migration on load: only `/parse-commands config` calls it. `extensionConfigDirectory` is
the single source of the config directory and `extensionConfigPath` picks the
first supported file (or the `config.jsonc` a new one would use).

`renderCall` reuses the container from `context.lastComponent` and clears it on
each pass so re-renders do not duplicate the command. It also mirrors the
built-in timing state (`startedAt` / `endedAt`) so the original `renderResult`
can still display the elapsed time.

The breakdown uses a padded `Text` component with
`theme.bg("customMessageBg", ...)`. Since nested background helpers reset ANSI
background state, each line restores the parent tool background with
`theme.getBgAnsi(...)`; otherwise the built-in tool renderer's right padding
would appear as a black strip.

## Testing

`test/parse-commands.test.ts` covers two layers:

1. The pure parser with a matrix of quoting, escaping, comment, redirection,
   here-document, and mixed-separator cases, including the dense real-world
   command and the embedded Python/Node/bash here-document cases.
2. The tool override: registration, preservation of execution/schema metadata,
   the breakdown box, single-command suppression, the display cap, re-render
   de-duplication, and timing state.

The coding-agent package is mocked in the tests because the extension only
needs a bash definition to wrap; its execution path is not exercised. Config
tests cover JSONC/YAML parsing, scanner edge cases (block comments, comment
markers inside strings, trailing commas), level/separator normalization, file
precedence (`jsonc` > `json` > `yaml` > `yml`), malformed-file fallback, and
loading only from the single extension directory; the tool rendering tests cover
configured highlighting. Migration tests cover path-targeted insertion, comment
preservation, the `.bak` backup, YAML and empty-object insertion, trailing-comma
reuse, and the throw-on-malformed contract. Config path tests cover
`extensionConfigDirectory` / `extensionConfigPath` and `saveCommandConfig`, plus
the template parsing to the defaults.

`/parse-commands` coverage exercises argument completion, session-scoped toggling
(including suppression of highlighting), and the full
`/parse-commands config` matrix: create-from-template, upgrade an older config, decline
or confirm regeneration of a current config, malformed-config handling, and the
non-TUI no-op.

`test/package.test.ts` covers the publishable artifact: package metadata, the
`npm pack` file list, and an end-to-end install that runs the real `pi` CLI
against the extracted tarball inside a throwaway `PI_CODING_AGENT_DIR`.
`test/release-version.test.ts` covers the release workflow's version resolver
in `scripts/release-version.ts`.

`test/e2e.test.ts` is an opt-in test that exercises the real agent directory
instead of a throwaway one: it clears any existing install, runs
`pi install npm:@lglen/pi-parse-commands`, runs a smoke prompt that explicitly
loads the npm copy and must print `SUCCESS`, then uninstalls the package. The
expected resting state is "package not installed; only the local symlink is
configured". It calls a real model and is excluded from the default vitest
config, so it only runs on demand:

```bash
npm run test:e2e
```

Set `LOG=1` (or run `npm run test:e2e:log`) to print each `pi` command and its
captured stdout/stderr while the test runs.

```bash
npm install
npm test
npm run typecheck
npm run lint
```

### Local pi layout

For a local checkout, link the whole extension directory rather than only its
entry point:

```bash
ln -s /path/to/pi-parse-commands ~/.pi/agent/extensions/pi-parse-commands
```

Keep user configuration in the sibling directory
`~/.pi/agent/extensions/pi-parse-commands-config/`. If pi does not discover
nested extension files automatically, add `+extensions/pi-parse-commands/index.ts`
to the `extensions` list in `~/.pi/agent/settings.json`.

## Release

Releases run automatically through `.github/workflows/release.yml` on every
push to `main`. `scripts/release-version.ts` resolves the version:

- If `v<current-version>` is not tagged yet, it releases the version already in
  `package.json` (this is what makes the first release `1.0.0`).
- If that tag exists, it bumps the patch version, commits, and tags.

The workflow opens a GitHub release with generated notes; it does not publish
to npm. The bot commit carries `[skip ci]` so it does not trigger itself.

### Manual publish

Publishing to npm is manual:

```bash
npm login          # once per machine
npm test && npm run typecheck && npm run lint
npm version patch  # or minor / major
npm pack
```

Smoke-test the tarball before publishing. `test/package.test.ts` automates this,
but you can do it by hand with a throwaway config dir:

```bash
tar xzf lglen-pi-parse-commands-*.tgz
PI_CODING_AGENT_DIR=/tmp/pi-smoke pi install ./package --no-approve
```

Then publish and push the tag:

```bash
npm publish --access public
git push --follow-tags
```

The published tarball contains the extension sources (`index.ts`, `config.ts`,
`highlight.ts`), README/changelog/license, `docs/**/*.md`, and `package.json`.
Tests, workflows, scripts, and build config are excluded through the `files`
field.

## Package identity

The package is extracted from the in-tree example at
`packages/coding-agent/examples/extensions/bash-command-breakdown/` in the pi
repository and published to npm as `@lglen/pi-parse-commands` (repository
`LaishGlenberg/pi-parse-commands`). Keep the package name, README installation
commands, and changelog links aligned if either is renamed.
