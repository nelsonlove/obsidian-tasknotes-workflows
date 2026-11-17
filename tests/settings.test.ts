import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeAllowedFrontmatterKeys, normalizeSettings } from "../src/settings";

describe("normalizeAllowedFrontmatterKeys", () => {
	it("keeps vault-convention keys such as title, uid, and created", () => {
		expect(normalizeAllowedFrontmatterKeys(["title", "uid", "created"])).toEqual([
			"title",
			"uid",
			"created",
		]);
	});

	it("drops reserved workflow-owned keys", () => {
		expect(
			normalizeAllowedFrontmatterKeys([
				"type",
				"version",
				"schemaVersion",
				"name",
				"enabled",
				"steps",
				"run",
				"x-tasknotes",
				"x-anything",
				"uid",
			])
		).toEqual(["uid"]);
	});

	it("trims, drops empties, and dedupes", () => {
		expect(normalizeAllowedFrontmatterKeys([" uid ", "", "uid", "created", 42, null])).toEqual([
			"uid",
			"created",
		]);
	});

	it("returns the default for non-array input", () => {
		expect(normalizeAllowedFrontmatterKeys(undefined)).toEqual([]);
		expect(normalizeAllowedFrontmatterKeys("uid")).toEqual([]);
	});
});

describe("pauseFlagPath", () => {
	it("is empty by default, so the shipped plugin names no path", () => {
		expect(DEFAULT_SETTINGS.pauseFlagPath).toBe("");
		expect(normalizeSettings({}).pauseFlagPath).toBe("");
	});

	it("trims, keeps an empty value, and drops a non-string", () => {
		expect(normalizeSettings({ pauseFlagPath: "  ~/flags/pause  " }).pauseFlagPath).toBe("~/flags/pause");
		expect(normalizeSettings({ pauseFlagPath: "   " }).pauseFlagPath).toBe("");
		expect(normalizeSettings({ pauseFlagPath: 7 as never }).pauseFlagPath).toBe("");
	});
});
