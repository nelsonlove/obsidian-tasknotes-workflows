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
