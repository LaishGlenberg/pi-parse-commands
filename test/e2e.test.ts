/**
 * Opt-in end-to-end install test.
 *
 * Run with:
 *
 *   npm run test:e2e
 *
 * Unlike `test/package.test.ts` (which installs into an isolated
 * `PI_CODING_AGENT_DIR`), this test exercises the *real* agent directory and
 * the published npm package:
 *
 *   1. If the package is already installed, uninstall it for a clean slate.
 *   2. `pi install npm:@lglen/pi-parse-commands`.
 *   3. Run a smoke prompt that explicitly loads the installed extension with
 *      `--extension <agentDir>/npm/node_modules/@lglen/pi-parse-commands`. The
 *      command uses `-ne`, so nothing but that explicit path is loaded; the
 *      local symlink (and any configured package) is ignored.
 *   4. Fail if the command errors, times out, or does not print `SUCCESS`.
 *   5. On success, `pi uninstall npm:@lglen/pi-parse-commands`.
 *
 * The expected resting state is "package not installed; only the symlink is
 * configured". Nothing is backed up or edited by hand: install/uninstall are
 * symmetric, and a leftover install from a previous failed run is removed in
 * step 1. It calls a real model and is excluded from the default vitest config,
 * so it only runs through `npm run test:e2e`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PI_BIN = process.env.PI_BIN ?? "pi";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");

const packageSource = "npm:@lglen/pi-parse-commands";
const installedExtensionDir = join(agentDir, "npm", "node_modules", "@lglen", "pi-parse-commands");

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

function isPackageConfigured(): boolean {
	if (!existsSync(settingsPath)) return false;
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
	return (settings.packages ?? []).some((entry) =>
		typeof entry === "string" ? entry === packageSource : (entry as { source?: string }).source === packageSource,
	);
}

describe("e2e: install, load, and uninstall from npm", () => {
	it("installs the published package from a clean slate, runs the smoke prompt, then uninstalls", () => {
		// Clean slate: a previous failed run may have left the package installed.
		if (isPackageConfigured()) {
			const cleanup = runPi(["uninstall", packageSource], 120_000);
			expect(cleanup.status, `pre-clean uninstall failed\n${formatResult(cleanup)}`).toBe(0);
		}

		const install = runPi(["install", packageSource], 180_000);
		expect(install.status, `pi install failed\n${formatResult(install)}`).toBe(0);
		expect(isPackageConfigured()).toBe(true);

		const smoke = runPi(smokeArgs, 240_000);
		const timedOut = (smoke.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
		const output = formatResult(smoke);
		const succeeded = !timedOut && smoke.status === 0 && (smoke.stdout ?? "").includes("SUCCESS");

		if (succeeded) {
			const uninstall = runPi(["uninstall", packageSource], 120_000);
			expect(uninstall.status, `pi uninstall failed\n${formatResult(uninstall)}`).toBe(0);
			expect(isPackageConfigured()).toBe(false);
		}

		expect(timedOut, `smoke command timed out\n${output}`).toBe(false);
		expect(smoke.status, `smoke command exited non-zero\n${output}`).toBe(0);
		expect(smoke.stdout ?? "", `smoke command did not print SUCCESS\n${output}`).toContain("SUCCESS");
	});
});
