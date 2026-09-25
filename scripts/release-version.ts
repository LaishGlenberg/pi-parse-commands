#!/usr/bin/env node
/**
 * Release version resolver for the automated release workflow.
 *
 * Given the version currently in `package.json` and whether that version has
 * already been tagged, decide whether the workflow should cut a patch bump or
 * release the version the developer committed.
 *
 * Rules:
 *   - The tag for the current version already exists -> bump the patch version.
 *   - No tag exists yet -> release the version currently in `package.json`.
 *
 * Output is written as `key=value` lines so it can be appended to
 * `$GITHUB_OUTPUT`.
 *
 * Usage:
 *   node scripts/release-version.ts --current 1.0.0 --tag-exists false
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ReleaseDecision {
	/** Whether the workflow should run `npm version <version>`. */
	needsBump: boolean;
	/** The version that should be released. */
	version: string;
	/** The git tag for the release. */
	tag: string;
}

interface Semver {
	major: number;
	minor: number;
	patch: number;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

function parseSemver(value: string): Semver {
	const match = SEMVER_PATTERN.exec(value.trim());
	if (!match) {
		throw new Error(`Invalid semantic version: "${value}"`);
	}
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Bump the patch component and drop any prerelease/build metadata. */
export function bumpPatch(version: string): string {
	const { major, minor, patch } = parseSemver(version);
	return `${major}.${minor}.${patch + 1}`;
}

/**
 * Decide what version the workflow should release.
 *
 * @param current Version currently declared in `package.json`.
 * @param tagExists Whether `v<current>` already exists as a git tag.
 */
export function decideRelease(current: string, tagExists: boolean): ReleaseDecision {
	// Validate eagerly so a bad package.json fails before any git side effects.
	parseSemver(current);
	const version = tagExists ? bumpPatch(current) : current.trim();
	return { needsBump: tagExists, version, tag: `v${version}` };
}

export function formatOutputs(decision: ReleaseDecision): string {
	return [
		`needs_bump=${decision.needsBump ? "true" : "false"}`,
		`version=${decision.version}`,
		`tag=${decision.tag}`,
		"",
	].join("\n");
}

function parseArgs(argv: string[]): { current?: string; tagExists?: boolean } {
	const result: { current?: string; tagExists?: boolean } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--current") {
			result.current = argv[++i];
		} else if (arg === "--tag-exists") {
			result.tagExists = argv[++i] !== "false";
		}
	}
	return result;
}

function main(argv: string[]): void {
	const { current, tagExists } = parseArgs(argv);
	if (!current) {
		throw new Error("Missing required --current <version> argument.");
	}

	const outputs = formatOutputs(decideRelease(current, tagExists ?? false));
	const githubOutput = process.env.GITHUB_OUTPUT;
	if (githubOutput) {
		appendFileSync(githubOutput, outputs);
	}
	process.stdout.write(outputs);
}

// Only run when executed directly (`node scripts/release-version.ts`), not when
// imported by tests.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
	main(process.argv.slice(2));
}
