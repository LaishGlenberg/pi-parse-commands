import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { CommandColorLevel, CommandHighlightConfig } from "./config.ts";

/** Default palette: green, yellow, orange, red. `mdHeading` is orange in built-in themes. */
export const COMMAND_LEVEL_COLORS: Record<CommandColorLevel, ThemeColor> = {
	0: "success",
	1: "warning",
	2: "mdHeading",
	3: "error",
};

function skipLeadingAssignments(command: string): number {
	let index = 0;
	while (index < command.length && /\s/.test(command[index] ?? "")) index += 1;

	while (index < command.length) {
		const match = command.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')\s+/);
		if (!match) break;
		index += match[0].length;
	}
	return index;
}

function commandTokenEnd(command: string, start: number): number {
	let index = start;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	while (index < command.length) {
		const char = command[index];
		if (escaped) {
			escaped = false;
		} else if (char === "\\" && quote !== "'") {
			escaped = true;
		} else if ((char === "'" || char === '"') && !quote) {
			quote = char;
		} else if (char === quote) {
			quote = undefined;
		} else if (!quote && /\s/.test(char)) {
			break;
		}
		index += 1;
	}
	return index;
}

function unquoteCommandToken(token: string): string {
	if (token.length >= 2 && ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"')))) {
		return token.slice(1, -1);
	}
	return token;
}

/** Highlight the executable at the beginning of one parsed shell command. */
export function highlightCommandText(command: string, theme: Theme, config: CommandHighlightConfig): string {
	const start = skipLeadingAssignments(command);
	if (start >= command.length) return command;

	const end = commandTokenEnd(command, start);
	const token = command.slice(start, end);
	const keyword = unquoteCommandToken(token);
	const level = config.commands[keyword];
	if (level === undefined) return command;

	return `${command.slice(0, start)}${theme.fg(COMMAND_LEVEL_COLORS[level], token)}${command.slice(end)}`;
}

/** Highlight each command executable while preserving the original separators and spacing. */
export function highlightShellCommand(
	command: string,
	segments: readonly { command: string }[],
	theme: Theme,
	config: CommandHighlightConfig,
): string {
	if (Object.keys(config.commands).length === 0) return command;

	let cursor = 0;
	let result = "";
	for (const segment of segments) {
		const start = command.indexOf(segment.command, cursor);
		if (start < cursor) continue;
		result += command.slice(cursor, start);
		result += highlightCommandText(segment.command, theme, config);
		cursor = start + segment.command.length;
	}
	return result + command.slice(cursor);
}
