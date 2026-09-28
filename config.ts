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

function parseRawConfig(content: string, filename: string): unknown {
	const extension = path.extname(filename).toLowerCase();
	return extension === ".yaml" || extension === ".yml" ? parseYaml(content) : parseJsonc(content);
}

export function parseCommandConfigContent(content: string, filename = "config.jsonc"): CommandHighlightConfig {
	return normalizeConfig(parseRawConfig(content, filename));
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

// ---------------------------------------------------------------------------
// Config migration
// ---------------------------------------------------------------------------

/**
 * A top-level option introduced after the config format was first released.
 *
 * Features are detected by inspecting the parsed document rather than a schema
 * version, so an existing config never has to be rewritten just to bump a
 * number. Add an entry here when a new top-level option gains a default.
 */
interface ConfigFeature {
	/** Top-level key to add when missing. */
	key: string;
	/** Value inserted into JSON/JSONC configs. */
	defaultValue: unknown;
	/** YAML block appended to YAML configs. */
	yamlBlock: string;
}

const CONFIG_FEATURES: readonly ConfigFeature[] = [
	{
		key: "separators",
		defaultValue: [...DEFAULT_SEPARATORS],
		yamlBlock: `separators:\n${DEFAULT_SEPARATORS.map((separator) => `  - "${separator}"`).join("\n")}`,
	},
];

export interface ConfigMigrationResult {
	/** Path of the migrated config file. */
	path: string;
	/** Path of the backup written before the config was edited. */
	backupPath: string;
	/** Top-level keys that were added. */
	added: string[];
}

/** Top-level options missing from a parsed config document, in registry order. */
export function findMissingConfigFeatures(content: string, filename = "config.jsonc"): string[] {
	const parsed = parseRawConfig(content, filename);
	if (!isRecord(parsed)) return [];
	return CONFIG_FEATURES.filter((feature) => !(feature.key in parsed)).map((feature) => feature.key);
}

interface JsonObjectBounds {
	/** Index of the root `{`. */
	open: number;
	/** Index of the matching root `}`. */
	close: number;
	/** Index of the last significant character inside the object (`open` when empty). */
	lastContent: number;
}

/** Locate the root JSON/JSONC object while ignoring strings, comments, and nesting. */
function findRootJsonObject(content: string): JsonObjectBounds | undefined {
	let open = -1;
	let depth = 0;
	let lastContent = -1;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index++) {
		const char = content[index];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') {
				inString = false;
				lastContent = index;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			lastContent = index;
			continue;
		}

		if (char === "/" && content[index + 1] === "/") {
			while (index < content.length && content[index] !== "\n") index++;
			continue;
		}

		if (char === "/" && content[index + 1] === "*") {
			index += 2;
			while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) index++;
			index++;
			continue;
		}

		if (char === "{" || char === "[") {
			if (char === "{" && depth === 0 && open === -1) open = index;
			depth++;
			lastContent = index;
			continue;
		}

		if (char === "}" || char === "]") {
			if (depth > 0) depth--;
			if (depth === 0 && open !== -1) return { open, close: index, lastContent };
			lastContent = index;
			continue;
		}

		if (!/\s/.test(char)) lastContent = index;
	}

	return undefined;
}

/**
 * Insert new options before the root close brace.
 *
 * Editing the text in place keeps user comments and formatting; re-serializing
 * the parsed document would discard both.
 */
function insertJsonFeatures(content: string, features: readonly ConfigFeature[]): string {
	const bounds = findRootJsonObject(content);
	if (!bounds) throw new Error("config is not a JSON object");

	const lines = features.map((feature) => `  ${JSON.stringify(feature.key)}: ${JSON.stringify(feature.defaultValue)}`);
	const isEmpty = bounds.lastContent <= bounds.open;
	// An empty object needs a leading newline and none of the trailing whitespace
	// handling; a populated object reuses whatever precedes the root brace.
	const insertion = `${isEmpty ? "" : ","}\n${lines.join(",\n")}${isEmpty ? "\n" : ""}`;
	const insertAt = bounds.lastContent + 1;
	return content.slice(0, insertAt) + insertion + content.slice(insertAt);
}

/** Append new top-level options as a YAML block. */
function appendYamlFeatures(content: string, features: readonly ConfigFeature[]): string {
	const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	return `${content}${prefix}${features.map((feature) => feature.yamlBlock).join("\n")}\n`;
}

/**
 * Add newly introduced top-level options to the first config file found.
 *
 * Returns `undefined` when no config exists (the extension never creates one),
 * when the config already contains every known option (making this idempotent),
 * or when the file cannot be read, parsed, or written. A `.bak` copy of the
 * original file is written before the config is edited.
 */
export function migrateCommandConfig(configDirectory?: string): ConfigMigrationResult | undefined {
	const directories = configDirectory ? [configDirectory] : defaultConfigDirectories();
	const seen = new Set<string>();

	for (const directory of directories) {
		const normalizedDirectory = path.resolve(directory);
		if (seen.has(normalizedDirectory)) continue;
		seen.add(normalizedDirectory);

		const configPath = findCommandConfigPath(normalizedDirectory);
		if (!configPath) continue;

		let content: string;
		let added: string[];
		try {
			content = fs.readFileSync(configPath, "utf8");
			added = findMissingConfigFeatures(content, configPath);
		} catch (error) {
			console.warn(`[pi-parse-commands] Could not inspect ${configPath} for migration: ${String(error)}`);
			return undefined;
		}
		if (added.length === 0) return undefined;

		const features = CONFIG_FEATURES.filter((feature) => added.includes(feature.key));
		const extension = path.extname(configPath).toLowerCase();
		const migrated =
			extension === ".yaml" || extension === ".yml"
				? appendYamlFeatures(content, features)
				: insertJsonFeatures(content, features);

		const backupPath = `${configPath}.bak`;
		try {
			fs.copyFileSync(configPath, backupPath);
			fs.writeFileSync(configPath, migrated, "utf8");
		} catch (error) {
			console.warn(`[pi-parse-commands] Could not migrate ${configPath}: ${String(error)}`);
			return undefined;
		}

		return { path: configPath, backupPath, added };
	}

	return undefined;
}
