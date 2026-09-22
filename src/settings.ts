import { DEFAULT_WORKFLOW_FOLDER, DEFAULT_WORKFLOW_VIEW_PATH } from "./constants";
import { isReservedFrontmatterKey } from "./workflowParser";
import type { TaskNotesWorkflowsSettings } from "./types";

export const DEFAULT_SETTINGS: TaskNotesWorkflowsSettings = {
	workflowFolder: DEFAULT_WORKFLOW_FOLDER,
	workflowViewPath: DEFAULT_WORKFLOW_VIEW_PATH,
	autoCreateDefaultWorkflows: true,
	autoCreateWorkflowView: true,
	enableScheduledTriggers: true,
	enableTaskEventTriggers: true,
	enableObsidianTriggers: false,
	runLogRoot: "",
	runLogLevel: "inputs-and-outputs",
	maxRunsPerWorkflow: 100,
	maxHistoryEntries: 1000,
	minIntervalMs: 60_000,
	uiLanguage: "system",
	enableCodeSteps: false,
	allowedFrontmatterKeys: [],
	pauseNotePath: "",
};

export function normalizeSettings(input: Partial<TaskNotesWorkflowsSettings>): TaskNotesWorkflowsSettings {
	return {
		...DEFAULT_SETTINGS,
		...input,
		workflowFolder: input.workflowFolder?.trim() || DEFAULT_SETTINGS.workflowFolder,
		workflowViewPath: input.workflowViewPath?.trim() || DEFAULT_SETTINGS.workflowViewPath,
		runLogRoot: input.runLogRoot?.trim() || DEFAULT_SETTINGS.runLogRoot,
		maxRunsPerWorkflow: Math.max(10, input.maxRunsPerWorkflow ?? DEFAULT_SETTINGS.maxRunsPerWorkflow),
		maxHistoryEntries: Math.max(50, input.maxHistoryEntries ?? DEFAULT_SETTINGS.maxHistoryEntries),
		minIntervalMs: Math.max(30_000, input.minIntervalMs ?? DEFAULT_SETTINGS.minIntervalMs),
		uiLanguage: input.uiLanguage?.trim() || DEFAULT_SETTINGS.uiLanguage,
		allowedFrontmatterKeys: normalizeAllowedFrontmatterKeys(input.allowedFrontmatterKeys),
		// An empty path is meaningful here (the pause check is off), so this
		// trims without falling back to the default.
		pauseNotePath: typeof input.pauseNotePath === "string" ? input.pauseNotePath.trim() : DEFAULT_SETTINGS.pauseNotePath,
	};
}

export function normalizeAllowedFrontmatterKeys(input: unknown): string[] {
	if (!Array.isArray(input)) return [...DEFAULT_SETTINGS.allowedFrontmatterKeys];
	const keys: string[] = [];
	for (const value of input) {
		if (typeof value !== "string") continue;
		const key = value.trim();
		if (key.length === 0 || keys.includes(key)) continue;
		// Workflow-owned schema keys can never be allowlisted; stripping one
		// before validation would invalidate every workflow in the vault.
		if (isReservedFrontmatterKey(key)) continue;
		keys.push(key);
	}
	return keys;
}
