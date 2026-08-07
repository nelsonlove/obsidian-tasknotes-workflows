import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { parseMarkdownFrontmatter } from "../src/frontmatter";
import { DEFAULT_SETTINGS } from "../src/settings";
import { WorkflowRepository } from "../src/workflowRepository";

const RUNTIME_WITH_VAULT_KEYS = `---
uid: 20260806-abc
created: 2026-08-06T00:00:00Z
type: runtime_workflow
id: auto-start
version: 1.0.0
name: Auto start
enabled: true
triggers:
  - id: manual-run
    event:
      id: tasknotes-workflows.manual
      version: 1.0.0
    x-tasknotes:
      type: manual
steps:
  - id: notify
    action:
      id: notice.show
      version: 1.0.0
    input:
      message: hi
run:
  concurrency:
    group: workflow
    policy: skip
  limits:
    max_items: 1
  on_error: stop
x-tasknotes:
  format_version: 1
  source: tasknotes-workflows
---

# Auto start
`;

class MemoryVault {
	readonly files = new Map<string, { file: TFile; content: string }>();
	readonly folders = new Set<string>(["TaskNotes", "TaskNotes/Workflows"]);
	readonly adapter = {
		exists: async (path: string): Promise<boolean> => this.files.has(path) || this.folders.has(path),
	};

	add(path: string, content: string): void {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").slice(-1)[0] ?? path;
		file.basename = file.name.replace(/\.md$/u, "");
		this.files.set(path, { file, content });
	}

	getMarkdownFiles(): TFile[] {
		return [...this.files.values()].map(({ file }) => file);
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.files.get(path)?.file ?? null;
	}

	async read(file: TFile): Promise<string> {
		return this.files.get(file.path)?.content ?? "";
	}

	async modify(file: TFile, content: string): Promise<void> {
		const current = this.files.get(file.path);
		if (!current) throw new Error(`Missing file: ${file.path}`);
		current.content = content;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
}

function setup(allowedFrontmatterKeys: string[]): { vault: MemoryVault; repository: WorkflowRepository } {
	const vault = new MemoryVault();
	vault.add("TaskNotes/Workflows/auto-start.md", RUNTIME_WITH_VAULT_KEYS);
	const settings = { ...DEFAULT_SETTINGS, allowedFrontmatterKeys };
	const repository = new WorkflowRepository({ vault } as never, () => settings);
	return { vault, repository };
}

describe("workflow repository frontmatter allowlist", () => {
	it("loads a workflow with allowlisted vault keys without diagnostics", async () => {
		const { repository } = setup(["uid", "created"]);
		const [loaded] = await repository.reload();
		expect(loaded?.diagnostics).toEqual([]);
		expect(loaded?.workflow?.id).toBe("auto-start");
	});

	it("flags the same keys when they are not allowlisted", async () => {
		const { repository } = setup([]);
		const [loaded] = await repository.reload();
		expect(loaded?.workflow).toBeNull();
		expect(loaded?.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
	});

	it("preserves allowlisted keys when saving a workflow", async () => {
		const { vault, repository } = setup(["uid", "created"]);
		const [loaded] = await repository.reload();
		expect(loaded?.workflow).not.toBeNull();

		await repository.saveWorkflow(loaded.file, { ...loaded.workflow!, name: "Auto start renamed" });

		const saved = vault.files.get("TaskNotes/Workflows/auto-start.md")?.content ?? "";
		const parsed = parseMarkdownFrontmatter(saved);
		const data = parsed.data as Record<string, unknown>;
		expect(data.uid).toBe("20260806-abc");
		expect(String(data.created)).toContain("2026-08-06");
		expect(data.name).toBe("Auto start renamed");
		expect(saved).toContain("# Auto start");
	});

	it("requires every extra key to be allowlisted, not just some", async () => {
		const { repository } = setup(["uid"]);
		const [loaded] = await repository.reload();
		// created is not allowlisted, so the note still fails runtime validation.
		expect(loaded?.workflow).toBeNull();
	});
});
