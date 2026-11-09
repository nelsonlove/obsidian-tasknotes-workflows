import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCodeStepPolicy } from "../src/codePolicy";
import { StepRegistry } from "../src/stepRegistry";
import { WorkflowEngine } from "../src/workflowEngine";
import type { LoadedWorkflow, WorkflowStep } from "../src/types";

type ExecCallback = (error: unknown, stdout: string, stderr: string) => void;

/** A fake `child_process.execFile` that "runs" `exit N` / `echo X` commands. */
function fakeExecFile(file: string, args: readonly string[], _options: unknown, callback: ExecCallback): void {
	void file;
	const command = args[1] ?? "";
	const exit = /^exit (\d+)$/.exec(command);
	if (exit) {
		const code = Number(exit[1]);
		if (code === 0) callback(null, "", "");
		else callback(Object.assign(new Error(`Command failed: ${command}`), { code }), "", `failed with ${code}\n`);
		return;
	}
	callback(null, `${command.replace(/^echo /, "")}\n`, "");
}

function shellStep(id: string, command: string): WorkflowStep {
	return { id, type: "shell.run", input: { command } };
}

function workflow(steps: WorkflowStep[], onError: "stop" | "continue" = "stop"): LoadedWorkflow {
	return {
		file: { path: "TaskNotes/Workflows/shell.md", basename: "shell" } as LoadedWorkflow["file"],
		body: "",
		source: "",
		sourceFormat: "runtime-v0.2",
		diagnostics: [],
		workflow: {
			type: "workflow",
			schemaVersion: 1,
			id: "shell",
			name: "Shell",
			enabled: true,
			triggers: [{ id: "manual", type: "manual" }],
			vars: {},
			conditions: [],
			steps,
			run: {
				mode: "sequential",
				concurrency: { group: "workflow", policy: "skip" },
				source: "tasknotes-workflows",
				limits: { maxItems: 5 },
				onError,
			},
		},
	};
}

async function run(loaded: LoadedWorkflow) {
	const engine = new WorkflowEngine(new StepRegistry(), () => null);
	return engine.runWorkflow(loaded, { trigger: { type: "manual", event: "manual" } });
}

describe("shell.run exit status decides the run status", () => {
	const holder = globalThis as { window?: unknown };
	let originalWindow: unknown;

	beforeEach(() => {
		setCodeStepPolicy({ enabled: true });
		originalWindow = holder.window;
		holder.window = { require: (id: string) => (id === "child_process" ? { execFile: fakeExecFile } : undefined) };
	});

	afterEach(() => {
		setCodeStepPolicy({ enabled: false });
		holder.window = originalWindow;
	});

	it("fails the run when the command exits 3, recording the step's exit code and error", async () => {
		const result = await run(workflow([shellStep("probe", "exit 3")]));

		expect(result.status).toBe("failed");
		expect(result.error).toBe("shell.run exited with code 3: failed with 3");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]).toEqual(
			expect.objectContaining({
				id: "probe",
				status: "failed",
				error: "shell.run exited with code 3: failed with 3",
				errorCode: "shell_nonzero_exit",
				errorDetails: { exitCode: 3 },
				output: { stdout: "", stderr: "failed with 3\n", exitCode: 3, ok: false },
			})
		);
	});

	it("keeps a command that exits 0 a successful run", async () => {
		const result = await run(workflow([shellStep("probe", "exit 0")]));

		expect(result.status).toBe("success");
		expect(result.error).toBeUndefined();
		expect(result.steps[0]).toEqual(
			expect.objectContaining({
				status: "success",
				output: { stdout: "", stderr: "", exitCode: 0, ok: true },
			})
		);
	});

	it("stops at an earlier failing step under onError: stop, so later steps never run", async () => {
		const result = await run(workflow([shellStep("first", "exit 2"), shellStep("second", "echo after")]));

		expect(result.status).toBe("failed");
		expect(result.steps.map((step) => [step.id, step.status])).toEqual([["first", "failed"]]);
	});

	it("leaves onError: continue as it is: the failed step is recorded and later steps still run", async () => {
		const result = await run(
			workflow(
				[
					shellStep("first", "exit 2"),
					shellStep("second", "echo code={{steps.first.output.exitCode}} ok={{steps.first.output.ok}}"),
				],
				"continue"
			)
		);

		expect(result.status).toBe("success");
		expect(result.steps.map((step) => [step.id, step.status])).toEqual([
			["first", "failed"],
			["second", "success"],
		]);
		expect(result.steps[0]?.errorDetails).toEqual({ exitCode: 2 });
		// A later step can still branch on the failed command's result.
		expect(result.steps[1]?.output).toEqual(expect.objectContaining({ stdout: "code=2 ok=false\n" }));
	});

	it("puts only the last stderr line in the run error, without a carriage return", async () => {
		const holderWindow = globalThis as { window?: unknown };
		holderWindow.window = {
			require: (id: string) =>
				id === "child_process"
					? {
							execFile: (_f: string, _a: readonly string[], _o: unknown, callback: ExecCallback) =>
								callback(Object.assign(new Error("failed"), { code: 4 }), "", "line one\r\nline two\r\n"),
						}
					: undefined,
		};
		const result = await run(workflow([shellStep("probe", "anything")]));

		expect(result.status).toBe("failed");
		expect(result.error).toBe("shell.run exited with code 4: line two");
	});
});
