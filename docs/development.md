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

`test/package.test.ts` covers the publishable artifact: package metadata, the
`npm pack` file list, and an end-to-end install that runs the real `pi` CLI
against the extracted tarball inside a throwaway `PI_CODING_AGENT_DIR`.
`test/release-version.test.ts` covers the release workflow's version resolver
in `scripts/release-version.ts`.

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## Release

Releases run automatically through `.github/workflows/release.yml` on every
push to `main`. `scripts/release-version.ts` resolves the version:

- If `v<current-version>` is not tagged yet, it releases the version already in
  `package.json` (this is what makes the first release `1.0.0`).
- If that tag exists, it bumps the patch version, commits, and tags.

The workflow then runs `npm publish --access public --provenance` and opens a
GitHub release. Publishing is skipped when the version is already on the
registry, so re-runs are safe, and the bot commit carries `[skip ci]` so it does
not trigger itself. `prepublishOnly` re-runs tests and typecheck before any
manual publish.

The publish step needs an `NPM_TOKEN` repository secret: an npm automation
token with publish rights for the `@lglen` scope. Add it under
Settings -> Secrets and variables -> Actions. Provenance uses the workflow's
`id-token: write` permission; [trusted publishing](https://docs.npmjs.com/trusted-publishers)
can replace the token later.

### Manual release

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

The published tarball contains only `index.ts`, `README.md`, `CHANGELOG.md`,
`LICENSE`, `docs/**/*.md`, and `package.json`. Tests, workflows, scripts, and
build config are excluded through the `files` field.

## Package identity

The package is extracted from the in-tree example at
`packages/coding-agent/examples/extensions/bash-command-breakdown/` in the pi
repository and published to npm as `@lglen/pi-parse-commands` (repository
`LaishGlenberg/pi-parse-commands`). Keep the package name, README installation
commands, and changelog links aligned if either is renamed.
