import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import TaskNotesWorkflowsPlugin from "../main";
import { HostNameStore } from "../src/hostGate";
import type { LoadedWorkflow, WorkflowRunOptions } from "../src/types";

/**
 * Drives the plugin's single run choke point with its collaborators replaced
 * by spies, so the test checks the real order: host first, no run record and
 * no engine run on a blocked host.
 */
function harness(machineName: string, host: string | undefined) {
	const plugin = Object.create(TaskNotesWorkflowsPlugin.prototype) as TaskNotesWorkflowsPlugin;
	const storage = new Map<string, unknown>();
	const app = {
		loadLocalStorage: (key: string) => storage.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
	};
	const names = new HostNameStore(app as never);
	if (machineName) names.set(machineName);

	const recordRun = vi.fn(async () => undefined);
	const runWorkflow = vi.fn(async (loaded: LoadedWorkflow) => ({
		workflowId: loaded.workflow!.id,
		status: "succeeded",
	}));
	const pauseCheck = vi.fn(() => ({ paused: false }));
	Object.assign(plugin, {
		hostNames: names,
		pauseGate: { check: pauseCheck },
		pauseSkips: { shouldRecord: () => true, markRecorded: () => undefined, clear: () => undefined },
		engine: { runWorkflow },
		runLogs: { recordRun },
		refreshWorkflowLastRun: vi.fn(async () => undefined),
		renderWorkflowBaseViews: vi.fn(async () => undefined),
		redactRunDetail: (detail: unknown) => detail,
	});

	const file = new TFile();
	file.path = "Workflows/board.md";
	const loaded = {
		file,
		body: "",
		source: "",
		sourceFormat: "runtime-v0.2",
		diagnostics: [],
		workflow: {
			type: "workflow",
			schemaVersion: 1,
			id: "board-hourly",
			name: "Board hourly",
			enabled: true,
			...(host ? { host } : {}),
			triggers: [],
			vars: {},
			conditions: [],
			steps: [],
			run: {
				mode: "sequential",
				concurrency: { group: "workflow", policy: "skip" },
				limits: {},
				onError: "stop",
				source: "tasknotes-workflows",
			},
		},
	} as unknown as LoadedWorkflow;

	const execute = (options: Partial<WorkflowRunOptions> = {}) =>
		(plugin as unknown as {
			executeWorkflow: (workflow: LoadedWorkflow, options: WorkflowRunOptions) => Promise<{ status: string }>;
		}).executeWorkflow(loaded, {
			trigger: { type: "cron", triggerType: "cron", event: "cron", actualAt: new Date().toISOString() },
			...options,
		} as WorkflowRunOptions);

	return { execute, recordRun, runWorkflow, pauseCheck };
}

describe("executeWorkflow and the host key", () => {
	it("runs and records on the named host", async () => {
		const h = harness("laptop", "Laptop");
		await h.execute();
		expect(h.runWorkflow).toHaveBeenCalledTimes(1);
		expect(h.recordRun).toHaveBeenCalledTimes(1);
	});

	it("on another host: no run, no run record, and the pause note is not even read", async () => {
		const h = harness("desktop", "laptop");
		for (let tick = 0; tick < 5; tick += 1) {
			const detail = await h.execute();
			expect(detail.status).toBe("skipped");
		}
		expect(h.runWorkflow).not.toHaveBeenCalled();
		expect(h.recordRun).not.toHaveBeenCalled();
		expect(h.pauseCheck).not.toHaveBeenCalled();
	});

	it("fails closed when this device has no name", async () => {
		const h = harness("", "laptop");
		const detail = await h.execute();
		expect(detail.status).toBe("skipped");
		expect(h.runWorkflow).not.toHaveBeenCalled();
		expect(h.recordRun).not.toHaveBeenCalled();
	});

	it("blocks a manual run too, without a record", async () => {
		const h = harness("desktop", "laptop");
		const detail = await h.execute({ manual: true });
		expect(detail.status).toBe("skipped");
		expect(h.runWorkflow).not.toHaveBeenCalled();
		expect(h.recordRun).not.toHaveBeenCalled();
	});

	it("runs a workflow with no host on any device, named or not", async () => {
		for (const machine of ["", "desktop"]) {
			const h = harness(machine, undefined);
			await h.execute();
			expect(h.runWorkflow).toHaveBeenCalledTimes(1);
			expect(h.recordRun).toHaveBeenCalledTimes(1);
		}
	});
});
