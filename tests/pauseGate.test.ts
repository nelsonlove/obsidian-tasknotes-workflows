import { TFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PauseGate, isPausedValue } from "../src/pauseGate";

const PAUSE_PATH = "00-09 System/00 System management/00.08 Operator's console/Pause.md";

function appWith(frontmatter: Record<string, unknown> | null, path = PAUSE_PATH): never {
	const file = new TFile();
	file.path = path;
	return {
		vault: {
			getAbstractFileByPath: (candidate: string) => (candidate === path ? file : null),
		},
		metadataCache: {
			getFileCache: () => (frontmatter === null ? {} : { frontmatter }),
		},
	} as never;
}

function emptyApp(): never {
	return {
		vault: { getAbstractFileByPath: () => null },
		metadataCache: { getFileCache: () => null },
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pause gate", () => {
	it("pauses on paused: true and reports who, since, and why", () => {
		const gate = new PauseGate(
			appWith({
				paused: true,
				"paused-by": "nelson",
				"paused-since": "2026-09-22T07:38",
				"paused-why": "vault maintenance",
			}),
			() => PAUSE_PATH
		);
		const state = gate.check();
		expect(state.paused).toBe(true);
		expect(state.reason).toContain("paused by nelson since 2026-09-22T07:38: vault maintenance");
		expect(state.reason).toContain(PAUSE_PATH);
	});

	it("does not pause when the flag is false", () => {
		const gate = new PauseGate(appWith({ paused: false }), () => PAUSE_PATH);
		expect(gate.check().paused).toBe(false);
	});

	it("treats the strings true and yes as paused, case-insensitively", () => {
		for (const value of ["yes", "YES", " Yes ", "true", "TRUE"]) {
			const gate = new PauseGate(appWith({ paused: value }), () => PAUSE_PATH);
			expect(gate.check().paused, `paused: ${value}`).toBe(true);
		}
		for (const value of ["no", "off", "", "1"]) {
			const gate = new PauseGate(appWith({ paused: value }), () => PAUSE_PATH);
			expect(gate.check().paused, `paused: ${value}`).toBe(false);
		}
	});

	it("fails open when the pause note is missing, warning once per load", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const gate = new PauseGate(emptyApp(), () => PAUSE_PATH);
		expect(gate.check().paused).toBe(false);
		expect(gate.check().paused).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain(PAUSE_PATH);
	});

	it("fails open when the note exists but its cache has no frontmatter", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const gate = new PauseGate(appWith(null), () => PAUSE_PATH);
		expect(gate.check().paused).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("is off, and silent, when no pause note is configured", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const gate = new PauseGate(emptyApp(), () => "   ");
		expect(gate.check().paused).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});

	it("falls back to unknown for an incomplete pause note", () => {
		const gate = new PauseGate(appWith({ paused: true }), () => PAUSE_PATH);
		expect(gate.check().reason).toContain("paused by unknown since unknown");
	});
});

describe("isPausedValue", () => {
	it("accepts only true and the true-ish strings", () => {
		expect(isPausedValue(true)).toBe(true);
		expect(isPausedValue("yes")).toBe(true);
		expect(isPausedValue(false)).toBe(false);
		expect(isPausedValue(undefined)).toBe(false);
		expect(isPausedValue(1)).toBe(false);
	});
});
