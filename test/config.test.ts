import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommandConfig, parseCommandConfigContent } from "../config.ts";

const DEFAULT_SEPARATORS = ["&&", "||", ";"];

const temporaryDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

function emptyConfig(): { commands: Record<string, number>; separators: string[] } {
	return { commands: {}, separators: [...DEFAULT_SEPARATORS] };
}

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-parse-commands-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	restoreEnv("HOME", originalHome);
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDirectory);
});

describe("command highlight config", () => {
	it("parses JSONC comments and trailing commas", () => {
		expect(
			parseCommandConfigContent(
				`{
					// destructive commands
					"commands": {
						"node": 1,
						"rm": 3,
					},
				}`,
				"config.jsonc",
			),
		).toEqual({ commands: { node: 1, rm: 3 }, separators: ["&&", "||", ";"] });
	});

	it("parses YAML configs", () => {
		expect(
			parseCommandConfigContent(
				"commands:\n  node: 1\n  rg: 2\n",
				"config.yaml",
			),
		).toEqual({ commands: { node: 1, rg: 2 }, separators: ["&&", "||", ";"] });
	});

	it("ignores invalid color levels", () => {
		expect(
			parseCommandConfigContent('{"commands":{"negative":-1,"fraction":1.5,"tooHigh":4,"ok":0}}'),
		).toEqual({ commands: { ok: 0 }, separators: ["&&", "||", ";"] });
	});

	it("parses a custom separator list", () => {
		expect(
			parseCommandConfigContent('{"separators":["&&","|","&"]}'),
		).toEqual({ commands: {}, separators: ["&&", "|", "&"] });
	});

	it("drops unknown and duplicate separators", () => {
		expect(
			parseCommandConfigContent('{"separators":["&&","&&","&&&","|"]}'),
		).toEqual({ commands: {}, separators: ["&&", "|"] });
	});

	it("honors an explicit empty separator list", () => {
		expect(parseCommandConfigContent('{"separators":[]}')).toEqual({ commands: {}, separators: [] });
	});

	it("falls back to the default separators for non-array values", () => {
		expect(parseCommandConfigContent('{"separators":"|"}')).toEqual({ commands: {}, separators: ["&&", "||", ";"] });
	});

	it("loads the first supported config file from a directory", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(join(directory, "config.jsonc"), '{"commands":{"node":1}}');
		writeFileSync(join(directory, "config.yaml"), "commands:\n  node: 3\n");
		expect(loadCommandConfig(directory)).toEqual({ commands: { node: 1 }, separators: ["&&", "||", ";"] });
	});
});

describe("config content scanner", () => {
	it("strips block comments", () => {
		expect(parseCommandConfigContent('{/* destructive */"commands":{"node":3}}')).toEqual({
			commands: { node: 3 },
			separators: ["&&", "||", ";"],
		});
	});

	it("keeps comment markers inside string values", () => {
		expect(parseCommandConfigContent('{"commands":{"http://x":1,"/*not*/":2}}')).toEqual({
			commands: { "http://x": 1, "/*not*/": 2 },
			separators: ["&&", "||", ";"],
		});
	});

	it("keeps escaped quotes and comment markers inside strings", () => {
		expect(parseCommandConfigContent('{"commands":{"a\\"//b":3}}')).toEqual({
			commands: { 'a"//b': 3 },
			separators: ["&&", "||", ";"],
		});
	});

	it("keeps commas inside strings while stripping trailing commas", () => {
		expect(parseCommandConfigContent('{"commands":{"a,}":1,},}')).toEqual({
			commands: { "a,}": 1 },
			separators: ["&&", "||", ";"],
		});
	});

	it("strips trailing commas before closing brackets", () => {
		expect(parseCommandConfigContent('{"separators":["&&",],}')).toEqual({
			commands: {},
			separators: ["&&"],
		});
	});

	it("selects the parser by extension case-insensitively", () => {
		expect(parseCommandConfigContent("commands:\n  node: 1\n", "CONFIG.YAML")).toEqual({
			commands: { node: 1 },
			separators: ["&&", "||", ";"],
		});
	});
});

