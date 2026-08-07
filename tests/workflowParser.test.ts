import { describe, expect, it } from "vitest";
import { validateRuntimeRecord } from "@callumalpass/mdbase-runtime";
import { parse } from "yaml";
import { parseMarkdownFrontmatter } from "../src/frontmatter";
import { parseWorkflowDefinition, pickAllowedFrontmatter, workflowToFrontmatter } from "../src/workflowParser";

describe("workflow parser", () => {
	it("parses a valid workflow definition", () => {
		const markdown = `---
type: workflow
schemaVersion: 1
id: auto-start
name: Auto start
enabled: true
triggers:
  - id: status
    type: tasknotes.event
    event: task.status.changed
    to: active
steps:
  - id: start
    type: time.start
    input:
      task: "{{event.after.path}}"
run:
  mode: sequential
  concurrency:
    group: workflow
    policy: skip
  limits:
    maxItems: 50
  source: tasknotes-workflows
  onError: stop
---

# Auto start
`;

		const parsed = parseMarkdownFrontmatter(markdown);
		const result = parseWorkflowDefinition(parsed.data, markdown);

		expect(result.diagnostics).toEqual([]);
		expect(result.workflow?.id).toBe("auto-start");
		expect(result.workflow?.triggers[0]?.type).toBe("tasknotes.event");
		expect(result.workflow?.steps[0]?.type).toBe("time.start");
		expect(result.sourceFormat).toBe("tasknotes-v1");
	});

	it("round-trips contract events and action provider selection", () => {
		const result = parseWorkflowDefinition({
			type: "workflow",
			schemaVersion: 1,
			id: "completed-to-canvas",
			name: "Completed to canvas",
			enabled: true,
			triggers: [{
				id: "completed",
				type: "contract.event",
				contract: "tasknotes.task.completed",
				version: "^1.0.0",
				source: "tasknotes",
			}],
			steps: [{
				id: "card",
				type: "canvas.card.create",
				contract: { version: "^1.0.0" },
				provider: { application: "canvas-bases" },
				input: {
					canvas_path: "Completed.canvas",
					card: { kind: "file", file: "{{event.data.task_path}}" },
				},
			}],
			run: {
				mode: "sequential",
				concurrency: { group: "workflow", policy: "queue" },
				limits: { maxItems: 1 },
				source: "tasknotes-workflows",
				onError: "stop",
			},
		}, "");

		expect(result.diagnostics).toEqual([]);
		expect(result.workflow?.triggers[0]).toMatchObject({
			type: "contract.event",
			contract: "tasknotes.task.completed",
			version: "^1.0.0",
			source: "tasknotes",
		});
		const frontmatter = workflowToFrontmatter(result.workflow!);
		const canonical = parseWorkflowDefinition(parse(frontmatter), frontmatter);
		expect(canonical.diagnostics).toEqual([]);
		expect(canonical.workflow?.steps[0]).toMatchObject({
			type: "canvas.card.create",
			contract: { version: "^1.0.0" },
			provider: { application: "canvas-bases" },
		});
	});

	it("writes canonical mdbase runtime workflow records and reads TaskNotes extensions", () => {
		const legacy = parseWorkflowDefinition({
			type: "tasknotes-workflow",
			schemaVersion: 1,
			id: "daily-review",
			name: "Daily review",
			enabled: false,
			triggers: [{ id: "daily", type: "cron", schedule: "0 9 * * *", timezone: "local" }],
			conditions: [{ field: "event.path", operator: "exists" }],
			steps: [{
				id: "show",
				type: "notice.show",
				forEach: "{{steps.query.tasks}}",
				input: { message: "{{event.path}}" },
			}],
			run: { mode: "sequential", noOverlap: true, maxTasks: 10, source: "tasknotes-workflows", onError: "stop" },
		}, "");
		expect(legacy.workflow).not.toBeNull();

		const frontmatter = workflowToFrontmatter(legacy.workflow!);
		const record = parse(frontmatter) as Record<string, unknown>;
		expect(validateRuntimeRecord(record)).toMatchObject({ valid: true });
		expect(record).toMatchObject({
			type: "runtime_workflow",
			version: "1.0.0",
			triggers: [{
				id: "daily",
				event: { id: "tasknotes-workflows.schedule.cron", version: "1.0.0" },
			}],
			steps: [{
				id: "show",
				action: { id: "notice.show", version: "1.0.0" },
				for_each: { items: { $expr: "steps.query.output.tasks" } },
			}],
			run: { limits: { max_items: 10 }, on_error: "stop" },
		});
		expect(record).not.toHaveProperty("schemaVersion");

		const canonical = parseWorkflowDefinition(record, frontmatter);
		expect(canonical.diagnostics).toEqual([]);
		expect(canonical.sourceFormat).toBe("runtime-v0.2");
		expect(canonical.workflow?.triggers[0]).toMatchObject({ type: "cron", schedule: "0 9 * * *" });
		expect(canonical.workflow?.steps[0]).toMatchObject({ type: "notice.show" });
		expect(canonical.workflow?.conditions).toEqual([{ field: "event.path", operator: "exists" }]);
	});

	it("rejects a noncanonical record that mixes runtime and TaskNotes version markers", () => {
		const result = parseWorkflowDefinition({
			type: "runtime_workflow",
			version: "1.0.0",
			schemaVersion: 1,
			id: "ambiguous",
			name: "Ambiguous",
			enabled: false,
			triggers: [],
			steps: [],
		}, "");
		expect(result.sourceFormat).toBe("unknown");
		expect(result.workflow).toBeNull();
	});

	it("rejects missing required fields", () => {
		const result = parseWorkflowDefinition({ type: "workflow" }, "");

		expect(result.workflow).toBeNull();
		expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	it("accepts additional Obsidian workspace events", () => {
		const result = parseWorkflowDefinition(
			{
				type: "workflow",
				schemaVersion: 1,
				id: "active-leaf",
				name: "Active leaf",
				enabled: true,
				triggers: [
					{ id: "leaf", type: "obsidian.workspace", event: "active-leaf-change", path: { glob: "**/*.md" } },
				],
				steps: [{ id: "notice", type: "notice.show", input: { message: "Changed" } }],
				run: {
					mode: "sequential",
					concurrency: { group: "workflow", policy: "skip" },
					limits: { maxItems: 50 },
					source: "tasknotes-workflows",
					onError: "stop",
				},
			},
			""
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.workflow?.triggers[0]).toMatchObject({
			type: "obsidian.workspace",
			event: "active-leaf-change",
		});
	});

	it("uses contract requirements and explicit source selection for portable events", () => {
		const result = parseWorkflowDefinition(
			{
				type: "workflow",
				schemaVersion: 1,
				id: "canvas-drop",
				name: "Canvas drop",
				enabled: true,
				triggers: [
					{
						id: "drop",
						type: "contract.event",
						contract: "canvas.drop",
						version: "^1.0.0",
						source: "canvas-bases",
					},
				],
				steps: [{ id: "notice", type: "notice.show", input: { message: "Dropped" } }],
				run: {
					mode: "sequential",
					concurrency: { group: "workflow", policy: "skip" },
					limits: { maxItems: 50 },
					source: "tasknotes-workflows",
					onError: "stop",
				},
			},
			""
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.workflow?.triggers[0]).toMatchObject({
			type: "contract.event",
			contract: "canvas.drop",
			version: "^1.0.0",
			source: "canvas-bases",
		});
	});

	it("accepts structured expressions in step inputs and forEach", () => {
		const result = parseWorkflowDefinition(
			{
				type: "workflow",
				schemaVersion: 1,
				id: "relative-date",
				name: "Relative date",
				enabled: true,
				triggers: [{ id: "manual", type: "manual" }],
				steps: [
					{
						id: "schedule",
						type: "task.setScheduled",
						forEach: { items: { $expr: "vars.tasks.slice(0, 5)" }, as: "task" },
						input: {
							task: "{{task.path}}",
							date: { $expr: 'date(event.after.due) - duration("1w")' },
						},
					},
				],
				run: {
					mode: "sequential",
					concurrency: { group: "workflow", policy: "skip" },
					limits: { maxItems: 50 },
					source: "tasknotes-workflows",
					onError: "stop",
				},
			},
			""
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.workflow?.steps[0]?.forEach).toEqual({
			items: { $expr: "vars.tasks.slice(0, 5)" },
			as: "task",
		});
	});

	it("diagnoses invalid expression syntax", () => {
		const result = parseWorkflowDefinition(
			{
				type: "workflow",
				schemaVersion: 1,
				id: "bad-expression",
				name: "Bad expression",
				enabled: true,
				triggers: [{ id: "manual", type: "manual" }],
				steps: [
					{
						id: "notice",
						type: "notice.show",
						input: { message: { $expr: "date(" } },
					},
				],
				run: {
					mode: "sequential",
					concurrency: { group: "workflow", policy: "skip" },
					limits: { maxItems: 50 },
					source: "tasknotes-workflows",
					onError: "stop",
				},
			},
			""
		);

		expect(result.workflow).toBeNull();
		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.path === "steps[0].input.message.$expr" &&
					diagnostic.message.includes("Expected")
			)
		).toBe(true);
	});

	it("normalizes the released 0.1.x workflow shape", () => {
		const result = parseWorkflowDefinition(
			{
				type: "tasknotes-workflow",
				schemaVersion: 1,
				id: "legacy",
				name: "Legacy",
				enabled: true,
				triggers: [{ id: "status", type: "tasknotes.event", event: "task.status.changed" }],
				conditions: [{ $expr: 'trigger.after.status != "done"' }],
				steps: [
					{
						id: "notify",
						type: "notice.show",
						forEach: "{{steps.query-old.tasks}}",
						input: { message: "{{trigger.after.path}}" },
					},
				],
				run: { mode: "sequential", noOverlap: false, maxTasks: 10, source: "tasknotes-workflows", onError: "stop" },
			},
			""
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.workflow?.type).toBe("workflow");
		expect(result.workflow?.conditions[0]).toEqual({ id: undefined, $expr: 'event.after.status != "done"' });
		expect(result.workflow?.steps[0]?.forEach).toEqual({ items: '{{steps["query-old"].output.tasks}}' });
		expect(result.workflow?.steps[0]?.input).toEqual({ message: "{{event.after.path}}" });
		expect(result.workflow?.run.concurrency.policy).toBe("allow");
		expect(result.workflow?.run.limits.maxItems).toBe(10);
	});
});

