import { TFile, TFolder } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PauseGate, PauseSkipLog, isPausedValue } from "../src/pauseGate";

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

	it("says a folder is a folder", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const folder = new TFolder();
		folder.path = PAUSE_PATH;
		const app = {
			vault: { getAbstractFileByPath: () => folder },
			metadataCache: { getFileCache: () => null },
		} as never;
		expect(new PauseGate(app, () => PAUSE_PATH).check().paused).toBe(false);
		expect(warn.mock.calls[0]?.[0]).toContain("is a folder, not a note");
	});

	it("says a non-markdown file is not a markdown note", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const file = new TFile();
		file.path = "pause.canvas";
		file.extension = "canvas";
		const app = {
			vault: { getAbstractFileByPath: () => file },
			metadataCache: { getFileCache: () => ({ frontmatter: { paused: true } }) },
		} as never;
		expect(new PauseGate(app, () => "pause.canvas").check().paused).toBe(false);
		expect(warn.mock.calls[0]?.[0]).toContain("is not a markdown note");
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

describe("pause skip log", () => {
	const REASON = "paused by nelson since 2026-09-22T07:38: vault maintenance";
	const NEW_REASON = "paused by nelson since 2026-09-23T09:00: second pause";

	/** Drives the log the way executeWorkflow does: ask, write, then mark. */
	function tick(log: PauseSkipLog, reason: string, recorded: string[], write: () => void = () => undefined): void {
		if (!log.shouldRecord("rollover", reason)) return;
		write();
		log.markRecorded("rollover", reason);
		recorded.push(reason);
	}

	it("records one skipped run per pause however many ticks it spans", () => {
		const log = new PauseSkipLog();
		const recorded: string[] = [];
		for (let count = 0; count < 100; count += 1) tick(log, REASON, recorded);
		expect(recorded).toEqual([REASON]);
	});

	it("records again when the pause reason changes", () => {
		const log = new PauseSkipLog();
		const recorded: string[] = [];
		for (const reason of [REASON, REASON, NEW_REASON, NEW_REASON]) tick(log, reason, recorded);
		expect(recorded).toEqual([REASON, NEW_REASON]);
	});

	it("records again for the next pause once the current one clears", () => {
		const log = new PauseSkipLog();
		const recorded: string[] = [];
		tick(log, REASON, recorded);
		tick(log, REASON, recorded);
		log.clear("rollover");
		tick(log, REASON, recorded);
		expect(recorded).toEqual([REASON, REASON]);
	});

	it("retries on the next tick when the write failed", () => {
		const log = new PauseSkipLog();
		const recorded: string[] = [];
		expect(() =>
			tick(log, REASON, recorded, () => {
				throw new Error("run log write failed");
			})
		).toThrow("run log write failed");
		expect(recorded).toEqual([]);

		tick(log, REASON, recorded);
		expect(recorded).toEqual([REASON]);
	});

	it("keeps workflows apart", () => {
		const log = new PauseSkipLog();
		expect(log.shouldRecord("rollover", REASON)).toBe(true);
		log.markRecorded("rollover", REASON);
		expect(log.shouldRecord("rollover", REASON)).toBe(false);
		expect(log.shouldRecord("escalate", REASON)).toBe(true);
	});
});
