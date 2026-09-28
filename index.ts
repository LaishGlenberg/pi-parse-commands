/**
 * Pi Parse Commands Extension
 *
 * Modern coding agents emit dense chained shell commands, e.g.
 *
 *   cd /repo && rg -c "foo" out.json; rg -c "bar" out.json | wc -l
 *
 * The default bash renderer prints that as one long line, which makes it hard
 * to see the individual commands that actually ran. This extension overrides
 * the built-in `bash` tool renderer (execution behavior is untouched) and adds
 * a nested box below the command line that lists every command separately.
 *
 * The parser understands single/double quotes, backslash escapes, comments,
 * and redirections (`2>&1`, `&>`, `>&2`) so those do not produce bogus splits.
 * Command substitution, here-docs, and `case` statements are parsed naively.
 *
 * Usage:
 *   pi -e ./index.ts
 */

import { existsSync, readFileSync } from "node:fs";
import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG_TEMPLATE,
	DEFAULT_SEPARATORS,
	loadCommandConfig,
	migrateCommandConfig,
	normalizeSeparators,
	parseCommandConfigContent,
	resolveCommandConfigPath,
	saveCommandConfig,
	type CommandHighlightConfig,
} from "./config.ts";
import { highlightCommandText, highlightShellCommand } from "./highlight.ts";

/** Hard cap on how many parsed commands are drawn in the breakdown box. */
export const MAX_BREAKDOWN_COMMANDS = 25;

export interface ShellCommandSegment {
	/** The command text, trimmed. */
	command: string;
	/** The list operator that terminates this command (`&&`, `||`, `;`, or an optional one). Undefined for the last command. */
	operator?: string;
}

const OPERATOR_LABELS = new Set(["&&", "||", "|&", "|", ";", "&"]);

/**
 * Detect a command-list operator at `index` when it is enabled.
 *
 * Returns the operator length, or `undefined` when the character is not an
 * enabled separator. `&` requires extra care because it is also part of
 * redirections (`2>&1`, `>&2`, `&>file`) which must not be split.
 */
function matchOperatorLength(text: string, index: number, separators: ReadonlySet<string>): number | undefined {
	const ch = text[index];
	const next = text[index + 1];

	if (ch === "&" && next === "&") return separators.has("&&") ? 2 : undefined;
	if (ch === "|" && next === "|") return separators.has("||") ? 2 : undefined;
	if (ch === "|" && next === "&") return separators.has("|&") ? 2 : undefined;
	if (ch === "|") {
		// Do not split the tail of a disabled `||`.
		if (text[index - 1] === "|") return undefined;
		return separators.has("|") ? 1 : undefined;
	}
	if (ch === ";") return separators.has(";") ? 1 : undefined;
	if (ch === "\n") return 1;
	if (ch === "&") {
		// Do not split the tail of a disabled `&&` or `|&`.
		if (text[index - 1] === "&" || text[index - 1] === "|") return undefined;
		if (!separators.has("&")) return undefined;
		// `&>`, `&>>` are redirections, not background separators.
		if (next === ">") return undefined;
		// `2>&1`, `>&2`, `<&0` end with `&` preceded by a redirection.
		let prev = index - 1;
		while (prev >= 0 && (text[prev] === " " || text[prev] === "\t")) prev--;
		if (prev >= 0 && (text[prev] === ">" || text[prev] === "<")) return undefined;
		return 1;
	}
	return undefined;
}

/** A `#` starts a comment when it begins a word (whitespace or a shell separator precedes it). */
function isCommentStart(text: string, index: number): boolean {
	if (index === 0) return true;
	const prev = text[index - 1];
	return /\s/.test(prev) || prev === ";" || prev === "&" || prev === "|" || prev === "(" || prev === ")";
}

/**
 * Split a shell command line into the individual commands that will run.
 *
 * Splits on the enabled `separators` (default `&&`, `||`, `;`) plus newlines.
 * Pass optional operators such as `|&`, `|`, and `&` to split on those too.
 * Separators inside single/double quotes, escaped separators, comments, and
 * redirections are preserved as part of the surrounding command.
 */
