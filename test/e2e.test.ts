/**
 * Opt-in end-to-end install test.
 *
 * Run with:
 *
 *   PI_E2E=1 npm run test:e2e
 *
 * Unlike `test/package.test.ts` (which installs into an isolated
 * `PI_CODING_AGENT_DIR`), this test exercises the *real* agent directory:
 *
 *   1. `pi install npm:@lglen/pi-parse-commands`
 *   2. Repoint `settings.json` away from the local symlinked checkout
 *      (`extensions/pi-parse-commands`) and at the npm-installed copy under
 *      `<agentDir>/npm/node_modules/@lglen/pi-parse-commands`.
 *   3. Run a smoke prompt that explicitly loads the installed extension and
 *      must finish with `SUCCESS`.
 *   4. On success, `pi uninstall npm:@lglen/pi-parse-commands` and restore the
 *      original `settings.json`.
 *
 * It mutates `~/.pi/agent/settings.json` and calls a real model, so it is
 * skipped unless `PI_E2E=1`. The original file is snapshotted first and
 * restored in `afterAll`; a `.e2e-backup` copy is written as a crash-safety
 * net and removed after a clean restore.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.PI_E2E === "1";

const PI_BIN = process.env.PI_BIN ?? "pi";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");
const backupPath = `${settingsPath}.e2e-backup`;

const packageSource = "npm:@lglen/pi-parse-commands";
const installedExtensionDir = join(agentDir, "npm", "node_modules", "@lglen", "pi-parse-commands");
const symlinkEntry = "+extensions/pi-parse-commands/index.ts";
const npmEntry = "+npm/node_modules/@lglen/pi-parse-commands/index.ts";

const smokeArgs = [
	"-ns",
	"-ne",
	"-nc",
	"--no-session",
	"-t",
	"bash",
	"--model",
	"opencode-go/mimo-v2.5:off",
	"--system-prompt",
	"you are a very simple smoke testing agent who runs some commands and returns",
	"--extension",
	installedExtensionDir,
	"-p",
	"run some chained bash commands that make use of &&, ||, and ;. Then finish and give your output, include 'SUCCESS' at the end of your message. Run commands quickly, dont dilly dally.",
];

interface Settings {
	extensions?: string[];
	packages?: unknown[];
	[key: string]: unknown;
}

function runPi(args: string[], timeout: number) {
	return spawnSync(PI_BIN, args, {
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env },
	});
}

function formatResult(result: ReturnType<typeof runPi>): string {
	return [
		`status: ${result.status}`,
		result.error ? `error: ${result.error.message}` : "",
		`stdout:\n${result.stdout ?? ""}`,
		`stderr:\n${result.stderr ?? ""}`,
	]
		.filter(Boolean)
		.join("\n");
}

function readSettings(): Settings {
	return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
}

function pointSettingsAtNpmCopy(): void {
	const settings = readSettings();
	const extensions = Array.isArray(settings.extensions) ? [...settings.extensions] : [];
	const index = extensions.indexOf(symlinkEntry);
	if (index >= 0) extensions[index] = npmEntry;
	else if (!extensions.includes(npmEntry)) extensions.push(npmEntry);
	settings.extensions = extensions;
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

describe.skipIf(!ENABLED)("e2e: install, load, and uninstall from npm", () => {
	let originalSettings: string | null = null;

	beforeAll(() => {
		if (!existsSync(settingsPath)) {
			throw new Error(`settings file not found: ${settingsPath}`);
		}
		originalSettings = readFileSync(settingsPath, "utf8");
		writeFileSync(backupPath, originalSettings, { mode: 0o600 });
	});

	afterAll(() => {
		if (originalSettings !== null) {
			writeFileSync(settingsPath, originalSettings);
		}
		if (existsSync(backupPath)) {
			rmSync(backupPath, { force: true });
		}
	});

	it("installs the published package, runs the smoke prompt, then uninstalls and restores settings", () => {
		const install = runPi(["install", packageSource], 180_000);
		expect(install.status, `pi install failed\n${formatResult(install)}`).toBe(0);

		// The npm install must have left the settings pointing at the package.
		const installedSettings = readSettings();
		expect(installedSettings.packages ?? []).toContain(packageSource);

		pointSettingsAtNpmCopy();

		const smoke = runPi(smokeArgs, 240_000);
		const timedOut = (smoke.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
		const output = formatResult(smoke);
		const succeeded = !timedOut && smoke.status === 0 && (smoke.stdout ?? "").includes("SUCCESS");

		if (succeeded) {
			const uninstall = runPi(["uninstall", packageSource], 120_000);
			expect(uninstall.status, `pi uninstall failed\n${formatResult(uninstall)}`).toBe(0);
		}

		expect(timedOut, `smoke command timed out\n${output}`).toBe(false);
		expect(smoke.status, `smoke command exited non-zero\n${output}`).toBe(0);
		expect(smoke.stdout ?? "", `smoke command did not print SUCCESS\n${output}`).toContain("SUCCESS");
	});
});
