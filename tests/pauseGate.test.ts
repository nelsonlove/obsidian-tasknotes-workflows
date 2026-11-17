import { TFile, TFolder } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PauseGate,
	PauseSkipLog,
	expandHome,
	isPausedValue,
	parsePauseFlag,
	type PauseFlagFs,
	type PauseFlagHost,
} from "../src/pauseGate";

const PAUSE_PATH = "Admin/Console/Pause.md";

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
				"paused-by": "alex",
				"paused-since": "2026-09-22T07:38",
				"paused-why": "vault maintenance",
			}),
			() => PAUSE_PATH
		);
		const state = gate.check();
		expect(state.paused).toBe(true);
		expect(state.reason).toContain("paused by alex since 2026-09-22T07:38: vault maintenance");
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

const HOME = "/home/example";
const FLAG = "/srv/example/pause";

type FakeEntry = string | { error: string } | { symlink: true } | { folder: true };

/** An in-memory file system: path -> text, an error code, a symlink or a folder. */
function fakeHost(files: Record<string, FakeEntry>, homedir = HOME): PauseFlagHost & { reads: string[] } {
	const reads: string[] = [];
	const fail = (code: string): never => {
		throw Object.assign(new Error(code), { code });
	};
	const fs: PauseFlagFs = {
		lstatSync(path) {
			reads.push(path);
			const entry = files[path];
			if (entry === undefined) return fail("ENOENT");
			if (typeof entry === "string") {
				return { isSymbolicLink: () => false, isFile: () => true, size: Buffer.byteLength(entry) };
			}
			if ("error" in entry) return fail(entry.error);
			if ("symlink" in entry) return { isSymbolicLink: () => true, isFile: () => false, size: 10 };
			return { isSymbolicLink: () => false, isFile: () => false, size: 64 };
		},
		readFileSync(path) {
			const entry = files[path];
			if (typeof entry === "string") return entry;
			return fail("EIO");
		},
	};
	return { fs, homedir, reads };
}

function flagGate(files: Record<string, FakeEntry>, flagPath = FLAG, app: never = emptyApp()): PauseGate {
	const host = fakeHost(files);
	return new PauseGate(app, () => PAUSE_PATH, () => flagPath, () => host);
}

