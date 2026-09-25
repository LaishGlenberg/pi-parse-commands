/**
 * Package / install smoke tests.
 *
 * These verify the thing that gets published, not just the extension logic:
 *   1. `package.json` declares the scoped name, public access, and the pi
 *      extension manifest.
 *   2. `npm pack` produces a tarball with exactly the intended files and none
 *      of the repository-only files.
 *   3. The packed `index.ts` is byte-identical to the source entry point.
 *   4. The packed package can be installed by the real `pi` CLI into an
 *      isolated config directory and shows up in `pi list`.
 *
 * The install test uses the `pi` binary from devDependencies and a throwaway
 * `PI_CODING_AGENT_DIR` so the developer's own settings are never touched.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const packageJsonPath = join(repoRoot, "package.json");

interface PackageJson {
	name: string;
	version: string;
	license: string;
	keywords?: string[];
	files?: string[];
	publishConfig?: { access?: string };
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
	engines?: { node?: string };
}

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;

const piBinary = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const piAvailable = existsSync(piBinary);

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		env: { ...process.env, ...options.env },
		encoding: "utf8",
	});
}

describe("package metadata", () => {
	it("uses the public scoped package name", () => {
		expect(pkg.name).toBe("@lglen/pi-parse-commands");
	});

	it("publishes with public access", () => {
		expect(pkg.publishConfig?.access).toBe("public");
	});

	it("is versioned with semver", () => {
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
	});

	it("declares the pi extension manifest", () => {
		expect(pkg.pi?.extensions).toEqual(["./index.ts"]);
	});

	it("is discoverable in the pi package gallery", () => {
		expect(pkg.keywords).toContain("pi-package");
	});

	it("ships the MIT license and a Node engine floor", () => {
		expect(pkg.license).toBe("MIT");
		expect(pkg.engines?.node).toBeTruthy();
	});

	it("declares pi runtime packages as peer dependencies", () => {
		expect(pkg.peerDependencies).toHaveProperty("@earendil-works/pi-coding-agent");
		expect(pkg.peerDependencies).toHaveProperty("@earendil-works/pi-tui");
	});

	it("lists the entry point and docs in the published files", () => {
		expect(pkg.files).toContain("index.ts");
		expect(pkg.files).toContain("docs/**/*.md");
	});
});

describe("npm pack output", () => {
	let workDir: string;
	let tarball: string;
	let extracted: string;
	let tarballEntries: string[];

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "pi-parse-commands-pack-"));
		const filename = run("npm", ["pack", "--pack-destination", workDir, "--loglevel=error"]).trim().split("\n").pop()!;
		tarball = join(workDir, filename);
		extracted = join(workDir, "package");
		run("tar", ["xzf", tarball, "-C", workDir]);
		tarballEntries = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean)
			.map((entry) => entry.replace(/^package\//, ""));
	}, 120_000);

	afterAll(() => {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("names the tarball after the scoped package and version", () => {
		expect(tarball).toContain(`lglen-pi-parse-commands-${pkg.version}.tgz`);
	});

	it.each([
		["package.json", "package.json"],
		["index.ts", "index.ts"],
		["config.ts", "config.ts"],
		["highlight.ts", "highlight.ts"],
		["README.md", "README.md"],
		["CHANGELOG.md", "CHANGELOG.md"],
		["LICENSE", "LICENSE"],
		["docs/development.md", "docs/development.md"],
	])("ships %s", (expected) => {
		expect(tarballEntries).toContain(expected);
	});

	it("does not ship repository-only files", () => {
		const leaked = tarballEntries.filter(
			(entry) =>
				entry.startsWith("test/") ||
				entry.startsWith(".github/") ||
				entry.startsWith("scripts/") ||
				entry.startsWith("node_modules/") ||
				entry === "vitest.config.ts" ||
				entry === "tsconfig.json",
		);
		expect(leaked).toEqual([]);
	});

	it("ships an entry point identical to the source", () => {
		expect(readFileSync(join(extracted, "index.ts"), "utf8")).toBe(readFileSync(join(repoRoot, "index.ts"), "utf8"));
	});

	it("ships the same package metadata that npm publish would read", () => {
		const packed = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8")) as PackageJson;
		expect(packed.name).toBe(pkg.name);
		expect(packed.version).toBe(pkg.version);
		expect(packed.pi?.extensions).toEqual(pkg.pi?.extensions);
	});
});

describe.skipIf(!piAvailable)("pi install smoke test", () => {
	let workDir: string;
	let agentDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "pi-parse-commands-install-"));
		agentDir = join(workDir, "agent");

		const filename = run("npm", ["pack", "--pack-destination", workDir, "--loglevel=error"]).trim().split("\n").pop()!;
		run("tar", ["xzf", join(workDir, filename), "-C", workDir]);
	}, 120_000);

	afterAll(() => {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("installs the packed package with the pi CLI", () => {
		const result = spawnSync(piBinary, ["install", join(workDir, "package"), "--no-approve"], {
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("Installed");
	});

	it("records the package in the isolated settings file", () => {
		const settingsPath = join(agentDir, "settings.json");
		expect(existsSync(settingsPath)).toBe(true);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown[] };
		expect(settings.packages?.length).toBe(1);
	});

	it("lists the installed package through the pi CLI", () => {
		const result = spawnSync(piBinary, ["list"], {
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		});
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain(resolve(workDir, "package"));
	});
});
