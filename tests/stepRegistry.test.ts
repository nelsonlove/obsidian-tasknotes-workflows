import { afterEach, describe, expect, it } from "vitest";
import { StepRegistry } from "../src/stepRegistry";
import { setCodeStepPolicy } from "../src/codePolicy";
import type { StepExecutionContext } from "../src/types";

describe("step registry", () => {
	it("localizes step metadata with fallback to built-in English", () => {
		const registry = new StepRegistry((key) => {
			if (key === "steps.definitions.task.get.label") return "Translated task lookup";
			if (key === "steps.common.task.label") return "Translated task path";
			return key;
		});

		const step = registry.get("task.get");

		expect(step?.label).toBe("Translated task lookup");
		expect(step?.description).toBe("Reads one task by path.");
		expect(step?.inputFields[0]?.label).toBe("Translated task path");
	});

	it("describes expected inputs and outputs for editor scaffolding", () => {
		const registry = new StepRegistry();
		const patch = registry.get("task.patch");
		const startTimer = registry.get("time.start");
		const subtasks = registry.get("task.subtasks");
		const createNote = registry.get("obsidian.createNote");

		expect(patch?.inputFields.map((field) => field.key)).toEqual(["task", "patch"]);
		expect(patch?.outputFields.map((field) => field.key)).toEqual(["task", "path"]);
		expect(registry.get("task.query")?.inputFields[0]?.type).toBe("taskQuery");
		expect(registry.get("task.query")?.outputFields.map((field) => field.key)).toEqual([
			"tasks",
			"count",
			"total",
			"matched",
			"returned",
			"groups",
			"groupPaths",
			"query",
			"warnings",
		]);
		expect(startTimer?.category).toBe("Time tracking");
		expect(startTimer?.inputFields.some((field) => field.key === "options.description")).toBe(true);
		expect(subtasks?.category).toBe("Task relationships");
		expect(subtasks?.outputFields.map((field) => field.key)).toEqual(["tasks", "count"]);
		expect(createNote?.category).toBe("Obsidian");
		expect(createNote?.inputFields.map((field) => field.key)).toEqual(["path", "content"]);
		expect(createNote?.mutatesTasks).toBe(false);
		expect(createNote?.writesVault).toBe(true);
	});
});

describe("js.run step", () => {
	afterEach(() => setCodeStepPolicy({ enabled: false }));

	function context(app: unknown): StepExecutionContext {
		return { dryRun: false, obsidian: { app } } as unknown as StepExecutionContext;
	}

	it("registers with a code input, a result output, and marks itself as writing the vault", () => {
		const step = new StepRegistry().get("js.run");
		expect(step?.category).toBe("Obsidian");
		expect(step?.inputFields.map((field) => field.key)).toEqual(["code"]);
		expect(step?.outputFields.map((field) => field.key)).toEqual(["result"]);
		expect(step?.writesVault).toBe(true);
	});

	it("refuses to execute when code steps are disabled", async () => {
		setCodeStepPolicy({ enabled: false });
		const step = new StepRegistry().get("js.run");
		await expect(step?.run({ code: "return 1;" }, context({}))).rejects.toThrow(/disabled/i);
	});

	it("evaluates the snippet with app + input in scope and returns its result", async () => {
		setCodeStepPolicy({ enabled: true });
		const step = new StepRegistry().get("js.run");
		const output = (await step?.run(
			{ code: "return app.marker + input.n;", n: 8 },
			context({ marker: 42 })
		)) as { result: unknown };
		expect(output.result).toBe(50);
	});

	it("does not execute during a dry run", async () => {
		setCodeStepPolicy({ enabled: true });
		const step = new StepRegistry().get("js.run");
		const output = (await step?.run(
			{ code: "throw new Error('should not run');" },
			{ dryRun: true, obsidian: { app: {} } } as unknown as StepExecutionContext
		)) as { dryRun?: boolean };
		expect(output.dryRun).toBe(true);
	});
});

