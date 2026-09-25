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

## Parsing

`parseShellCommands` is a small single-pass scanner. It tracks single quotes,
double quotes, and backslash escapes, and only recognizes a separator when the
scanner is outside both quote states.

Segment separators:

- `&&`, `||`, `|&`, `|`, `;`, `&`
- newlines (recorded without an operator label)

The scanner deliberately keeps these out of the split:

- separators inside quotes or escaped with a backslash;
- `#` comments, but only when the `#` starts a word;
- `&` that belongs to a redirection (`2>&1`, `>&2`, `&>file`).

Command substitution, here-documents, and `case` statements are not parsed as
nested constructs. Separators inside them become command boundaries. This is a
known limitation kept intentionally for a quick visual overview.

The result is a `ShellCommandSegment[]` where each segment carries the command
text and the operator that terminates it (the last segment has no operator).

## Rendering

`formatCommandBreakdown` numbers the segments, colors the number with `muted`,
and appends the trailing operator with `dim`. At most `MAX_BREAKDOWN_COMMANDS`
(25) lines are drawn; the remainder is summarized as `... and N more`.

`renderCall` reuses the container from `context.lastComponent` and clears it on
each pass so re-renders do not duplicate the command. It also mirrors the
built-in timing state (`startedAt` / `endedAt`) so the original `renderResult`
can still display the elapsed time.

The box uses `theme.bg("customMessageBg", ...)` to read as an inset annotation.

## Testing

`test/parse-commands.test.ts` covers two layers:

1. The pure parser with a matrix of quoting, escaping, comment, redirection,
   and mixed-separator cases, including the dense real-world command.
2. The tool override: registration, preservation of execution/schema metadata,
   the breakdown box, single-command suppression, the display cap, re-render
   de-duplication, and timing state.

The coding-agent package is mocked in the tests because the extension only
needs a bash definition to wrap; its execution path is not exercised.

```bash
npm install
npm test
npm run typecheck
```

## Release

```bash
npm login          # once per machine
npm test && npm run typecheck
npm version patch  # or minor / major
npm pack
```

Smoke-test the tarball before publishing. Extract it somewhere temporary,
install the extracted directory with a throwaway config dir, and confirm the
breakdown box still appears:

```bash
tar xzf pi-parse-commands-*.tgz
PI_CODING_AGENT_DIR=/tmp/pi-smoke pi install ./package
```

Then publish and tag:

```bash
npm publish
git push --follow-tags
```

The published tarball contains only `index.ts`, `README.md`, `CHANGELOG.md`,
`LICENSE`, `docs/**/*.md`, and `package.json`. Tests and build config are
excluded through the `files` field.

## Package identity

The package is extracted from the in-tree example at
`packages/coding-agent/examples/extensions/bash-command-breakdown/` in the pi
repository and packaged under the name `pi-parse-commands`. Keep the package
name, README installation commands, and changelog links aligned if the GitHub
repository is renamed.
