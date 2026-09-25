import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export type CommandColorLevel = 0 | 1 | 2 | 3;

/** List operators enabled by default. Newlines always split regardless of this list. */
export const DEFAULT_SEPARATORS: readonly string[] = ["&&", "||", ";"];

/** Extra list operators a config may opt into. */
export const OPTIONAL_SEPARATORS: readonly string[] = ["|&", "|", "&"];

const KNOWN_SEPARATORS = new Set<string>([...DEFAULT_SEPARATORS, ...OPTIONAL_SEPARATORS]);

export interface CommandHighlightConfig {
	commands: Record<string, CommandColorLevel>;
	/**
	 * List operators that produce a new breakdown line.
	 *
	 * Defaults to `["&&", "||", ";"]`. Add any of the optional operators
	 * `"|&"`, `"|"`, `"&"` to also split on those. Newlines always split.
	 */
	separators?: string[];
}

const CONFIG_DIRECTORY_NAME = "pi-parse-commands-config";
const CONFIG_FILENAMES = ["config.jsonc", "config.json", "config.yaml", "config.yml"] as const;
const EMPTY_CONFIG: CommandHighlightConfig = { commands: {}, separators: [...DEFAULT_SEPARATORS] };

/** Keep only recognized, de-duplicated operator names. Returns `undefined` for non-arrays. */
export function normalizeSeparators(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const seen = new Set<string>();
	const separators: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !KNOWN_SEPARATORS.has(entry) || seen.has(entry)) continue;
		seen.add(entry);
		separators.push(entry);
	}
	return separators;
}

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
	const commands: Record<string, CommandColorLevel> = {};
	if (isRecord(value) && isRecord(value.commands)) {
		for (const [command, level] of Object.entries(value.commands)) {
			if (!command || typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 3) continue;
			commands[command] = level as CommandColorLevel;
		}
	}

	// An explicit empty list is honored (newline-only splitting); a missing list falls back to defaults.
	const separators = normalizeSeparators(isRecord(value) ? value.separators : undefined) ?? [...DEFAULT_SEPARATORS];
	return { commands, separators };
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
		path.join(agentDirectory, "extensions", CONFIG_DIRECTORY_NAME),
		path.join(os.homedir(), ".pi", "agent", "extensions", CONFIG_DIRECTORY_NAME),
		// Also support a sibling config directory when the extension is checked out locally
		// or installed as a folder under an extensions directory.
		path.join(moduleDirectory, "..", CONFIG_DIRECTORY_NAME),
		path.join(moduleDirectory, CONFIG_DIRECTORY_NAME),
		path.join(process.cwd(), CONFIG_DIRECTORY_NAME),
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
