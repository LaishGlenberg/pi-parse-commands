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

import { createBashToolDefinition, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { loadCommandConfig, type CommandHighlightConfig } from "./config.ts";
import { highlightCommandText, highlightShellCommand } from "./highlight.ts";

/** Hard cap on how many parsed commands are drawn in the breakdown box. */
export const MAX_BREAKDOWN_COMMANDS = 25;

/**
 * ToolExecutionComponent wraps renderer output in a one-cell-padded Box. Render
 * the inset one cell wider so its background reaches the terminal's right edge
 * instead of exposing that wrapper's background as a black strip.
 */
class FullWidthBreakdown extends Text {
	override render(width: number): string[] {
		return super.render(width + 1);
	}
}

export interface ShellCommandSegment {
	/** The command text, trimmed. */
	command: string;
	/** The list operator that terminates this command (`&&`, `||`, `|&`, `|`, `;`, `&`). Undefined for the last command. */
	operator?: string;
}

const OPERATOR_LABELS = new Set(["&&", "||", "|&", "|", ";", "&"]);

/**
 * Detect a command-list operator at `index`.
 *
 * Returns the operator length, or `undefined` when the character is not a
 * separator. `&` requires extra care because it is also part of redirections
 * (`2>&1`, `>&2`, `&>file`) which must not be split.
 */
function matchOperatorLength(text: string, index: number): number | undefined {
	const ch = text[index];
	const next = text[index + 1];

	if (ch === "&" && next === "&") return 2;
	if (ch === "|" && next === "|") return 2;
	if (ch === "|" && next === "&") return 2;
	if (ch === "|") return 1;
	if (ch === ";") return 1;
	if (ch === "\n") return 1;
	if (ch === "&") {
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
 * Splits on `&&`, `||`, `|&`, `|`, `;`, `&`, and newlines. Separators inside
 * single/double quotes, escaped separators, comments, and redirections are
 * preserved as part of the surrounding command.
 */
export function parseShellCommands(command: string): ShellCommandSegment[] {
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

			const operatorLength = matchOperatorLength(command, i);
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
		? highlightShellCommand(command, parseShellCommands(command), theme, config)
		: theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${display}`)) + timeoutSuffix;
}

export interface BashCommandBreakdownOptions {
	/** Use an explicit config in tests or embedding applications. */
	config?: CommandHighlightConfig;
	/** Override the directory searched for config.json(c) or config.yaml(yml). */
	configDirectory?: string;
}

export default function bashCommandBreakdown(pi: ExtensionAPI, options: BashCommandBreakdownOptions = {}): void {
	const config = options.config ?? loadCommandConfig(options.configDirectory);
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
			container.addChild(new Text(formatShellCall(args, theme, config), 0, 0));

			const segments = parseShellCommands(typeof args?.command === "string" ? args.command : "");
			if (segments.length > 1) {
				// Text owns the background and horizontal padding so every rendered row,
				// including the right edge, is filled at the exact parent width.
				const breakdown = new FullWidthBreakdown(
					formatCommandBreakdown(segments, theme, config),
					1,
					1,
					(text) => theme.bg("customMessageBg", text),
				);
				container.addChild(new Spacer(1));
				container.addChild(breakdown);
			}

			return container;
		},
	});
}