describe("shell.run step", () => {
	afterEach(() => setCodeStepPolicy({ enabled: false }));

	const ctx = { dryRun: false, obsidian: { app: undefined } } as unknown as StepExecutionContext;

	type ExecFileStub = (
		file: string,
		args: readonly string[],
		options: unknown,
		callback: (error: unknown, stdout: string, stderr: string) => void
	) => void;

	function withFakeChildProcess<T>(execFile: ExecFileStub, fn: () => Promise<T>): Promise<T> {
		// eslint-disable-next-line obsidianmd/no-global-this -- stubbing the desktop `window.require` in a Node test
		const holder = globalThis as { window?: unknown };
		const original = holder.window;
		holder.window = { require: (id: string) => (id === "child_process" ? { execFile } : undefined) };
		return fn().finally(() => {
			holder.window = original;
		});
	}

	it("registers with command/cwd/timeout inputs and stdout/stderr/exit/ok outputs", () => {
		const step = new StepRegistry().get("shell.run");
		expect(step?.category).toBe("Obsidian");
		expect(step?.inputFields.map((field) => field.key)).toEqual(["command", "cwd", "timeoutMs"]);
		expect(step?.outputFields.map((field) => field.key)).toEqual(["stdout", "stderr", "exitCode", "ok"]);
		expect(step?.writesVault).toBe(false);
	});

	it("refuses to execute when code steps are disabled", async () => {
		setCodeStepPolicy({ enabled: false });
		const step = new StepRegistry().get("shell.run");
		await expect(step?.run({ command: "echo hi" }, ctx)).rejects.toThrow(/disabled/i);
	});

	it("does not execute during a dry run", async () => {
		setCodeStepPolicy({ enabled: true });
		const step = new StepRegistry().get("shell.run");
		const output = (await step?.run({ command: "echo hi" }, { ...ctx, dryRun: true })) as {
			dryRun?: boolean;
		};
		expect(output.dryRun).toBe(true);
	});

	it("runs the command through a login shell and returns stdout + exit 0", async () => {
		setCodeStepPolicy({ enabled: true });
		const step = new StepRegistry().get("shell.run");
		let seenFile = "";
		let seenArgs: readonly string[] = [];
		const output = (await withFakeChildProcess(
			(file, args, _options, callback) => {
				seenFile = file;
				seenArgs = args;
				callback(null, "done\n", "");
			},
			() => step!.run({ command: "echo done" }, ctx)
		)) as { stdout: string; exitCode: number; ok: boolean };
		expect(seenFile).toBe("/bin/zsh");
		expect(seenArgs).toEqual(["-lc", "echo done"]);
		expect(output.stdout).toBe("done\n");
		expect(output.exitCode).toBe(0);
		expect(output.ok).toBe(true);
	});

	it("returns a non-zero exit code without throwing", async () => {
		setCodeStepPolicy({ enabled: true });
		const step = new StepRegistry().get("shell.run");
		const output = (await withFakeChildProcess(
			(_file, _args, _options, callback) =>
				callback(Object.assign(new Error("exit 3"), { code: 3 }), "", "boom"),
			() => step!.run({ command: "exit 3" }, ctx)
		)) as { exitCode: number; ok: boolean; stderr: string };
		expect(output.exitCode).toBe(3);
		expect(output.ok).toBe(false);
		expect(output.stderr).toBe("boom");
	});

	it("requires desktop Obsidian (throws when Node is unavailable)", async () => {
		setCodeStepPolicy({ enabled: true });
		const step = new StepRegistry().get("shell.run");
		await expect(step?.run({ command: "echo hi" }, ctx)).rejects.toThrow(/desktop/i);
	});
});

describe("obsidian.runCommand step", () => {
	function context(executeCommandById: (id: string) => boolean): StepExecutionContext {
		return {
			dryRun: false,
			obsidian: { app: { commands: { executeCommandById } } },
		} as unknown as StepExecutionContext;
	}

	it("registers with a commandId input and ran/commandId outputs, ungated", () => {
		const step = new StepRegistry().get("obsidian.runCommand");
		expect(step?.category).toBe("Obsidian");
		expect(step?.inputFields.map((field) => field.key)).toEqual(["commandId"]);
		expect(step?.outputFields.map((field) => field.key)).toEqual(["ran", "commandId"]);
	});

	it("dispatches the command and reports whether it ran", async () => {
		const step = new StepRegistry().get("obsidian.runCommand");
		let dispatched = "";
		const output = (await step?.run(
			{ commandId: "editor:save-file" },
			context((id) => {
				dispatched = id;
				return true;
			})
		)) as { ran: boolean; commandId: string };
		expect(dispatched).toBe("editor:save-file");
		expect(output).toEqual({ ran: true, commandId: "editor:save-file" });
	});

	it("reports ran=false for an unknown command", async () => {
		const step = new StepRegistry().get("obsidian.runCommand");
		const output = (await step?.run({ commandId: "nope:missing" }, context(() => false))) as {
			ran: boolean;
		};
		expect(output.ran).toBe(false);
	});
});
