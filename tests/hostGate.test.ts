import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateRuntimeRecord } from "@callumalpass/mdbase-runtime";
import {
	HOST_NAME_STORAGE_KEY,
	HostNameStore,
	countNeedingMachineName,
	decideHost,
	normalizeHostName,
	parseHostValue,
} from "../src/hostGate";
import { normalizeAllowedFrontmatterKeys } from "../src/settings";
import { normalizeNameKey, parseWorkflowDefinition, workflowToFrontmatter } from "../src/workflowParser";

/** The status board's shape: a runtime-v0.2 record with a cron trigger. */
function runtimeRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "runtime_workflow",
		id: "board-hourly",
		version: "1.0.0",
		name: "Board hourly",
		enabled: true,
		...extra,
		triggers: [
			{
				id: "every-hour",
				event: { id: "tasknotes-workflows.schedule.cron", version: "1.0.0" },
				"x-tasknotes": { type: "cron", schedule: "0 * * * *", timezone: "local" },
			},
		],
		steps: [{ id: "show", action: { id: "notice.show", version: "1.0.0" }, input: { message: "hi" } }],
		run: { concurrency: { group: "workflow", policy: "skip" }, on_error: "stop" },
	};
}

describe("decideHost", () => {
	it("runs everywhere when the workflow names no host", () => {
		expect(decideHost(undefined, "")).toEqual({ allowed: true });
		expect(decideHost(undefined, "laptop")).toEqual({ allowed: true });
		expect(decideHost("   ", "")).toEqual({ allowed: true });
	});

	it("runs when the names match, ignoring case and edge spaces", () => {
		expect(decideHost("laptop", "laptop")).toEqual({ allowed: true });
		expect(decideHost("Laptop", " LAPTOP ")).toEqual({ allowed: true });
	});

	it("does not run when the names differ", () => {
		expect(decideHost("laptop", "desktop")).toMatchObject({ allowed: false, reason: "mismatch" });
	});

	it("fails closed when the workflow names a host and this device has no name", () => {
		expect(decideHost("laptop", "")).toMatchObject({ allowed: false, reason: "unset" });
		expect(decideHost("laptop", "   ")).toMatchObject({ allowed: false, reason: "unset" });
	});

	it("never treats a prefix or a substring as a match", () => {
		expect(decideHost("laptop", "laptop-2").allowed).toBe(false);
		expect(decideHost("laptop-2", "laptop").allowed).toBe(false);
	});
});

describe("parseHostValue", () => {
	it("accepts an absent key and a non-empty string", () => {
		expect(parseHostValue(undefined)).toEqual({});
		expect(parseHostValue(null)).toEqual({});
		expect(parseHostValue(" laptop ")).toEqual({ host: "laptop" });
	});

	it("rejects anything that is not one non-empty name", () => {
		for (const value of ["", "  ", 1, true, ["laptop"], { name: "laptop" }]) {
			expect(parseHostValue(value).error, JSON.stringify(value)).toBeDefined();
		}
	});
});

describe("HostNameStore", () => {
	function appWithStorage(initial: Record<string, unknown> = {}) {
		const store = new Map<string, unknown>(Object.entries(initial));
		const app = {
			loadLocalStorage: (key: string) => (store.has(key) ? store.get(key) : null),
			saveLocalStorage: (key: string, value: unknown) => {
				if (value === null) store.delete(key);
				else store.set(key, value);
			},
		};
		return { app: app as never, store };
	}

	it("reads, writes and clears the name in local storage under its own key", () => {
		const { app, store } = appWithStorage();
		const names = new HostNameStore(app);
		expect(names.get()).toBe("");
		names.set("  laptop ");
		expect(store.get(HOST_NAME_STORAGE_KEY)).toBe("laptop");
		expect(names.get()).toBe("laptop");
		names.set("   ");
		expect(store.has(HOST_NAME_STORAGE_KEY)).toBe(false);
		expect(names.get()).toBe("");
	});

	it("reads a non-string or a throwing store as unset, so the gate fails closed", () => {
		expect(new HostNameStore(appWithStorage({ [HOST_NAME_STORAGE_KEY]: 42 }).app).get()).toBe("");
		const throwing = {
			loadLocalStorage: () => {
				throw new Error("no storage");
			},
		} as never;
		const name = new HostNameStore(throwing).get();
		expect(name).toBe("");
		expect(decideHost("laptop", name).allowed).toBe(false);
	});
});