export function parseShellCommands(
	command: string,
	separators: readonly string[] = DEFAULT_SEPARATORS,
): ShellCommandSegment[] {
	const enabledSeparators = new Set(normalizeSeparators(separators) ?? DEFAULT_SEPARATORS);
	const segments: ShellCommandSegment[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	const flush = (operator?: string) => {
		const trimmed = current.trim();
		current = "";
		if (!trimmed) return;
		segments.push(operator && OPERATOR_LABELS.has(operator) ? { command: trimmed, operator } : { command: trimmed });
	};

	let i = 0;
	while (i < command.length) {
		const ch = command[i];

		if (escaped) {
			current += ch;
			escaped = false;
			i++;
			continue;
		}

		// Backslash escapes the next character everywhere except inside single quotes.
		if (ch === "\\" && !inSingleQuote) {
			current += ch;
			escaped = true;
			i++;
			continue;
		}

		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += ch;
			i++;
			continue;
		}

		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current += ch;
			i++;
			continue;
		}

		if (!inSingleQuote && !inDoubleQuote) {
			if (ch === "#" && isCommentStart(command, i)) {
				// Skip the comment body; the trailing newline (if any) is handled next iteration.
				while (i < command.length && command[i] !== "\n") i++;
				continue;
			}

			const operatorLength = matchOperatorLength(command, i, enabledSeparators);
			if (operatorLength !== undefined) {
				flush(command.slice(i, i + operatorLength));
				i += operatorLength;
				continue;
			}
		}

		current += ch;
		i++;
	}

	flush();
	return segments;
}

/** Convenience wrapper returning just the command strings. */
export function splitShellCommands(command: string): string[] {
	return parseShellCommands(command).map((segment) => segment.command);
}

/** Render one line per command, numbering them and showing the trailing operator. */
export function formatCommandBreakdown(
	segments: ShellCommandSegment[],
	theme: Theme,
	config: CommandHighlightConfig = { commands: {} },
): string {
	const shown = segments.slice(0, MAX_BREAKDOWN_COMMANDS);
	const lines = shown.map((segment, index) => {
		const number = theme.fg("muted", `${index + 1}.`);
		const command = highlightCommandText(segment.command, theme, config);
		const operator = segment.operator ? ` ${theme.fg("dim", segment.operator)}` : "";
		return `${number} ${command}${operator}`;
	});
	if (segments.length > shown.length) {
		lines.push(theme.fg("muted", `... and ${segments.length - shown.length} more`));
	}
	return lines.join("\n");
}