describe("config normalization boundaries", () => {
	it("accepts level 3 and rejects non-integer or non-numeric levels", () => {
		expect(parseCommandConfigContent('{"commands":{"max":3,"string":"1","null":null,"float":2.0}}')).toEqual({
			commands: { max: 3, float: 2 },
			separators: ["&&", "||", ";"],
		});
	});

	it("accepts the optional pipe and background separators", () => {
		expect(parseCommandConfigContent('{"separators":["|&","&","|"]}')).toEqual({
			commands: {},
			separators: ["|&", "&", "|"],
		});
	});

	it("falls back to defaults when the document is not an object", () => {
		expect(parseCommandConfigContent("[1,2,3]")).toEqual(emptyConfig());
		expect(parseCommandConfigContent("null")).toEqual(emptyConfig());
	});

	it("ignores a non-object commands value", () => {
		expect(parseCommandConfigContent('{"commands":["node"]}')).toEqual(emptyConfig());
	});

	it("ignores empty command names", () => {
		expect(parseCommandConfigContent('{"commands":{"":1,"node":2}}')).toEqual({
			commands: { node: 2 },
			separators: ["&&", "||", ";"],
		});
	});
});

describe("config file loading", () => {
	it("returns an empty config when the directory has no config file", () => {
		expect(loadCommandConfig(createTemporaryDirectory())).toEqual(emptyConfig());
	});

	it("returns an empty config for a missing directory", () => {
		expect(loadCommandConfig(join(tmpdir(), "pi-parse-commands-missing", "nested"))).toEqual(emptyConfig());
	});

	it("ignores a directory named like a config file", () => {
		const directory = createTemporaryDirectory();
		mkdirSync(join(directory, "config.jsonc"));
		writeFileSync(join(directory, "config.yaml"), "commands:\n  node: 2\n");
		expect(loadCommandConfig(directory)).toEqual({ commands: { node: 2 }, separators: ["&&", "||", ";"] });
	});

	it("prefers json over yaml and yaml over yml", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(join(directory, "config.yml"), "commands:\n  node: 4\n");
		writeFileSync(join(directory, "config.yaml"), "commands:\n  node: 3\n");
		writeFileSync(join(directory, "config.json"), '{"commands":{"node":2}}');
		expect(loadCommandConfig(directory)).toEqual({ commands: { node: 2 }, separators: ["&&", "||", ";"] });
	});

	it("uses config.yml when it is the only config file", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(join(directory, "config.yml"), "commands:\n  node: 3\n");
		expect(loadCommandConfig(directory)).toEqual({ commands: { node: 3 }, separators: ["&&", "||", ";"] });
	});

	it("treats an empty yaml file as the default config", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(join(directory, "config.yaml"), "");
		expect(loadCommandConfig(directory)).toEqual(emptyConfig());
	});

	it("warns and returns an empty config for malformed json", () => {
		const directory = createTemporaryDirectory();
		const configPath = join(directory, "config.jsonc");
		writeFileSync(configPath, "{ not valid json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadCommandConfig(directory)).toEqual(emptyConfig());
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain(configPath);
	});

	it("warns and returns an empty config for malformed yaml", () => {
		const directory = createTemporaryDirectory();
		const configPath = join(directory, "config.yaml");
		writeFileSync(configPath, "commands: {node: 1");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadCommandConfig(directory)).toEqual(emptyConfig());
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain(configPath);
	});
});

describe("default config directories", () => {
	it("honors PI_CODING_AGENT_DIR", () => {
		const agentDirectory = createTemporaryDirectory();
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		const configDirectory = join(agentDirectory, "extensions", "pi-parse-commands-config");
		mkdirSync(configDirectory, { recursive: true });
		writeFileSync(join(configDirectory, "config.jsonc"), '{"commands":{"node":1}}');
		expect(loadCommandConfig()).toEqual({ commands: { node: 1 }, separators: ["&&", "||", ";"] });
	});

	it("falls back to HOME/.pi/agent when PI_CODING_AGENT_DIR is unset", () => {
		const home = createTemporaryDirectory();
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = home;
		const configDirectory = join(home, ".pi", "agent", "extensions", "pi-parse-commands-config");
		mkdirSync(configDirectory, { recursive: true });
		writeFileSync(join(configDirectory, "config.yaml"), "commands:\n  rg: 2\n");
		expect(loadCommandConfig()).toEqual({ commands: { rg: 2 }, separators: ["&&", "||", ";"] });
	});
});
