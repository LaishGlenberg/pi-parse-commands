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
 * redirections (`2>&1`, `&>`, `>&2`), and here-documents so those do not
 * produce bogus splits. Heredoc bodies are swallowed whole, which keeps
 * embedded Python/bash/Node programs out of the breakdown. Command
 * substitution and `case` statements are still parsed naively.
 *
 * Usage:
 *   pi -e ./index.ts
 */

import { existsSync, readFileSync } from "node:fs";
import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	applyCommandConfigMigration,
	DEFAULT_CONFIG_TEMPLATE,
	DEFAULT_SEPARATORS,
	extensionConfigPath,
	findMissingConfigFeatures,
	loadCommandConfig,
	normalizeSeparators,
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

/** A here-document whose body has not been consumed yet. */
interface PendingHeredoc {
	/** Terminator word with quotes and backslashes stripped. */
	delimiter: string;
	/** `<<-` allows the terminator line to be indented with tabs. */
	stripTabs: boolean;
	/** Segment that declared this here-document, once it has been flushed. */
	owner?: ShellCommandSegment;
}

const HEREDOC_END_CHARS = /[\s;&|<>()]/;

/**
 * Parse a here-document redirection at `index` (which must point at the first
 * `<`), e.g. `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, or `<<\EOF`.
 *
 * Returns the verbatim operator text, the terminator word (quotes and
 * backslashes stripped), and whether tabs before the terminator are ignored.
 * Returns `undefined` when this is a here-string (`<<<`) or has no delimiter.
 */
function readHeredocOperator(
	text: string,
	index: number,
): { text: string; delimiter: string; stripTabs: boolean } | undefined {
	if (text[index] !== "<" || text[index + 1] !== "<" || text[index + 2] === "<") return undefined;

	let cursor = index + 2;
	let stripTabs = false;
	if (text[cursor] === "-") {
		stripTabs = true;
		cursor++;
	}
	while (text[cursor] === " " || text[cursor] === "\t") cursor++;

	let delimiter = "";
	while (cursor < text.length) {
		const ch = text[cursor];
		if (HEREDOC_END_CHARS.test(ch)) break;
		if (ch === "'" || ch === '"') {
			const quote = ch;
			cursor++;
			while (cursor < text.length && text[cursor] !== quote) {
				delimiter += text[cursor];
				cursor++;
			}
			if (cursor < text.length) cursor++; // closing quote
			continue;
		}
		if (ch === "\\") {
			cursor++;
			if (cursor < text.length) {
				delimiter += text[cursor];
				cursor++;
			}
			continue;
		}
		delimiter += ch;
		cursor++;
	}

	if (!delimiter) return undefined;
	return { text: text.slice(index, cursor), delimiter, stripTabs };
}

/**
 * Consume the bodies of `pending` here-documents starting at `index` (the
 * character right after the newline that opened them).
 *
 * Returns the new index and the verbatim body text of each here-document,
 * including each terminator but not the newline that follows it (the main loop
 * treats that newline as the command separator). The scanner stays deliberately
 * naive inside a body: quotes, separators, and comments there belong to the
 * embedded program, not to the shell command. An unterminated body simply runs
 * to end of input.
 */
function consumeHeredocBodies(
	text: string,
	index: number,
	pending: readonly PendingHeredoc[],
): { index: number; bodies: { heredoc: PendingHeredoc; text: string }[] } {
	let cursor = index;
	const bodies: { heredoc: PendingHeredoc; text: string }[] = [];
	for (let position = 0; position < pending.length; position++) {
		const heredoc = pending[position];
		const isLast = position === pending.length - 1;
		let consumed = "";
		let terminated = false;
		while (cursor < text.length) {
			const newline = text.indexOf("\n", cursor);
			const hasNewline = newline !== -1;
			const lineEnd = hasNewline ? newline : text.length;
			const line = text.slice(cursor, lineEnd);
			const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
			if (candidate === heredoc.delimiter) {
				consumed += line;
				// Leave the final terminator's newline for the main loop; consume the
				// earlier ones so the next body starts on the following line.
				cursor = isLast ? lineEnd : lineEnd + 1;
				terminated = true;
				break;
			}
			consumed += hasNewline ? `${line}\n` : line;
			cursor = hasNewline ? lineEnd + 1 : lineEnd;
		}
		bodies.push({ heredoc, text: consumed });
		if (!terminated) break;
	}
	return { index: cursor, bodies };
}

