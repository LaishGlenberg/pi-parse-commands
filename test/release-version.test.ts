/**
 * Tests for the release workflow's version resolver.
 *
 * The release workflow relies on `scripts/release-version.ts` to decide whether
 * to cut a patch bump or release the version committed to `package.json`. A
 * regression here would either publish the wrong version or skip a release, so
 * the decision logic is covered directly.
 */

import { describe, expect, it } from "vitest";
import { bumpPatch, decideRelease, formatOutputs } from "../scripts/release-version.ts";

describe("bumpPatch", () => {
	it("increments the patch component", () => {
		expect(bumpPatch("1.2.3")).toBe("1.2.4");
	});

	it("drops prerelease and build metadata", () => {
		expect(bumpPatch("1.2.3-beta.1")).toBe("1.2.4");
		expect(bumpPatch("1.2.3+build.7")).toBe("1.2.4");
	});

	it("rejects non-semver input", () => {
		expect(() => bumpPatch("1.2")).toThrow(/Invalid semantic version/);
		expect(() => bumpPatch("v1.2.3")).toThrow(/Invalid semantic version/);
	});
});

describe("decideRelease", () => {
	it("releases the committed version when no tag exists yet", () => {
		expect(decideRelease("1.0.0", false)).toEqual({
			needsBump: false,
			version: "1.0.0",
			tag: "v1.0.0",
		});
	});

	it("cuts a patch bump when the version is already tagged", () => {
		expect(decideRelease("1.0.0", true)).toEqual({
			needsBump: true,
			version: "1.0.1",
			tag: "v1.0.1",
		});
	});

	it("respects a manual minor or major bump that has not been tagged", () => {
		expect(decideRelease("2.0.0", false)).toMatchObject({ needsBump: false, version: "2.0.0" });
	});

	it("validates the current version even when a bump will be cut", () => {
		expect(() => decideRelease("not-a-version", true)).toThrow(/Invalid semantic version/);
	});
});

describe("formatOutputs", () => {
	it("emits GITHUB_OUTPUT key=value lines", () => {
		expect(formatOutputs(decideRelease("1.0.0", false))).toBe(
			"needs_bump=false\nversion=1.0.0\ntag=v1.0.0\n",
		);
	});

	it("emits true for a patch bump", () => {
		expect(formatOutputs(decideRelease("1.4.2", true))).toBe(
			"needs_bump=true\nversion=1.4.3\ntag=v1.4.3\n",
		);
	});
});
