// EXIT: the fail-closed pause flag file road goes when the fleet pause has no other state than the key file and every reader reads it; renew by the monthly sweep.
import { normalizePath, TFile, TFolder, type App } from "obsidian";

export interface PauseState {
	/** True when the configured flag says paused, or (file road only) cannot be read. */
	paused: boolean;
	/** Human-readable reason recorded on the skipped run. */
	reason?: string;
}

const NOT_PAUSED: PauseState = { paused: false };

/** The largest pause flag file the gate reads; a bigger file is not a flag. */
export const MAX_FLAG_BYTES = 4096;

/** The few Node calls the file road needs, injected so tests need no disk. */
export interface PauseFlagFs {
	/** Like fs.lstatSync: throws an error with a `code` when the path cannot be read. */
	lstatSync(path: string): { isSymbolicLink(): boolean; isFile(): boolean; size: number };
	readFileSync(path: string, encoding: "utf8"): string;
}

export interface PauseFlagHost {
	fs: PauseFlagFs;
	homedir: string;
}

/**
 * Node's fs and the home folder, on desktop. Returns null on mobile, where the
 * plugin has no Node: the gate then falls back to the pause note. Loaded with
 * `window.require` at call time, as shell.run does, so the plugin still loads
 * on mobile. Throws when Node is there but fs or os cannot be loaded; the
 * gate reads that as a flag it cannot read, so as a pause.
 */
export function desktopFlagHost(): PauseFlagHost | null {
	const nodeRequire =
		typeof window !== "undefined"
			? (window as unknown as { require?: (id: string) => unknown }).require
			: undefined;
	if (typeof nodeRequire !== "function") return null;
	const fs = nodeRequire("fs") as PauseFlagFs;
	const os = nodeRequire("os") as { homedir(): string };
	return { fs, homedir: os.homedir() };
}

/** Local-storage key for this device's pause flag path. Scoped per vault by Obsidian. */
export const PAUSE_FLAG_PATH_STORAGE_KEY = "tasknotes-workflows-pause-flag-path";

/**
 * This device's pause flag path, kept in Obsidian's per-vault, per-device
 * local storage (`app.loadLocalStorage`), never in the plugin's `data.json`.
 * The file lives on one machine; `data.json` can be copied to every device by
 * a sync service, and a device without the file would read "missing", so
 * "not paused", and stop reading the pause note too. Per device, each machine
 * opts in only where the file is.
 */
export class PauseFlagPathStore {
	private cached: string | null = null;

	constructor(private readonly app: App) {}

	get(): string {
		if (this.cached !== null) return this.cached;
		try {
			const value: unknown = this.app.loadLocalStorage(PAUSE_FLAG_PATH_STORAGE_KEY);
			this.cached = typeof value === "string" ? value.trim() : "";
		} catch {
			this.cached = "";
		}
		return this.cached;
	}

	set(value: string): void {
		const path = value.trim();
		this.app.saveLocalStorage(PAUSE_FLAG_PATH_STORAGE_KEY, path.length > 0 ? path : null);
		this.cached = path;
	}
}

/**
 * The pause check. Two roads, chosen by settings:
 *
 * - The flag FILE (setting "Pause flag file", per device, desktop only): a small
 *   `key: value` file outside the vault. It FAILS CLOSED: a file that exists
 *   but cannot be read or parsed is a pause, because a pause is a human saying
 *   stop and "I could not tell" must not mean "carry on". A missing file is
 *   not a pause. When this setting is set, the note is not read.
 * - The flag NOTE (setting "Pause note"): a vault note whose `paused`
 *   property says stop. Used when no flag file is set, and on mobile, where
 *   there is no file system access.
 *
 * The note road is deliberately fail-open. Inside Obsidian the metadata cache
 * is warm only after the vault finishes indexing, so a missing file or an
 * empty cache is a startup race, not a human saying stop. Refusing runs on an
 * unreadable flag note would silently disable every workflow whenever the
 * plugin loads before the cache does. The file road has no such race, so it
 * fails closed.
 */
export class PauseGate {
	private warned = new Set<string>();
	/** The Node host, loaded once per plugin load. */
	private host: PauseFlagHost | null | undefined;

	constructor(
		private readonly app: App,
		private readonly getNotePath: () => string,
		private readonly getFlagPath: () => string = () => "",
		private readonly getFlagHost: () => PauseFlagHost | null = desktopFlagHost
	) {}

