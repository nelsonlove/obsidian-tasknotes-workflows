import type { App } from "obsidian";

/**
 * The workflow-level `host` key: a workflow that names a machine runs only on
 * the device whose configured name matches. It exists so a clock-triggered
 * workflow that rewrites a shared note has one writer when the same vault is
 * open on several devices through a sync service.
 *
 * The device's name is kept in Obsidian's per-vault, per-device local storage
 * (`app.loadLocalStorage`), never in the plugin's `data.json`: `data.json`
 * lives inside the vault's config folder and can be copied to every device by
 * the same sync that makes the gate necessary, which would give all devices
 * one name.
 *
 * The gate fails closed. A workflow with `host` set does not run on a device
 * whose name is unset; a missing name never means "run everywhere".
 */

/** Local-storage key for this device's name. Scoped per vault by Obsidian. */
export const HOST_NAME_STORAGE_KEY = "tasknotes-workflows-host-name";

/** Frontmatter key on a workflow note. */
export const HOST_FRONTMATTER_KEY = "host";

/** Trims and lower-cases a device name; the match ignores case and edge spaces. */
export function normalizeHostName(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export type HostDecision =
	| { allowed: true }
	| { allowed: false; reason: "unset" | "mismatch"; host: string; machine: string };

/**
 * Decides whether a workflow may run on this device.
 *
 * - No `host` on the workflow: it runs everywhere, as before this key existed.
 * - `host` set, this device's name unset: it does not run (fail closed).
 * - `host` set: it runs only when the two names match, ignoring case.
 */
export function decideHost(workflowHost: string | undefined, machineName: string): HostDecision {
	const host = normalizeHostName(workflowHost);
	if (host.length === 0) return { allowed: true };
	const machine = normalizeHostName(machineName);
	if (machine.length === 0) return { allowed: false, reason: "unset", host, machine };
	if (machine !== host) return { allowed: false, reason: "mismatch", host, machine };
	return { allowed: true };
}

/** Human-readable reason for a blocked run, for a notice on a manual run. */
export function hostBlockedMessage(decision: Extract<HostDecision, { allowed: false }>): string {
	if (decision.reason === "unset") {
		return `This workflow runs only on "${decision.host}", and this device has no machine name set (TaskNotes Workflows settings → Machine).`;
	}
	return `This workflow runs only on "${decision.host}"; this device is "${decision.machine}".`;
}

/**
 * Validates a `host` value read from frontmatter. Absent is fine (no gate). A
 * present value must be a non-empty string: anything else is an error, so the
 * workflow is invalid and runs nowhere rather than everywhere.
 */
export function parseHostValue(value: unknown): { host?: string; error?: string } {
	if (value === undefined || value === null) return {};
	if (typeof value !== "string") {
		return { error: "host must be a single machine name (a string)." };
	}
	const host = value.trim();
	if (host.length === 0) return { error: "host must not be empty; remove the key to run on every device." };
	return { host };
}

/** Reads and writes this device's name in Obsidian's per-device local storage. */
export class HostNameStore {
	constructor(private readonly app: App) {}

	get(): string {
		try {
			const value: unknown = this.app.loadLocalStorage(HOST_NAME_STORAGE_KEY);
			return typeof value === "string" ? value.trim() : "";
		} catch {
			return "";
		}
	}

	set(value: string): void {
		const name = value.trim();
		this.app.saveLocalStorage(HOST_NAME_STORAGE_KEY, name.length > 0 ? name : null);
	}
}

/** Workflows that would be blocked on this device only because its name is unset. */
export function countNeedingMachineName(
	workflows: ReadonlyArray<{ host?: string; enabled: boolean }>,
	machineName: string
): number {
	if (normalizeHostName(machineName).length > 0) return 0;
	return workflows.filter((workflow) => workflow.enabled && normalizeHostName(workflow.host).length > 0).length;
}
