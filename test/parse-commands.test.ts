/**
 * Pi Parse Commands Extension Tests
 *
 * Two layers are covered:
 *   1. The pure parser (`parseShellCommands` / `splitShellCommands`) with a
 *      large matrix of quoting, escaping, comment, redirection, and separator
 *      edge cases.
 *   2. The `bash` tool override: registration, the nested breakdown box, the
 *      single-command suppression path, and the display cap.
 *
 * The coding-agent package is mocked because the extension only needs a bash
 * definition to wrap; its execution path is irrelevant here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const original = {
		name: "bash",
		label: "bash",
		description: "Execute a bash command",
		promptSnippet: "snippet",
		promptGuidelines: ["guideline"],
		parameters: { type: "object" },
		constrainedSampling: undefined,
		executionMode: undefined,
		prepareArguments: undefined,
		execute: vi.fn(),
		renderResult: vi.fn(() => ({ render: () => ["result"] })),
	};
	return {
		original,
		createBashToolDefinition: vi.fn(() => original),
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: mocks.createBashToolDefinition,
}));

import bashCommandBreakdown, {
	formatCommandBreakdown,
	MAX_BREAKDOWN_COMMANDS,
	parseShellCommands,
	splitShellCommands,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeFg {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
	dim: (text: string) => string;
}

const theme: FakeFg = {
	fg: (color, text) => `{${color}:${text}}`,
	bg: (color, text) => `[bg=${color}]${text}[/bg]`,
	bold: (text) => `*${text}*`,
	dim: (text) => `~${text}~`,
};

function collectTool(options: Parameters<typeof bashCommandBreakdown>[1] = { config: { commands: {} } }) {
	const tools: any[] = [];
	const pi = {
		registerTool: (tool: any) => tools.push(tool),
	} as unknown as ExtensionAPI;
	bashCommandBreakdown(pi, options);
	const tool = tools.find((t) => t.name === "bash");
	if (!tool) throw new Error("bash tool was not registered");
	return tool;
}

function renderCall(tool: any, args: any, width = 100): string {
	const context = { state: {}, executionStarted: true, lastComponent: undefined };
	const component = tool.renderCall(args, theme, context);
	return component.render(width).join("\n");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseShellCommands", () => {
	it("returns an empty list for an empty command", () => {
		expect(parseShellCommands("")).toEqual([]);
	});

	it("returns an empty list for whitespace only", () => {
		expect(parseShellCommands("   \t  \n ")).toEqual([]);
	});

	it("returns a single command with no operator", () => {
		expect(parseShellCommands("ls -la")).toEqual([{ command: "ls -la" }]);
	});

	it("splits on && and records the operator", () => {
		expect(parseShellCommands("cd /tmp && make")).toEqual([
			{ command: "cd /tmp", operator: "&&" },
			{ command: "make" },
		]);
	});

	it("splits on ||", () => {
		expect(parseShellCommands("test -f x || touch x")).toEqual([
			{ command: "test -f x", operator: "||" },
			{ command: "touch x" },
		]);
	});

	it("splits on a single pipe", () => {
		expect(parseShellCommands("cat f | grep x")).toEqual([
			{ command: "cat f", operator: "|" },
			{ command: "grep x" },
		]);
	});

	it("splits on |&", () => {
		expect(parseShellCommands("run |& tee log")).toEqual([
			{ command: "run", operator: "|&" },
			{ command: "tee log" },
		]);
	});

	it("splits on semicolons", () => {
		expect(parseShellCommands("a; b; c")).toEqual([
			{ command: "a", operator: ";" },
			{ command: "b", operator: ";" },
			{ command: "c" },
		]);
	});

	it("splits on background &", () => {
		expect(parseShellCommands("sleep 1 & echo done")).toEqual([
			{ command: "sleep 1", operator: "&" },
			{ command: "echo done" },
		]);
	});

	it("splits on newlines and suppresses the operator", () => {
		expect(parseShellCommands("a\nb")).toEqual([{ command: "a" }, { command: "b" }]);
	});

	it("trims each command and drops empty segments", () => {
		expect(parseShellCommands("  && a ;; ; b &&  ")).toEqual([
			{ command: "a", operator: ";" },
			{ command: "b", operator: "&&" },
		]);
	});

	it("handles a large mixed chain", () => {
		expect(parseShellCommands("cd /tmp && rm -rf build; make all | tee log.txt || echo failed & wait")).toEqual([
			{ command: "cd /tmp", operator: "&&" },
			{ command: "rm -rf build", operator: ";" },
			{ command: "make all", operator: "|" },
			{ command: "tee log.txt", operator: "||" },
			{ command: "echo failed", operator: "&" },
			{ command: "wait" },
		]);
	});

	it("does not split separators inside double quotes", () => {
		expect(parseShellCommands('echo "a && b; c | d"')).toEqual([{ command: 'echo "a && b; c | d"' }]);
	});

	it("does not split separators inside single quotes", () => {
		expect(parseShellCommands("echo 'a && b; c | d'")).toEqual([{ command: "echo 'a && b; c | d'" }]);
	});

	it("tracks single and double quotes independently", () => {
		expect(parseShellCommands(`echo "it's fine" && ls`)).toEqual([
			{ command: `echo "it's fine"`, operator: "&&" },
			{ command: "ls" },
		]);
	});

	it("does not treat a quote inside the other quote as a toggle", () => {
		expect(parseShellCommands(`echo "a 'b' c" && d`)).toEqual([
			{ command: `echo "a 'b' c"`, operator: "&&" },
			{ command: "d" },
		]);
	});

	it("respects escaped quotes inside double quotes", () => {
		expect(parseShellCommands('echo "a\\"b" && c')).toEqual([
			{ command: 'echo "a\\"b"', operator: "&&" },
			{ command: "c" },
		]);
	});

	it("does not split on escaped separators", () => {
		expect(parseShellCommands("echo a\\;b \\&\\& c")).toEqual([{ command: "echo a\\;b \\&\\& c" }]);
	});

	it("does not split on 2>&1 redirections", () => {
		expect(parseShellCommands("foo 2>&1 | bar")).toEqual([
			{ command: "foo 2>&1", operator: "|" },
			{ command: "bar" },
		]);
	});

	it("does not split on &> redirections", () => {
		expect(parseShellCommands("foo &> out.txt")).toEqual([{ command: "foo &> out.txt" }]);
	});

	it("does not split on >&2 redirections", () => {
		expect(parseShellCommands("foo >&2")).toEqual([{ command: "foo >&2" }]);
	});

	it("splits a trailing background marker after a redirection", () => {
		expect(parseShellCommands("cmd > /dev/null 2>&1 &")).toEqual([
			{ command: "cmd > /dev/null 2>&1", operator: "&" },
		]);
	});

	it("ignores a trailing comment", () => {
		expect(parseShellCommands("echo a # comment; rm -rf / && nope")).toEqual([{ command: "echo a" }]);
	});

	it("ignores full-line comments", () => {
		expect(parseShellCommands("echo a\n# comment with ; and &&\necho b")).toEqual([
			{ command: "echo a" },
			{ command: "echo b" },
		]);
	});

	it("does not treat a mid-word # as a comment", () => {
		expect(parseShellCommands("echo foo#bar")).toEqual([{ command: "echo foo#bar" }]);
	});

	it("does not treat a parameter length expansion as a comment", () => {
		expect(parseShellCommands(`echo \${#arr[@]}`)).toEqual([{ command: `echo \${#arr[@]}` }]);
	});

	it("handles the dense real-world chained command", () => {
		const dense =
			"cd /home/lg/projects/pi-command-cli && " +
			'rg -c "resolveCustomExpression" graphify-out/graph.json; ' +
			'rg -c "expandCustom" graphify-out/graph.json; ' +
			'rg -c "custom" graphify-out/graph.json; ' +
			'echo "--- sample node labels ---" && ' +
			`node -e "const g=require('./graphify-out/graph.json'); const nodes=g.nodes||[];  labels=nodes.map(n=>n.label||n.id); console.log(labels.filter(l=>/custom|parseArg|buildPi/i.test(l)).join('\\n'))"`;

		const segments = parseShellCommands(dense);
		expect(segments).toHaveLength(6);
		expect(segments[0]).toEqual({ command: "cd /home/lg/projects/pi-command-cli", operator: "&&" });
		expect(segments[1]).toEqual({
			command: 'rg -c "resolveCustomExpression" graphify-out/graph.json',
			operator: ";",
		});
		expect(segments[3]).toEqual({ command: 'rg -c "custom" graphify-out/graph.json', operator: ";" });
		expect(segments[4]).toEqual({ command: 'echo "--- sample node labels ---"', operator: "&&" });
		expect(segments[5].command).toContain("node -e");
		expect(segments[5].command).toContain("join('\\n')");
		expect(segments[5].command).not.toContain("|| echo ");
		expect(segments[5].operator).toBeUndefined();
	});
});

describe("splitShellCommands", () => {
	it("maps parsed segments to command strings", () => {
		expect(splitShellCommands("a && b; c")).toEqual(["a", "b", "c"]);
	});

	it("returns a single element for a single command", () => {
		expect(splitShellCommands("just one")).toEqual(["just one"]);
	});

	it("returns an empty array for an empty command", () => {
		expect(splitShellCommands("")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Breakdown formatting
// ---------------------------------------------------------------------------

describe("formatCommandBreakdown", () => {
	it("numbers commands and appends operators", () => {
		const text = formatCommandBreakdown([{ command: "cd /tmp", operator: "&&" }, { command: "make" }], theme as any);
		expect(text).toContain("{muted:1.}");
		expect(text).toContain("cd /tmp");
		expect(text).toContain("{dim:&&}");
		expect(text).toContain("{muted:2.}");
		expect(text).toContain("make");
	});

	it("caps the number of displayed commands", () => {
		const segments = Array.from({ length: MAX_BREAKDOWN_COMMANDS + 7 }, (_, i) => ({ command: `cmd${i}` }));
		const text = formatCommandBreakdown(segments, theme as any);
		expect(text).toContain("cmd0");
		expect(text).toContain(`cmd${MAX_BREAKDOWN_COMMANDS - 1}`);
		expect(text).not.toContain(`cmd${MAX_BREAKDOWN_COMMANDS}`);
		expect(text).toContain("and 7 more");
	});

	it("highlights configured command names with the default four-level palette", () => {
		const text = formatCommandBreakdown(
			parseShellCommands("green && yellow && orange && red"),
			theme as any,
			{ commands: { green: 0, yellow: 1, orange: 2, red: 3 } },
		);
		expect(text).toContain("{success:green}");
		expect(text).toContain("{warning:yellow}");
		expect(text).toContain("{mdHeading:orange}");
		expect(text).toContain("{error:red}");
	});
});

// ---------------------------------------------------------------------------
// Tool registration and rendering
// ---------------------------------------------------------------------------

describe("pi-parse-commands extension", () => {
	it("creates the original bash definition from the current working directory", () => {
		collectTool();
		expect(mocks.createBashToolDefinition).toHaveBeenCalledWith(process.cwd());
	});

	it("registers a bash tool preserving execution, schema, and prompt metadata", () => {
		const tool = collectTool();
		expect(tool.name).toBe("bash");
		expect(tool.description).toBe(mocks.original.description);
		expect(tool.parameters).toBe(mocks.original.parameters);
		expect(tool.promptSnippet).toBe(mocks.original.promptSnippet);
		expect(tool.promptGuidelines).toBe(mocks.original.promptGuidelines);
		expect(tool.execute).toBe(mocks.original.execute);
		expect(tool.renderResult).toBe(mocks.original.renderResult);
	});

	it("renders the command line with a shell prompt", () => {
		const output = renderCall(collectTool(), { command: "echo hi" });
		expect(output).toContain("echo hi");
		expect(output).toContain("*$ echo hi*");
	});

	it("does not draw a breakdown for a single command", () => {
		const output = renderCall(collectTool(), { command: "echo hi" });
		expect(output).not.toContain("bg=customMessageBg");
	});

	it("draws a breakdown box with a distinct background for chained commands", () => {
		const output = renderCall(collectTool(), { command: "cd /tmp && make all | tee log" });
		expect(output).toContain("bg=customMessageBg");
		expect(output).toContain("cd /tmp");
		expect(output).toContain("make all");
		expect(output).toContain("tee log");
		expect(output).toContain("{muted:1.}");
		expect(output).toContain("{muted:3.}");
	});

	it("highlights configured command names in the call and breakdown", () => {
		const output = renderCall(collectTool({ config: { commands: { node: 1 } } }), {
			command: "echo before && node -e \\\"console.log('ok')\\\"",
		});
		expect(output).toContain("{warning:node}");
	});

	it("leaves a one-cell terminal margin at the right edge", () => {
		const ansiTheme: FakeFg = {
			fg: (_color, text) => `\x1b[38;5;1m${text}\x1b[39m`,
			bg: (_color, text) => `\x1b[48;5;2m${text}\x1b[49m`,
			bold: (text) => `\x1b[1m${text}\x1b[22m`,
			dim: (text) => `\x1b[2m${text}\x1b[22m`,
		};
		const inner = collectTool().renderCall(
			{ command: "first && second" },
			ansiTheme,
			{ state: {}, executionStarted: true, lastComponent: undefined },
		);
		const outer = new Box(1, 1, (text) => `\x1b[48;5;3m${text}\x1b[49m`);
		outer.addChild(inner);
		const customBackground = "\x1b[48;5;2m";
		const outerReset = "\x1b[49m";
		for (const line of outer.render(40).filter((line) => line.includes(customBackground))) {
			expect(line.slice(0, -outerReset.length).endsWith(" ")).toBe(true);
		}
	});

	it("keeps separators out of the command text but shows the operator", () => {
		const output = renderCall(collectTool(), { command: "a && b" });
		expect(output).toContain("a");
		expect(output).toContain("{dim:&&}");
		// The literal command line still shows the whole thing.
		expect(output).toContain("*$ a && b*");
	});

	it("shows a timeout hint on the command line", () => {
		const output = renderCall(collectTool(), { command: "a && b", timeout: 30 });
		expect(output).toContain("timeout 30s");
	});

	it("renders each command only once when re-rendered with the previous component", () => {
		const tool = collectTool();
		const context: any = { state: {}, executionStarted: true, lastComponent: undefined };
		const first = tool.renderCall({ command: "echo alpha && echo beta" }, theme, context);
		const second = tool.renderCall({ command: "echo alpha && echo beta" }, theme, {
			...context,
			lastComponent: first,
		});
		expect(second).toBe(first);
		const rendered = second.render(100).join("\n");
		expect(rendered.match(/\{muted:1\.\}/g)?.length).toBe(1);
		expect(rendered.match(/\{muted:2\.\}/g)?.length).toBe(1);
		// "alpha" appears once on the command line and once in the breakdown.
		expect(rendered.match(/alpha/g)?.length).toBe(2);
	});

	it("starts the timing state like the built-in renderer", () => {
		const tool = collectTool();
		const state: any = {};
		tool.renderCall({ command: "a && b" }, theme, { state, executionStarted: true });
		expect(typeof state.startedAt).toBe("number");
		expect(state.endedAt).toBeUndefined();
	});

	it("does not start timing before execution begins", () => {
		const tool = collectTool();
		const state: any = {};
		tool.renderCall({ command: "a && b" }, theme, { state, executionStarted: false });
		expect(state.startedAt).toBeUndefined();
	});
});