	check(): PauseState {
		const flagPath = this.getFlagPath().trim();
		if (flagPath.length > 0) {
			let host: PauseFlagHost | null;
			try {
				if (this.host === undefined) this.host = this.getFlagHost();
				host = this.host;
			} catch {
				// Node is there but fs or os would not load: a flag that cannot
				// be read, so a pause. Not cached, so the next run tries again.
				return this.unreadable(flagPath, "Node's file system could not be loaded");
			}
			if (host) return this.checkFlagFile(flagPath, host);
			this.warnOnce(
				`mobile:${flagPath}`,
				`TaskNotes Workflows: the pause flag file "${flagPath}" cannot be read on this device (no file system access); the pause note is checked instead.`
			);
		}
		return this.checkNote();
	}

	private checkFlagFile(configured: string, host: PauseFlagHost): PauseState {
		const path = expandHome(configured, host.homedir);
		const state = readPauseFlag(path, host.fs);
		if (state.kind === "absent") {
			// Missing is "not paused", by design. A missing FOLDER more likely
			// means a mistyped path, so say so once; it still is not a pause.
			if (!parentExists(path, host.fs)) {
				this.warnOnce(
					`nofolder:${path}`,
					`TaskNotes Workflows: the folder of the pause flag file "${path}" does not exist; check the path. Workflows run normally.`
				);
			}
			return NOT_PAUSED;
		}
		if (state.kind === "clear") return NOT_PAUSED;
		if (state.kind === "paused") return { paused: true, reason: state.reason };
		return this.unreadable(path, state.reason);
	}

	/**
	 * Fail closed. The reason stays the same from one read to the next, so the
	 * skip log records it once per workflow, not once per tick.
	 */
	private unreadable(path: string, why: string): PauseState {
		const reason = `the pause flag cannot be read, so runs are held: ${why} (${path})`;
		this.warnOnce(`bad:${path}:${why}`, `TaskNotes Workflows: ${reason}.`);
		return { paused: true, reason };
	}

	private checkNote(): PauseState {
		const configured = this.getNotePath().trim();
		if (configured.length === 0) return NOT_PAUSED;

		const path = normalizePath(configured);
		const file = this.app.vault.getAbstractFileByPath(path);
		const isNote = file instanceof TFile && file.extension === "md";
		const frontmatter = isNote
			? this.app.metadataCache.getFileCache(file)?.frontmatter
			: undefined;
		if (!frontmatter) {
			this.warnOnce(
				`note:${path}`,
				`TaskNotes Workflows: the pause note "${path}" ${unreadableReason(file, isNote)}; workflows run normally.`
			);
			return NOT_PAUSED;
		}
		if (!isPausedValue(frontmatter.paused)) return NOT_PAUSED;
		return { paused: true, reason: pauseReason(path, frontmatter) };
	}

	private warnOnce(key: string, message: string): void {
		// One warning per plugin load per path and cause, not one per run: a
		// scheduled vault would otherwise log the same line every minute.
		if (this.warned.has(key)) return;
		this.warned.add(key);
		console.warn(message);
	}
}

/**
 * Expands a leading `~` or `~/` to the home folder. Any other `~` form
 * (`~user`) is left alone, and so is read as a relative path.
 */
export function expandHome(path: string, homedir: string): string {
	if (path === "~") return homedir;
	if (path.startsWith("~/")) return `${homedir.replace(/\/+$/, "")}/${path.slice(2)}`;
	return path;
}

function isAbsolutePath(path: string): boolean {
	// POSIX, or a Windows drive or UNC path.
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export type PauseFlagRead =
	| { kind: "absent" }
	| { kind: "clear" }
	| { kind: "paused"; reason: string }
	| { kind: "bad"; reason: string };

/**
 * Reads the pause flag file at an absolute path. Missing is `absent`; every
 * other failure is `bad`, which the gate treats as paused.
 */
export function readPauseFlag(path: string, fs: PauseFlagFs): PauseFlagRead {
	if (!isAbsolutePath(path)) {
		return { kind: "bad", reason: "the path is not absolute" };
	}
	let stat: ReturnType<PauseFlagFs["lstatSync"]>;
	try {
		stat = fs.lstatSync(path);
	} catch (error) {
		return readFailure(error);
	}
	if (stat.isSymbolicLink()) return { kind: "bad", reason: "it is a symlink, not a plain file" };
	if (!stat.isFile()) return { kind: "bad", reason: "it is not a plain file" };
	if (stat.size > MAX_FLAG_BYTES) return { kind: "bad", reason: `it is over ${MAX_FLAG_BYTES} bytes` };
	let text: string;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (error) {
		// Gone between the two calls reads as missing, as from lstat.
		return readFailure(error);
	}
	const parsed = parsePauseFlag(text);
	if (parsed.kind !== "paused") return parsed;
	return { kind: "paused", reason: `${parsed.reason} (${path})` };
}

/** Only "no such file" is missing; every other error is a flag that cannot be read. */
function readFailure(error: unknown): PauseFlagRead {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "ENOENT") return { kind: "absent" };
	return { kind: "bad", reason: `it cannot be read (${typeof code === "string" ? code : "unknown error"})` };
}