function formatShellCall(
	args: { command?: string; timeout?: number } | undefined,
	theme: Theme,
	config: CommandHighlightConfig,
): string {
	const command = typeof args?.command === "string" ? args.command : "";
	const timeoutSuffix = args?.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
	const display = command
		? highlightShellCommand(command, parseShellCommands(command, config.separators), theme, config)
		: theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${display}`)) + timeoutSuffix;
}

export interface BashCommandBreakdownOptions {
	/** Use an explicit config in tests or embedding applications. */
	config?: CommandHighlightConfig;
	/** Override the directory searched for config.json(c) or config.yaml(yml). */
	configDirectory?: string;
}

/** Slash command name and its session-scoped options. */
const PARCOM_COMMAND = "parcom";
const PARCOM_OPTIONS: readonly AutocompleteItem[] = [
	{ value: "on", label: "on", description: "Enable the command breakdown for this session" },
	{ value: "off", label: "off", description: "Disable the command breakdown for this session" },
	{ value: "config", label: "config", description: "Edit the highlight config in a TUI editor" },
];

/** Rendering config used while the breakdown is disabled: no highlighting or splitting. */
const NO_HIGHLIGHT: CommandHighlightConfig = { commands: {}, separators: [] };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function bashCommandBreakdown(pi: ExtensionAPI, options: BashCommandBreakdownOptions = {}): void {
	// Keep an existing personal config in sync with options added by newer
	// versions (e.g. `separators`) before loading it, so a migrated option takes
	// effect on this load. Skipped when a config is injected directly.
	if (!options.config) migrateCommandConfig(options.configDirectory);
	let config = options.config ?? loadCommandConfig(options.configDirectory);
	// Session-scoped: `/parcom off` suppresses rendering until re-enabled or the session restarts.
	let enabled = true;

	const updateStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(
			PARCOM_COMMAND,
			enabled ? ctx.ui.theme.fg("accent", "parcom:on") : ctx.ui.theme.fg("dim", "parcom:off"),
		);
	};

	const editConfig = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/parcom config requires an interactive UI", "error");
			return;
		}

		const configPath = resolveCommandConfigPath(options.configDirectory);
		let content: string;
		try {
			content = existsSync(configPath) ? readFileSync(configPath, "utf8") : DEFAULT_CONFIG_TEMPLATE;
		} catch (error) {
			ctx.ui.notify(`Could not read ${configPath}: ${describeError(error)}`, "error");
			return;
		}

		for (;;) {
			const edited = await ctx.ui.editor(`parcom config — ${configPath}`, content);
			if (edited === undefined) {
				ctx.ui.notify("Config edit cancelled", "info");
				return;
			}

			try {
				parseCommandConfigContent(edited, configPath);
			} catch (error) {
				ctx.ui.notify(`Invalid config: ${describeError(error)}`, "error");
				const keepEditing = await ctx.ui.confirm("Invalid config", "The config was not saved. Keep editing?");
				if (!keepEditing) return;
				content = edited;
				continue;
			}

			try {
				saveCommandConfig(edited, configPath);
			} catch (error) {
				ctx.ui.notify(`Could not save ${configPath}: ${describeError(error)}`, "error");
				return;
			}

			// Pick up the new highlight levels and separators without a restart.
			if (!options.config) config = loadCommandConfig(options.configDirectory);
			ctx.ui.notify(`Saved ${configPath}`, "info");
			return;
		}
	};

	pi.registerCommand(PARCOM_COMMAND, {
		description: "Toggle or edit the bash command breakdown",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			PARCOM_OPTIONS.filter((item) => item.value.startsWith(prefix)).map((item) => ({ ...item })),
		handler: async (args, ctx) => {
			const option = args.trim().toLowerCase();
			if (option === "on") {
				enabled = true;
				updateStatus(ctx);
				ctx.ui.notify("Command breakdown enabled", "info");
				return;
			}
			if (option === "off") {
				enabled = false;
				updateStatus(ctx);
				ctx.ui.notify("Command breakdown disabled", "info");
				return;
			}
			if (option === "config") {
				await editConfig(ctx);
				return;
			}
			if (option === "") {
				ctx.ui.notify(
					`Command breakdown is ${enabled ? "on" : "off"}. Use /parcom on, /parcom off, or /parcom config.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(`Unknown /parcom option "${option}". Use on, off, or config.`, "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
	});

	// Reuse the built-in implementation so execution and result rendering stay
	// identical. Only renderCall is replaced.
	const original = createBashToolDefinition(process.cwd());

	pi.registerTool({
		name: original.name,
		label: original.label,
		description: original.description,
		promptSnippet: original.promptSnippet,
		promptGuidelines: original.promptGuidelines,
		parameters: original.parameters,
		constrainedSampling: original.constrainedSampling,
		executionMode: original.executionMode,
		prepareArguments: original.prepareArguments,
		execute: original.execute,
		renderResult: original.renderResult,

		renderCall(args, theme, context) {
			// Mirror the built-in renderer's timing state so the original
			// renderResult can still show "Took 1.2s".
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const container = (context.lastComponent as Container | undefined) ?? new Container();
			container.clear();
			container.addChild(new Text(formatShellCall(args, theme, enabled ? config : NO_HIGHLIGHT), 0, 0));

			const segments = enabled
				? parseShellCommands(typeof args?.command === "string" ? args.command : "", config.separators)
				: [];
			if (segments.length > 1) {
				// The parent ToolExecution box supplies the tool background. A nested
				// theme.bg() resets that background, so restore it after each custom
				// background line; otherwise the parent's right padding becomes black.
				const toolBackground = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
				const breakdown = new Text(
					formatCommandBreakdown(segments, theme, config),
					1,
					1,
					(text) => `${theme.bg("customMessageBg", text)}${theme.getBgAnsi(toolBackground)}`,
				);
				container.addChild(new Spacer(1));
				container.addChild(breakdown);
			}

			return container;
		},
	});
}
