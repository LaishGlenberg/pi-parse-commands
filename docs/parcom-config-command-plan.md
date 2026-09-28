# Plan: `/parcom config` scaffolds, upgrades, and regenerates the config

> Status: implemented. This document is kept as the design record for the
> generate/upgrade/regenerate command; the behavior below matches the shipped
> code. See `docs/development.md` for the technical companion.

## Goal

`/parcom config` is the **only** thing that ever writes config. It runs on demand in
the TUI and does one of three things against the extension config directory:

1. **No config** → generate the default config file.
2. **Config missing top-level options** (a newer extension added a field) → append
   the missing options non-destructively and back up the old file.
3. **Config already current, or unreadable** → offer to delete and regenerate it
   from the default.

Automatic migration on extension load is removed. Users who have no config and have
never run `/parcom config` always get pure defaults: the three separators
(`&&`, `||`, `;`) and **no** command highlighting. The extension never touches their
filesystem by itself.

## Scope (decided)

- **One directory only:** the active agent's extension config directory,
  `<agentDir>/extensions/pi-parse-commands-config/`, where `<agentDir>` is
  `PI_CODING_AGENT_DIR` or `~/.pi/agent` (tests inject `options.configDirectory`).
  The old cwd / module-sibling / home-fallback search is removed for both reads and
  writes, so the config always lives in one predictable place.
- **TUI only.** When `ctx.mode !== "tui"` (RPC/JSON/print), `/parcom config`
  notifies that it is only available in the interactive TUI and does nothing.
  `/parcom on` / `/parcom off` stay available in every mode.

## Behavior

### `/parcom config` flow

```
if (ctx.mode !== "tui") { notify("/parcom config is only available in the TUI"); return; }

dir        = extensionConfigDirectory(options.configDirectory)
configPath = findCommandConfigPath(dir)      // any supported filename, or undefined

if (!configPath) {
    write DEFAULT_CONFIG_TEMPLATE -> join(dir, "config.jsonc")
    reload()
    notify("Created <path>")
    return
}

let missing
try { missing = findMissingConfigFeatures(read(configPath), configPath) }
catch (error) {
    notify("Could not parse <configPath>: <error>", "error")
    offerRegenerate(configPath)              // see below
    return
}

if (missing.length > 0) {
    applyCommandConfigMigration(configPath, missing)   // in-place, non-destructive, writes .bak
    reload()
    notify("Updated <path>: added <missing.join(', ')>")
    return
}

notify("Your config is already up to date.")
offerRegenerate(configPath)
```

`offerRegenerate(path)`:

```
if (await ctx.ui.confirm(
      "Regenerate config?",
      "This deletes <path> and recreates it from the default. Continue?")) {
    rm(path)
    write DEFAULT_CONFIG_TEMPLATE -> path
    reload()
    notify("Regenerated <path>")
}
```

- `reload()` sets `config = loadCommandConfig(options.configDirectory)` when
  `options.config` is not injected, so highlights/separators apply immediately.
- Migration keeps the existing non-destructive text insertion (comments, trailing
  commas preserved) and writes `<path>.bak` first.
- Regenerate is an explicit, confirmed full overwrite. It does **not** write a new
  `.bak` and does **not** delete any existing `.bak` (that stays as the last
  pre-migration safety copy).
- A malformed config is never overwritten unless the user confirms regenerate; if
  they decline, the file is left byte-for-byte untouched.

## Config module API changes (`config.ts`)

- Add `extensionConfigDirectory(configDirectory?): string` — the single source of
  the config directory:
  ```ts
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "extensions", CONFIG_DIRECTORY_NAME);
  ```
- Add `extensionConfigPath(configDirectory?): string` — first existing supported
  file in that directory, else `<dir>/config.jsonc`.
- Rewrite `loadCommandConfig(configDirectory?)` to read only from
  `extensionConfigDirectory(...)`. Missing/unreadable/malformed still falls back to
  `{ commands: {}, separators: [...DEFAULT_SEPARATORS] }`.
- Remove `defaultConfigDirectories` and `resolveCommandConfigPath` (superseded).
- Remove the searching `migrateCommandConfig` wrapper. Keep and reuse:
  `findMissingConfigFeatures(content, filename)` (parses + reports missing keys),
  plus the insertion helpers `insertJsonFeatures` / `appendYamlFeatures`.
- Add `applyCommandConfigMigration(configPath, features)`:
  read → copy to `.bak` → insert features → write. Returns the written path; throws
  on read/write failure.
- Keep `saveCommandConfig(content, path)` and `findCommandConfigPath(directory)`.

## Default template

The default config with a single `rm` example (the no-config defaults plus one
demonstration entry), so a generated file is immediately up to date:

```jsonc
{
  // 0 = green, 1 = yellow, 2 = orange, 3 = red
  "commands": {
    "rm": 3
  },
  // List operators that start a new breakdown line.
  // Defaults to the three below; add any of "|&", "|", "&" to opt in.
  "separators": ["&&", "||", ";"]
}
```

## No-config users

`loadCommandConfig` returns `{ commands: {}, separators: ["&&", "||", ";"] }` when no
file exists. With the load-time migration call removed, nothing writes implicitly;
the only path that creates a file is `/parcom config`.

## Files to change

| File | Change |
| --- | --- |
| `index.ts` | Replace `editConfig` with the generate/upgrade/regenerate flow; add the `ctx.mode !== "tui"` guard; drop `migrateCommandConfig` and `ctx.ui.editor` usage. |
| `config.ts` | Add `extensionConfigDirectory` / `extensionConfigPath`; restrict `loadCommandConfig`; replace `migrateCommandConfig` with `applyCommandConfigMigration`; remove `defaultConfigDirectories` / `resolveCommandConfigPath`; rewrite `DEFAULT_CONFIG_TEMPLATE`. |
| `test/parse-commands.test.ts` | Replace editor tests with the command-behavior matrix below; delete the migration-on-load test. |
| `test/config.test.ts` | Drop load-time migration coverage; cover `extensionConfigDirectory` / `extensionConfigPath`, path-targeted migration, single-directory loading, and the new template. |
| `README.md` | Rewrite `/parcom config` docs; remove the automatic-migration paragraph. |
| `docs/development.md` | Document the three-way command flow and the removal of load-time migration. |
| `CHANGELOG.md` | Under Unreleased: scaffolding/upgrade/regenerate command; note that automatic config migration was removed. |
| `package.json` | Bump minor (`npm run minor`) once implemented. |

## Tests

1. No config → creates `<dir>/config.jsonc` with the template; the `rm` highlight
   applies immediately.
2. Existing config missing `separators` → appends it, preserves comments, writes
   `.bak`, notifies the added field.
3. Existing current config → says up to date; declining confirm leaves the file
   byte-identical.
4. Existing current config → confirming regenerate deletes and rewrites the
   template.
5. Malformed config → error notification + regenerate offer; declining leaves the
   file untouched; confirming rewrites the template.
6. Non-TUI mode → notification only, nothing written.
7. `loadCommandConfig` ignores configs outside the extension directory.
8. Template parses to `{ commands: { rm: 3 }, separators: ["&&", "||", ";"] }`.

## Decisions log

- Regenerate does not create or delete `.bak`; existing backups are left alone.
- Malformed configs offer regenerate (same confirm flow as up-to-date).
- Both reads and writes are restricted to the single extension directory; the
  multi-directory search is removed rather than kept for local dev.
- A generated template is complete, so it is "up to date" from the start and a
  second `/parcom config` goes straight to the regenerate offer.

## Verification

```bash
npm run typecheck
npm run lint
npm test
git diff --stat
```