/**
 * Read a `$(( ... ))` arithmetic expansion at `index`, returning it verbatim.
 * Skipping it keeps a left shift (`1 << 2`) from being mistaken for a heredoc.
 * Parentheses are balanced; nested `$(...)` is tolerated.
 */
function readArithmeticExpansion(text: string, index: number): string {
	let cursor = index + 3; // past `$((`
	let depth = 2;
	while (cursor < text.length && depth > 0) {
		const ch = text[cursor];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		cursor++;
	}
	return text.slice(index, cursor);
}

/**
 * Split a shell command line into the individual commands that will run.
 *
 * Splits on the enabled `separators` (default `&&`, `||`, `;`) plus newlines.
 * Pass optional operators such as `|&`, `|`, and `&` to split on those too.
 * Separators inside single/double quotes, escaped separators, comments, and
 * redirections are preserved as part of the surrounding command, and a
 * here-document body stays attached to the command that opened it.
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
	const pendingHeredocs: PendingHeredoc[] = [];
	let ownedHeredocs: PendingHeredoc[] = [];

	const flush = (operator?: string) => {
		const trimmed = current.trim();
		current = "";
		if (!trimmed) return;
		const segment: ShellCommandSegment =
			operator && OPERATOR_LABELS.has(operator) ? { command: trimmed, operator } : { command: trimmed };
		segments.push(segment);
		// A here-document body belongs to the command that opened it, even when
		// that command has already been flushed at a separator on the same line.
		for (const heredoc of ownedHeredocs) heredoc.owner = segment;
		ownedHeredocs = [];
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

			if (ch === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
				const expansion = readArithmeticExpansion(command, i);
				current += expansion;
				i += expansion.length;
				continue;
			}

			if (ch === "<") {
				if (command[i + 1] === "<" && command[i + 2] === "<") {
					// A here-string (`<<<word`), not a here-document. Consume the whole
					// operator so the second `<` is not re-checked as a heredoc.
					current += "<<<";
					i += 3;
					continue;
				}
				const heredoc = readHeredocOperator(command, i);
				if (heredoc) {
					current += heredoc.text;
					const pending: PendingHeredoc = { delimiter: heredoc.delimiter, stripTabs: heredoc.stripTabs };
					pendingHeredocs.push(pending);
					ownedHeredocs.push(pending);
					i += heredoc.text.length;
					continue;
				}
			}

			const operatorLength = matchOperatorLength(command, i, enabledSeparators);
			if (operatorLength !== undefined) {
				if (command[i] === "\n" && pendingHeredocs.length > 0) {
					// This newline opens the pending here-document bodies instead of
					// ending the command. Keep them inside the owning segment so the
					// embedded program is not split into bogus commands. The newline
					// after each terminator is left to be reprocessed as a separator.
					const { index: bodyEnd, bodies } = consumeHeredocBodies(command, i + 1, pendingHeredocs);
					for (const body of bodies) {
						if (body.heredoc.owner) body.heredoc.owner.command += `\n${body.text}`;
						else current += `\n${body.text}`;
					}
					i = bodyEnd;
					pendingHeredocs.length = 0;
					continue;
				}
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

/** Collapse a here-document (or any multi-line) command to its first line plus a line count. */
function collapseCommandLines(command: string): { display: string; hidden: number } {
	const newline = command.indexOf("\n");
	if (newline === -1) return { display: command, hidden: 0 };
	return { display: command.slice(0, newline), hidden: command.split("\n").length - 1 };
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
		const { display, hidden } = collapseCommandLines(segment.command);
		const command = highlightCommandText(display, theme, config);
		const truncated = hidden > 0 ? theme.fg("muted", ` … (+${hidden} line${hidden === 1 ? "" : "s"})`) : "";
		const operator = segment.operator ? ` ${theme.fg("dim", segment.operator)}` : "";
		return `${number} ${command}${truncated}${operator}`;
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
const COMMAND_NAME = "parse-commands";
const COMMAND_OPTIONS: readonly AutocompleteItem[] = [
	{ value: "on", label: "on", description: "Enable the command breakdown for this session" },
	{ value: "off", label: "off", description: "Disable the command breakdown for this session" },
	{ value: "config", label: "config", description: "Create, upgrade, or regenerate the highlight config" },
];

/** Rendering config used while the breakdown is disabled: no highlighting or splitting. */
const NO_HIGHLIGHT: CommandHighlightConfig = { commands: {}, separators: [] };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function bashCommandBreakdown(pi: ExtensionAPI, options: BashCommandBreakdownOptions = {}): void {
	let config = options.config ?? loadCommandConfig(options.configDirectory);
	// Session-scoped: `/parse-commands off` suppresses rendering until re-enabled or the session restarts.
	let enabled = true;

	// Re-read the on-disk config after `/parse-commands config` edits it, unless a config
	// was injected directly (tests or embedding applications).
	const reloadConfig = (): void => {
		if (!options.config) config = loadCommandConfig(options.configDirectory);
	};

	const offerRegenerate = async (ctx: ExtensionCommandContext, configPath: string): Promise<void> => {
		const confirmed = await ctx.ui.confirm(
			"Regenerate config?",
			`This deletes ${configPath} and recreates it from the default. Continue?`,
		);
		if (!confirmed) return;

		try {
			saveCommandConfig(DEFAULT_CONFIG_TEMPLATE, configPath);
		} catch (error) {
			ctx.ui.notify(`Could not write ${configPath}: ${describeError(error)}`, "error");
			return;
		}
		reloadConfig();
		ctx.ui.notify(`Regenerated ${configPath}`, "info");
	};

	const configure = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`/${COMMAND_NAME} config is only available in the TUI`, "warning");
			return;
		}

		const configPath = extensionConfigPath(options.configDirectory);

		// 1. No config yet: generate the default template.
		if (!existsSync(configPath)) {
			try {
				saveCommandConfig(DEFAULT_CONFIG_TEMPLATE, configPath);
			} catch (error) {
				ctx.ui.notify(`Could not write ${configPath}: ${describeError(error)}`, "error");
				return;
			}
			reloadConfig();
			ctx.ui.notify(`Created ${configPath}`, "info");
			return;
		}

		// 2. Existing config: add any top-level options introduced by newer versions.
		let missing: string[];
		try {
			missing = findMissingConfigFeatures(readFileSync(configPath, "utf8"), configPath);
		} catch (error) {
			ctx.ui.notify(`Could not parse ${configPath}: ${describeError(error)}`, "error");
			await offerRegenerate(ctx, configPath);
			return;
		}

		if (missing.length > 0) {
			try {
				applyCommandConfigMigration(configPath, missing);
			} catch (error) {
				ctx.ui.notify(`Could not update ${configPath}: ${describeError(error)}`, "error");
				return;
			}
			reloadConfig();
			ctx.ui.notify(`Updated ${configPath}: added ${missing.join(", ")}`, "info");
			return;
		}

		// 3. Current config: offer a clean regenerate from the default.
		ctx.ui.notify("Your config is already up to date.", "info");
		await offerRegenerate(ctx, configPath);
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Toggle or configure the bash command breakdown",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			COMMAND_OPTIONS.filter((item) => item.value.startsWith(prefix)).map((item) => ({ ...item })),
		handler: async (args, ctx) => {
			const option = args.trim().toLowerCase();
			if (option === "on") {
				enabled = true;
				ctx.ui.notify("Command breakdown enabled", "info");
				return;
			}
			if (option === "off") {
				enabled = false;
				ctx.ui.notify("Command breakdown disabled", "info");
				return;
			}
			if (option === "config") {
				await configure(ctx);
				return;
			}
			if (option === "") {
				ctx.ui.notify(
					`Command breakdown is ${enabled ? "on" : "off"}. Use /${COMMAND_NAME} on, /${COMMAND_NAME} off, or /${COMMAND_NAME} config.`,
					"info",
				);
				return;
			}
			ctx.ui.notify(`Unknown /${COMMAND_NAME} option "${option}". Use on, off, or config.`, "warning");
		},
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