describe("frontmatter allowlist", () => {
	function legacyData(extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			type: "workflow",
			schemaVersion: 1,
			id: "auto-start",
			name: "Auto start",
			enabled: true,
			triggers: [{ id: "manual-run", type: "manual" }],
			steps: [{ id: "notify", type: "notice.show", input: { message: "hi" } }],
			run: {
				mode: "sequential",
				concurrency: { group: "workflow", policy: "skip" },
				limits: { maxItems: 1 },
				onError: "stop",
				source: "tasknotes-workflows",
			},
			...extra,
		};
	}

	function runtimeData(extra: Record<string, unknown> = {}): Record<string, unknown> {
		const parsed = parseWorkflowDefinition(legacyData(), "");
		const record = parse(workflowToFrontmatter(parsed.workflow!)) as Record<string, unknown>;
		return { ...record, ...extra };
	}

	it("warns on unknown legacy top-level fields unless allowlisted", () => {
		const withoutAllowlist = parseWorkflowDefinition(legacyData({ uid: "20260806" }), "");
		expect(withoutAllowlist.diagnostics).toEqual([
			{ severity: "warning", path: "uid", message: 'Unknown top-level field "uid".' },
		]);

		const withAllowlist = parseWorkflowDefinition(legacyData({ uid: "20260806" }), "", {
			allowedFrontmatterKeys: ["uid"],
		});
		expect(withAllowlist.diagnostics).toEqual([]);
		expect(withAllowlist.workflow).not.toBeNull();
		expect(withAllowlist.workflow?.extensions).toBeUndefined();
	});

	it("still warns for legacy fields outside the allowlist", () => {
		const result = parseWorkflowDefinition(legacyData({ uid: "20260806", custom: "value" }), "", {
			allowedFrontmatterKeys: ["uid"],
		});
		expect(result.diagnostics).toEqual([
			{ severity: "warning", path: "custom", message: 'Unknown top-level field "custom".' },
		]);
	});

	it("accepts allowlisted keys on runtime records that would otherwise fail schema validation", () => {
		const record = runtimeData({ uid: "20260806", created: "2026-08-06" });

		const withoutAllowlist = parseWorkflowDefinition(record, "");
		expect(withoutAllowlist.workflow).toBeNull();
		expect(withoutAllowlist.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);

		const withAllowlist = parseWorkflowDefinition(record, "", {
			allowedFrontmatterKeys: ["uid", "created"],
		});
		expect(withAllowlist.diagnostics).toEqual([]);
		expect(withAllowlist.sourceFormat).toBe("runtime-v0.2");
		expect(withAllowlist.workflow?.id).toBe("auto-start");
	});

	it("still rejects runtime records with unknown keys outside the allowlist", () => {
		const record = runtimeData({ uid: "20260806", custom: "value" });
		const result = parseWorkflowDefinition(record, "", { allowedFrontmatterKeys: ["uid"] });
		expect(result.workflow).toBeNull();
		expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	it("serializes preserved frontmatter verbatim without letting it shadow workflow fields", () => {
		const parsed = parseWorkflowDefinition(legacyData(), "");
		const frontmatter = workflowToFrontmatter(parsed.workflow!, {
			uid: "20260806-abc",
			created: "2026-08-06T00:00:00Z",
			name: "should not win",
		});
		const record = parse(frontmatter) as Record<string, unknown>;
		expect(record.uid).toBe("20260806-abc");
		expect(record.created).toBe("2026-08-06T00:00:00Z");
		expect(record.name).toBe("Auto start");

		// Workflow record keys come first (type stays the leading line);
		// preserved vault keys follow the record.
		const keys = Object.keys(record);
		expect(keys[0]).toBe("type");
		expect(keys.indexOf("uid")).toBeGreaterThan(keys.indexOf("run"));
		expect(keys.indexOf("created")).toBeGreaterThan(keys.indexOf("run"));
		expect(frontmatter.startsWith("type:")).toBe(true);
	});

	it("round-trips allowlisted keys through parse, serialize, and re-parse", () => {
		const allowedFrontmatterKeys = ["uid", "created"];
		const original = runtimeData({ uid: "20260806-abc", created: "2026-08-06" });

		const parsed = parseWorkflowDefinition(original, "", { allowedFrontmatterKeys });
		expect(parsed.diagnostics).toEqual([]);

		const preserved = pickAllowedFrontmatter(original, allowedFrontmatterKeys);
		expect(preserved).toEqual({ uid: "20260806-abc", created: "2026-08-06" });

		const frontmatter = workflowToFrontmatter(parsed.workflow!, preserved);
		const reparsedRecord = parse(frontmatter) as Record<string, unknown>;
		expect(reparsedRecord.uid).toBe("20260806-abc");
		expect(reparsedRecord.created).toBe("2026-08-06");

		const reparsed = parseWorkflowDefinition(reparsedRecord, frontmatter, { allowedFrontmatterKeys });
		expect(reparsed.diagnostics).toEqual([]);
		expect(reparsed.workflow?.id).toBe("auto-start");
	});

	it("treats reserved workflow-owned keys in the allowlist as inert", () => {
		// Even a raw, un-normalized allowlist cannot strip schema keys: the
		// legacy record keeps schemaVersion/type and parses as tasknotes-v1.
		const result = parseWorkflowDefinition(legacyData(), "", {
			allowedFrontmatterKeys: ["type", "schemaVersion", "version", "name", "uid"],
		});
		expect(result.diagnostics).toEqual([]);
		expect(result.sourceFormat).toBe("tasknotes-v1");
		expect(result.workflow?.name).toBe("Auto start");

		// And a runtime record keeps type/version, so it still validates.
		const runtime = parseWorkflowDefinition(runtimeData(), "", {
			allowedFrontmatterKeys: ["type", "version"],
		});
		expect(runtime.diagnostics).toEqual([]);
		expect(runtime.sourceFormat).toBe("runtime-v0.2");
	});

	it("never picks reserved keys for preservation", () => {
		expect(
			pickAllowedFrontmatter(
				{ type: "runtime_workflow", version: "1.0.0", "x-tasknotes": {}, uid: "x" },
				["type", "version", "x-tasknotes", "uid"]
			)
		).toEqual({ uid: "x" });
	});

	it("picks only allowlisted keys that are present", () => {
		expect(pickAllowedFrontmatter({ uid: "x", name: "n" }, ["uid", "created"])).toEqual({ uid: "x" });
		expect(pickAllowedFrontmatter({ uid: "x" }, [])).toEqual({});
		expect(pickAllowedFrontmatter(null, ["uid"])).toEqual({});
	});
});