function parentExists(path: string, fs: PauseFlagFs): boolean {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (slash <= 0) return true;
	try {
		fs.lstatSync(path.slice(0, slash));
		return true;
	} catch {
		return false;
	}
}

const FLAG_KEYS = new Set(["paused", "why", "by", "at"]);

/**
 * Parses the flag file's text: one `key: value` per line; blank lines and
 * lines that begin with `#` are skipped. The keys are `paused` (required:
 * true, false, yes or no), `why`, `by` and `at`, each at most once. Any other
 * line or key, a repeated key, or another `paused` value is `bad`.
 */
export function parsePauseFlag(text: string): PauseFlagRead {
	const values = new Map<string, string>();
	const lines = text.replace(/\r/g, "").split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^[ \t]*$/.test(line) || /^[ \t]*#/.test(line)) continue;
		const match = /^([a-z][a-z0-9-]*):(.*)$/.exec(line);
		if (!match) return { kind: "bad", reason: `line ${index + 1} is not "key: value"` };
		const key = match[1] ?? "";
		if (!FLAG_KEYS.has(key)) return { kind: "bad", reason: `it has an unknown key "${key}"` };
		if (values.has(key)) return { kind: "bad", reason: `it names the key "${key}" twice` };
		values.set(key, match[2] ?? "");
	}
	const raw = values.get("paused");
	if (raw === undefined) return { kind: "bad", reason: `it has no "paused" key` };
	// The comment first, then the quotes: `paused: "false"  # resumed` reads false.
	const value = unquote(raw.trim().replace(/\s+#.*$/, "")).trim().toLowerCase();
	if (value === "false" || value === "no") return { kind: "clear" };
	if (value !== "true" && value !== "yes") {
		return { kind: "bad", reason: `its "paused" value is not true, false, yes or no` };
	}
	const by = flagText(values.get("by")) ?? "unknown";
	const at = flagText(values.get("at")) ?? "unknown";
	const why = flagText(values.get("why"));
	const head = `paused by ${by} since ${at}`;
	return { kind: "paused", reason: why ? `${head}: ${why}` : head };
}

function unquote(value: string): string {
	const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
	return quoted ? (quoted[1] ?? "") : value;
}

function flagText(raw: string | undefined): string | null {
	if (raw === undefined) return null;
	const value = unquote(raw.trim()).trim();
	return value.length > 0 ? value : null;
}

/** Says what is actually at the configured path, not merely that it failed. */
function unreadableReason(file: unknown, isNote: boolean): string {
	if (file instanceof TFolder) return "is a folder, not a note";
	if (file instanceof TFile && !isNote) return "is not a markdown note";
	if (file === null || file === undefined) return "was not found";
	return "has no frontmatter";
}

/**
 * Remembers which pause each workflow was last logged against, so a pause that
 * lasts hours leaves one skipped run per workflow instead of one per tick. An
 * interval workflow running every 30 seconds would otherwise write 2,880
 * records a day and push the vault's real run history out through retention.
 */
export class PauseSkipLog {
	private readonly lastReasons = new Map<string, string>();

	/**
	 * True the first time a workflow is blocked, and again if the pause
	 * changes. Asking does not mark: the caller marks with
	 * {@link markRecorded} once the write has landed, so a failed write is
	 * retried on the next tick rather than being lost.
	 */
	shouldRecord(workflowId: string, reason: string): boolean {
		return this.lastReasons.get(workflowId) !== reason;
	}

	/** Records that this pause has been written to the run log. */
	markRecorded(workflowId: string, reason: string): void {
		this.lastReasons.set(workflowId, reason);
	}

	/** Called when a run is not blocked, so the next pause records again. */
	clear(workflowId: string): void {
		this.lastReasons.delete(workflowId);
	}
}

/**
 * `true`, and the strings a human types into frontmatter by hand. Anything
 * else — false, absent, "off", a number — is not a pause.
 */
export function isPausedValue(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "yes";
}

function pauseReason(path: string, frontmatter: Record<string, unknown>): string {
	const by = optionalText(frontmatter["paused-by"]) ?? "unknown";
	const since = optionalText(frontmatter["paused-since"]) ?? "unknown";
	const why = optionalText(frontmatter["paused-why"]);
	const head = `paused by ${by} since ${since}`;
	return why ? `${head}: ${why} (${path})` : `${head} (${path})`;
}

function optionalText(value: unknown): string | null {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}
