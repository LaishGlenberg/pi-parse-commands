import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

/**
 * The single directory where command config files live.
 *
 * Defaults to `<PI_CODING_AGENT_DIR or ~/.pi/agent>/extensions/pi-parse-commands-config`.
 * Tests and embedders can override it explicitly; reads and writes always use
 * this one directory so the config has a predictable home.
 */
export function extensionConfigDirectory(configDirectory?: string): string {
	if (configDirectory) return configDirectory;
	const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDirectory, "extensions", CONFIG_DIRECTORY_NAME);
}

/**
 * Resolve the config file an explicit config action should target.
 *
 * Returns the first existing supported file, or the path a new `config.jsonc`
 * would be created at when the directory has no config yet.
 */
export function extensionConfigPath(configDirectory?: string): string {
	const directory = extensionConfigDirectory(configDirectory);
	return findCommandConfigPath(directory) ?? path.join(directory, CONFIG_FILENAMES[0]);
}

/** Write config contents, creating the parent directory when needed. */
export function saveCommandConfig(content: string, configPath: string): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, content, "utf8");
}

/** Starter JSONC shown by `/parcom config` when no config file exists yet. */
export const DEFAULT_CONFIG_TEMPLATE = `{
  // 0 = green, 1 = yellow, 2 = orange, 3 = red
  "commands": {
    "rm": 3
  },
  // List operators that start a new breakdown line.
  // Defaults to the three below; add any of "|&", "|", "&" to opt in.
  "separators": ["&&", "||", ";"]
}
`;

/**
 * Load the config from the extension config directory. JSONC and YAML are supported.
 *
 * Missing, unreadable, or malformed files fall back to the built-in defaults;
 * this never creates or modifies a file.
 */
export function loadCommandConfig(configDirectory?: string): CommandHighlightConfig {
	const configPath = findCommandConfigPath(extensionConfigDirectory(configDirectory));
	if (!configPath) return { ...EMPTY_CONFIG, commands: {} };
	try {
		return parseCommandConfigContent(fs.readFileSync(configPath, "utf8"), configPath);
	} catch (error) {
		console.warn(`[pi-parse-commands] Could not load ${configPath}: ${String(error)}`);
		return { ...EMPTY_CONFIG, commands: {} };
	}
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
	// A JSONC object may already end with a trailing comma. Reuse it instead of
	// emitting a second one, and skip the separator entirely for an empty object.
	const hasTrailingComma = content[bounds.lastContent] === ",";
	const separator = isEmpty || hasTrailingComma ? "" : ",";
	const insertion = `${separator}\n${lines.join(",\n")}${isEmpty ? "\n" : ""}`;
	const insertAt = bounds.lastContent + 1;
	return content.slice(0, insertAt) + insertion + content.slice(insertAt);
}

/** Append new top-level options as a YAML block. */
function appendYamlFeatures(content: string, features: readonly ConfigFeature[]): string {
	const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	return `${content}${prefix}${features.map((feature) => feature.yamlBlock).join("\n")}\n`;
}

/**
 * Add newly introduced top-level options to an existing config file in place.
 *
 * Reads `configPath`, writes a `.bak` copy, inserts the requested options while
 * preserving comments and formatting, and writes the result back. Returns the
 * config path and throws when the file cannot be read, parsed, or written.
 */
export function applyCommandConfigMigration(configPath: string, keys: readonly string[]): string {
	const missing = CONFIG_FEATURES.filter((feature) => keys.includes(feature.key));
	const content = fs.readFileSync(configPath, "utf8");
	const extension = path.extname(configPath).toLowerCase();
	const migrated =
		extension === ".yaml" || extension === ".yml"
			? appendYamlFeatures(content, missing)
			: insertJsonFeatures(content, missing);

	fs.copyFileSync(configPath, `${configPath}.bak`);
	fs.writeFileSync(configPath, migrated, "utf8");
	return configPath;
}