describe("pause gate, flag file road", () => {
	it("a missing flag file is not a pause", () => {
		expect(flagGate({}).check()).toEqual({ paused: false });
	});

	it("pauses on paused: true and reports who, since, why and the file", () => {
		const state = flagGate({
			[FLAG]: "paused: true\nwhy: disk maintenance\nby: alex\nat: 2026-01-02T03:04:05+00:00\n",
		}).check();
		expect(state.paused).toBe(true);
		expect(state.reason).toBe(
			`paused by alex since 2026-01-02T03:04:05+00:00: disk maintenance (${FLAG})`
		);
	});

	it("does not pause on paused: false or no", () => {
		for (const text of ["paused: false\n", "paused: no\nwhy: done\n", 'paused: "FALSE"  # resumed\n']) {
			expect(flagGate({ [FLAG]: text }).check().paused, text).toBe(false);
		}
	});

	it("reads yes, quotes, CRLF, comments and blank lines the way the shell reader does", () => {
		for (const text of ["paused: yes", "paused: 'True'", "# a comment\r\n\r\npaused: true\r\n", "paused: true # set by hand"]) {
			expect(flagGate({ [FLAG]: text }).check().paused, text).toBe(true);
		}
	});

	it("falls back to unknown when by and at are absent", () => {
		expect(flagGate({ [FLAG]: "paused: true\n" }).check().reason).toBe(`paused by unknown since unknown (${FLAG})`);
	});

	it("fails closed on a file it cannot read, warning once", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const gate = flagGate({ [FLAG]: { error: "EACCES" } });
		const first = gate.check();
		expect(first.paused).toBe(true);
		expect(first.reason).toContain("cannot be read");
		expect(first.reason).toContain("EACCES");
		expect(gate.check()).toEqual(first);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("fails closed on a symlink, a folder and an oversized file", () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(flagGate({ [FLAG]: { symlink: true } }).check().reason).toContain("symlink");
		expect(flagGate({ [FLAG]: { folder: true } }).check().reason).toContain("not a plain file");
		expect(flagGate({ [FLAG]: `paused: false\nwhy: ${"x".repeat(5000)}\n` }).check().reason).toContain("over 4096 bytes");
	});

	it("fails closed on a malformed flag", () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const cases: Record<string, string> = {
			"paused true\n": "line 1",
			"paused: true\nwho: alex\n": 'unknown key "who"',
			"paused: true\npaused: false\n": 'key "paused" twice',
			"why: no key\n": 'no "paused" key',
			"": 'no "paused" key',
			"paused: off\n": "not true, false, yes or no",
			"paused: 1\n": "not true, false, yes or no",
			"  paused: true\n": "line 1",
		};
		for (const [text, expected] of Object.entries(cases)) {
			const state = flagGate({ [FLAG]: text }).check();
			expect(state.paused, JSON.stringify(text)).toBe(true);
			expect(state.reason, JSON.stringify(text)).toContain(expected);
		}
	});

	it("expands a leading ~ to the home folder", () => {
		const host = fakeHost({ [`${HOME}/flags/pause`]: "paused: true\n" });
		const gate = new PauseGate(emptyApp(), () => "", () => "~/flags/pause", () => host);
		expect(gate.check().paused).toBe(true);
		expect(host.reads).toEqual([`${HOME}/flags/pause`]);
		expect(expandHome("~", HOME)).toBe(HOME);
		expect(expandHome("~/a", `${HOME}/`)).toBe(`${HOME}/a`);
		expect(expandHome("/abs/~/x", HOME)).toBe("/abs/~/x");
	});

	it("fails closed on a path that is not absolute, ~user included", () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		for (const path of ["relative/pause", "~other/pause"]) {
			const state = flagGate({}, path).check();
			expect(state.paused, path).toBe(true);
			expect(state.reason, path).toContain("not absolute");
		}
	});

	it("does not read the pause note when a flag file is set", () => {
		const state = flagGate({}, FLAG, appWith({ paused: true })).check();
		expect(state.paused).toBe(false);
	});

	it("keeps the reason stable from one read to the next, so the skip log records once", () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const gate = flagGate({ [FLAG]: "garbage\n" });
		expect(gate.check().reason).toBe(gate.check().reason);
	});

	it("falls back to the pause note on a device without file system access", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const gate = new PauseGate(appWith({ paused: true }), () => PAUSE_PATH, () => FLAG, () => null);
		expect(gate.check().paused).toBe(true);
		gate.check();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("pause note is checked instead");
	});

	it("uses the pause note when the flag path is empty, and never touches the file system", () => {
		const host = fakeHost({ [FLAG]: "paused: true\n" });
		const gate = new PauseGate(appWith({ paused: false }), () => PAUSE_PATH, () => "  ", () => host);
		expect(gate.check().paused).toBe(false);
		expect(host.reads).toEqual([]);
		const noted = new PauseGate(appWith({ paused: true }), () => PAUSE_PATH, () => "", () => host);
		expect(noted.check().paused).toBe(true);
	});

	it("defaults to the note road when constructed without a flag path", () => {
		expect(new PauseGate(appWith({ paused: true }), () => PAUSE_PATH).check().paused).toBe(true);
	});
});

describe("parsePauseFlag", () => {
	it("splits a value on the first colon only", () => {
		expect(parsePauseFlag("paused: yes\nat: 2026-01-02T03:04:05-05:00\n")).toEqual({
			kind: "paused",
			reason: "paused by unknown since 2026-01-02T03:04:05-05:00",
		});
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
	const REASON = "paused by alex since 2026-09-22T07:38: vault maintenance";
	const NEW_REASON = "paused by alex since 2026-09-23T09:00: second pause";

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
