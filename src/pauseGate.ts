import { normalizePath, TFile, type App } from "obsidian";

export interface PauseState {
	/** True only when the pause note exists, is cached, and says paused. */
	paused: boolean;
	/** Human-readable reason recorded on the skipped run. */
	reason?: string;
}

const NOT_PAUSED: PauseState = { paused: false };

/**
 * The fleet pause: one flag note in the vault is the only state, and every
 * writer checks it before acting (see the vault's "Operator's console" spec).
 *
 * This gate is deliberately fail-open. Inside Obsidian the metadata cache is
 * warm only after the vault finishes indexing, so a missing file or an empty
 * cache is a startup race, not a human saying stop. Refusing runs on an
 * unreadable flag would silently disable every workflow whenever the plugin
 * loads before the cache does. The shell-side gate fails closed instead,
 * because there an unreadable flag means the vault is genuinely unavailable.
 */
export class PauseGate {
	private warnedPaths = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly getNotePath: () => string
	) {}

	check(): PauseState {
		const configured = this.getNotePath().trim();
		if (configured.length === 0) return NOT_PAUSED;

		const path = normalizePath(configured);
		const file = this.app.vault.getAbstractFileByPath(path);
		const frontmatter = file instanceof TFile
			? this.app.metadataCache.getFileCache(file)?.frontmatter
			: undefined;
		if (!frontmatter) {
			this.warnOnce(path, file instanceof TFile);
			return NOT_PAUSED;
		}
		if (!isPausedValue(frontmatter.paused)) return NOT_PAUSED;
		return { paused: true, reason: pauseReason(path, frontmatter) };
	}

	private warnOnce(path: string, fileExists: boolean): void {
		// One warning per plugin load per path, not one per run: a scheduled
		// vault would otherwise log the same line every minute.
		if (this.warnedPaths.has(path)) return;
		this.warnedPaths.add(path);
		console.warn(
			fileExists
				? `TaskNotes Workflows: the pause note "${path}" has no frontmatter; workflows run normally.`
				: `TaskNotes Workflows: the pause note "${path}" was not found; workflows run normally.`
		);
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
