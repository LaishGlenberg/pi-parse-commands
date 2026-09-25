import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCommandConfig, parseCommandConfigContent } from "../config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
		const directory = mkdtempSync(join(tmpdir(), "pi-parse-commands-config-"));
		temporaryDirectories.push(directory);
		writeFileSync(join(directory, "config.jsonc"), '{"commands":{"node":1}}');
		writeFileSync(join(directory, "config.yaml"), "commands:\n  node: 3\n");
		expect(loadCommandConfig(directory)).toEqual({ commands: { node: 1 }, separators: ["&&", "||", ";"] });
	});
});
