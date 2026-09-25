import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export type CommandColorLevel = 0 | 1 | 2 | 3;

export interface CommandHighlightConfig {
	commands: Record<string, CommandColorLevel>;
}

const CONFIG_FILENAMES = ["config.jsonc", "config.json", "config.yaml", "config.yml"] as const;
const EMPTY_CONFIG: CommandHighlightConfig = { commands: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove JSONC comments without changing text inside quoted strings. */
function stripJsonComments(content: string): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index++) {
		const char = content[index];
		const next = content[index + 1];

		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			result += char;
		} else if (char === "/" && next === "/") {
			index += 1;
			while (index + 1 < content.length && content[index + 1] !== "\n") index += 1;
		} else if (char === "/" && next === "*") {
			index += 1;
			while (index + 1 < content.length && !(content[index + 1] === "*" && content[index + 2] === "/")) index += 1;
			index += 2;
		} else {
			result += char;
		}
	}

	return result;
}

/** Remove trailing commas while preserving commas inside quoted strings. */
function stripTrailingCommas(content: string): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index++) {
		const char = content[index];
		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}

		if (char === ",") {
			let next = index + 1;
			while (/\s/.test(content[next] ?? "")) next += 1;
			if (content[next] === "}" || content[next] === "]") continue;
		}
		result += char;
	}

	return result;
}

function parseJsonc(content: string): unknown {
	return JSON.parse(stripTrailingCommas(stripJsonComments(content)));
}

function normalizeConfig(value: unknown): CommandHighlightConfig {
	if (!isRecord(value) || !isRecord(value.commands)) return { ...EMPTY_CONFIG, commands: {} };

	const commands: Record<string, CommandColorLevel> = {};
	for (const [command, level] of Object.entries(value.commands)) {
		if (!command || typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 3) continue;
		commands[command] = level as CommandColorLevel;
	}
	return { commands };
}

export function parseCommandConfigContent(content: string, filename = "config.jsonc"): CommandHighlightConfig {
	const extension = path.extname(filename).toLowerCase();
	const parsed = extension === ".yaml" || extension === ".yml" ? parseYaml(content) : parseJsonc(content);
	return normalizeConfig(parsed);
}

export function findCommandConfigPath(configDirectory: string): string | undefined {
	for (const filename of CONFIG_FILENAMES) {
		const candidate = path.join(configDirectory, filename);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

function defaultConfigDirectories(): string[] {
	const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
	const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return [
		path.join(agentDirectory, "extensions", "pi-parse-commands"),
		path.join(os.homedir(), ".pi", "agent", "extensions", "pi-parse-commands"),
		moduleDirectory,
		path.join(moduleDirectory, "pi-parse-commands"),
		path.join(process.cwd(), "pi-parse-commands"),
	];
}

/** Load the first config file found. JSONC and YAML are supported. */
export function loadCommandConfig(configDirectory?: string): CommandHighlightConfig {
	const directories = configDirectory ? [configDirectory] : defaultConfigDirectories();
	const seen = new Set<string>();

	for (const directory of directories) {
		const normalizedDirectory = path.resolve(directory);
		if (seen.has(normalizedDirectory)) continue;
		seen.add(normalizedDirectory);

		const configPath = findCommandConfigPath(normalizedDirectory);
		if (!configPath) continue;
		try {
			return parseCommandConfigContent(fs.readFileSync(configPath, "utf8"), configPath);
		} catch (error) {
			console.warn(`[pi-parse-commands] Could not load ${configPath}: ${String(error)}`);
			return { ...EMPTY_CONFIG, commands: {} };
		}
	}

	return { ...EMPTY_CONFIG, commands: {} };
}