describe("countNeedingMachineName", () => {
	it("counts enabled workflows with a host only while this device has no name", () => {
		const workflows = [
			{ enabled: true, host: "laptop" },
			{ enabled: false, host: "laptop" },
			{ enabled: true },
			{ enabled: true, host: "desktop" },
		];
		expect(countNeedingMachineName(workflows, "")).toBe(2);
		expect(countNeedingMachineName(workflows, "laptop")).toBe(0);
	});
});

describe("the host key in workflow notes", () => {
	it("parses on a runtime-v0.2 note without tripping the upstream schema", () => {
		const result = parseWorkflowDefinition(runtimeRecord({ host: "Laptop" }), "");
		expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
		expect(result.sourceFormat).toBe("runtime-v0.2");
		expect(result.workflow?.host).toBe("Laptop");
	});

	it("parses on a tasknotes-v1 note without an unknown-field warning", () => {
		const result = parseWorkflowDefinition(
			{
				type: "workflow",
				schemaVersion: 1,
				id: "legacy",
				name: "Legacy",
				enabled: true,
				host: "laptop",
				triggers: [{ id: "manual", type: "manual" }],
				steps: [{ id: "show", type: "notice.show", input: { message: "hi" } }],
			},
			""
		);
		expect(result.diagnostics.filter((d) => d.path === "host")).toEqual([]);
		expect(result.workflow?.host).toBe("laptop");
	});

	it("leaves host unset when the key is absent", () => {
		const result = parseWorkflowDefinition(runtimeRecord(), "");
		expect(result.workflow).not.toBeNull();
		expect(result.workflow?.host).toBeUndefined();
	});

	it("makes the workflow invalid, so it runs nowhere, when host is not one name", () => {
		for (const host of ["", ["laptop", "desktop"], 7]) {
			const result = parseWorkflowDefinition(runtimeRecord({ host }), "");
			expect(result.workflow, JSON.stringify(host)).toBeNull();
			expect(result.diagnostics.some((d) => d.severity === "error" && d.path === "host")).toBe(true);
		}
	});

	it("writes host back after enabled on every rewrite, and the rest still validates", () => {
		const parsed = parseWorkflowDefinition(runtimeRecord({ host: "laptop" }), "");
		const frontmatter = workflowToFrontmatter(parsed.workflow!, { uid: "abc" }, { nameKey: "title" });
		const record = parse(frontmatter) as Record<string, unknown>;
		expect(record.host).toBe("laptop");
		const keys = Object.keys(record);
		expect(keys.indexOf("host")).toBe(keys.indexOf("enabled") + 1);
		expect(record.uid).toBe("abc");

		const upstream = Object.fromEntries(
			Object.entries(record).filter(([key]) => !["host", "title", "uid"].includes(key))
		);
		expect(validateRuntimeRecord({ ...upstream, name: record.title })).toMatchObject({ valid: true });

		const reparsed = parseWorkflowDefinition(record, frontmatter, {
			nameKey: "title",
			allowedFrontmatterKeys: ["uid"],
		});
		expect(reparsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
		expect(reparsed.workflow?.host).toBe("laptop");
	});

	it("writes no host key for a workflow without one", () => {
		const parsed = parseWorkflowDefinition(runtimeRecord(), "");
		expect(parse(workflowToFrontmatter(parsed.workflow!))).not.toHaveProperty("host");
	});

	it("can be neither allowlisted nor used as the name key", () => {
		expect(normalizeAllowedFrontmatterKeys(["host", "uid"])).toEqual(["uid"]);
		expect(normalizeNameKey("host")).toBe("name");
	});

	it("is still read as host when an allowlist names it", () => {
		const result = parseWorkflowDefinition(runtimeRecord({ host: "laptop" }), "", {
			allowedFrontmatterKeys: ["host"],
		});
		expect(result.workflow?.host).toBe("laptop");
	});
});

describe("normalizeHostName", () => {
	it("trims and lower-cases, and maps non-strings to empty", () => {
		expect(normalizeHostName(" MacBook ")).toBe("macbook");
		expect(normalizeHostName(undefined)).toBe("");
		expect(normalizeHostName(3)).toBe("");
	});
});
