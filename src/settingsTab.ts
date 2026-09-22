import {
	Notice,
	PluginSettingTab,
	Setting,
	type App,
	type SettingDefinitionItem,
	type TextAreaComponent,
	type TextComponent,
} from "obsidian";
import { DEFAULT_WORKFLOW_FOLDER, DEFAULT_WORKFLOW_VIEW_PATH } from "./constants";
import { parseMarkdownFrontmatter } from "./frontmatter";
import { normalizeAllowedFrontmatterKeys } from "./settings";
import { DEFAULT_NAME_KEY, isReservedFrontmatterKey, normalizeNameKey } from "./workflowParser";
import type TaskNotesWorkflowsPlugin from "../main";

export class WorkflowsSettingsTab extends PluginSettingTab {
	private allowedKeysWarningEl: HTMLElement | null = null;
	private nameKeyWarningEl: HTMLElement | null = null;

	constructor(app: App, private readonly workflowsPlugin: TaskNotesWorkflowsPlugin) {
		super(app, workflowsPlugin);
		this.workflowsPlugin.registerEvent(
			this.workflowsPlugin.i18n.on("locale-changed", () => {
				if (this.containerEl.isConnected) this.renderSettings();
			})
		);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: this.workflowsPlugin.t("common.appName"),
				aliases: [
					this.workflowsPlugin.t("settings.workflowFiles.heading"),
					"Frontmatter",
					this.workflowsPlugin.t("settings.triggers.heading"),
					"Fleet pause",
					this.workflowsPlugin.t("settings.runLogs.heading"),
					this.workflowsPlugin.t("settings.language.heading"),
				],
				render: (setting) => {
					setting.settingEl.empty();
					this.renderSettings(setting.settingEl);
				},
			},
		];
	}

	override display(): void {
		this.renderSettings();
	}

	private renderSettings(containerEl: HTMLElement = this.containerEl): void {
		containerEl.empty();
		containerEl.addClass("tnw-settings");

		new Setting(containerEl).setName(this.workflowsPlugin.t("settings.workflowFiles.heading")).setHeading();

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.workflowFiles.folder.name"))
			.setDesc(this.workflowsPlugin.t("settings.workflowFiles.folder.description"))
			.addText((text) => {
				text.setValue(this.workflowsPlugin.settings.workflowFolder);
				this.commitTextOnFinish(text, (value) => {
					this.updateWorkflowFolder(value);
				});
			});

			new Setting(containerEl)
				.setName(this.workflowsPlugin.t("settings.workflowFiles.base.name"))
				.setDesc(this.workflowsPlugin.t("settings.workflowFiles.base.description"))
			.addText((text) =>
				text.setValue(this.workflowsPlugin.settings.workflowViewPath).onChange((value) => {
					this.workflowsPlugin.settings.workflowViewPath = value.trim() || DEFAULT_WORKFLOW_VIEW_PATH;
					void this.workflowsPlugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.workflowFiles.createDefaults.name"))
			.setDesc(this.workflowsPlugin.t("settings.workflowFiles.createDefaults.description"))
			.addToggle((toggle) =>
				toggle.setValue(this.workflowsPlugin.settings.autoCreateDefaultWorkflows).onChange((value) => {
					this.workflowsPlugin.settings.autoCreateDefaultWorkflows = value;
					void this.workflowsPlugin.saveSettings();
				})
			);

			new Setting(containerEl)
				.setName(this.workflowsPlugin.t("settings.workflowFiles.createBase.name"))
				.setDesc(this.workflowsPlugin.t("settings.workflowFiles.createBase.description"))
			.addToggle((toggle) =>
				toggle.setValue(this.workflowsPlugin.settings.autoCreateWorkflowView).onChange((value) => {
					this.workflowsPlugin.settings.autoCreateWorkflowView = value;
					void this.workflowsPlugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.workflowFiles.allowedFrontmatterKeys.name"))
			.setDesc(this.workflowsPlugin.t("settings.workflowFiles.allowedFrontmatterKeys.description"))
			.addTextArea((text) => {
				text.setValue(this.workflowsPlugin.settings.allowedFrontmatterKeys.join("\n"));
				text.inputEl.rows = 4;
				this.commitTextAreaOnChange(text, (value) => {
					this.updateAllowedFrontmatterKeys(value);
				});
			});
		this.allowedKeysWarningEl = containerEl.createDiv({ cls: "tnw-settings-reserved-keys-warning" });
		this.allowedKeysWarningEl.toggle(false);

		new Setting(containerEl).setName("Frontmatter").setHeading();

		new Setting(containerEl)
			.setName("Name key")
			.setDesc(
				"The frontmatter key that carries the workflow's display name. Default \"name\"; a vault whose notes title themselves with another key sets it here. A note that already uses `name` keeps it."
			)
			.addText((text) => {
				text.setPlaceholder(DEFAULT_NAME_KEY);
				text.setValue(this.workflowsPlugin.settings.nameKey);
				this.commitTextOnFinish(text, (value) => {
					this.updateNameKey(value);
				});
			});
		this.nameKeyWarningEl = containerEl.createDiv({ cls: "tnw-settings-reserved-keys-warning" });
		this.nameKeyWarningEl.toggle(false);

		new Setting(containerEl)
			.setName("Allow code steps")
			.setDesc(
				"Let workflows run js.run / shell.run steps (arbitrary code). Off by default — only enable if you trust every workflow that can execute."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.workflowsPlugin.settings.enableCodeSteps).onChange((value) => {
					this.workflowsPlugin.settings.enableCodeSteps = value;
					void this.workflowsPlugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.workflowFiles.maintainDefaults.name"))
			.setDesc(this.workflowsPlugin.t("settings.workflowFiles.maintainDefaults.description"))
			.addButton((button) =>
				button
					.setButtonText(this.workflowsPlugin.t("common.maintain"))
					.setCta()
					.onClick(() => {
						void this.workflowsPlugin.ensureDefaultFiles().then((result) => {
							this.workflowsPlugin.showDefaultFilesNotice(result);
						});
					})
			);

		new Setting(containerEl).setName(this.workflowsPlugin.t("settings.triggers.heading")).setHeading();

			new Setting(containerEl)
				.setName(this.workflowsPlugin.t("settings.triggers.tasknotesEvents.name"))
				.setDesc(this.workflowsPlugin.t("settings.triggers.tasknotesEvents.description"))
			.addToggle((toggle) =>
				toggle.setValue(this.workflowsPlugin.settings.enableTaskEventTriggers).onChange((value) => {
					this.workflowsPlugin.settings.enableTaskEventTriggers = value;
					void this.workflowsPlugin.saveSettingsAndReload();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.triggers.scheduled.name"))
			.setDesc(this.workflowsPlugin.t("settings.triggers.scheduled.description"))
			.addToggle((toggle) =>
				toggle.setValue(this.workflowsPlugin.settings.enableScheduledTriggers).onChange((value) => {
					this.workflowsPlugin.settings.enableScheduledTriggers = value;
					void this.workflowsPlugin.saveSettingsAndReload();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.triggers.obsidian.name"))
			.setDesc(this.workflowsPlugin.t("settings.triggers.obsidian.description"))
			.addToggle((toggle) =>
				toggle.setValue(this.workflowsPlugin.settings.enableObsidianTriggers).onChange((value) => {
					this.workflowsPlugin.settings.enableObsidianTriggers = value;
					void this.workflowsPlugin.saveSettingsAndReload();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.triggers.minInterval.name"))
			.setDesc(this.workflowsPlugin.t("settings.triggers.minInterval.description"))
			.addText((text) =>
				text.setValue(String(this.workflowsPlugin.settings.minIntervalMs)).onChange((value) => {
					const next = Number(value);
					if (Number.isFinite(next)) {
						this.workflowsPlugin.settings.minIntervalMs = Math.max(30_000, next);
						void this.workflowsPlugin.saveSettingsAndReload();
					}
				})
			);

		new Setting(containerEl).setName("Fleet pause").setHeading();

		new Setting(containerEl)
			.setName("Pause note")
			.setDesc(
				"Vault path of the fleet pause note. While its `paused` property is true, no workflow runs and each attempt is logged as a skipped run. Leave empty to switch the check off."
			)
			.addText((text) => {
				text.setPlaceholder("00-09 System/.../Pause.md");
				text.setValue(this.workflowsPlugin.settings.pauseNotePath);
				this.commitTextOnFinish(text, (value) => {
					this.updatePauseNotePath(value);
				});
			});

		new Setting(containerEl).setName(this.workflowsPlugin.t("settings.runLogs.heading")).setHeading();

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.runLogs.folder.name"))
			.setDesc(this.workflowsPlugin.t("settings.runLogs.folder.description"))
			.addText((text) =>
				text.setValue(this.workflowsPlugin.settings.runLogRoot).onChange((value) => {
					this.workflowsPlugin.settings.runLogRoot = value.trim();
					void this.workflowsPlugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.runLogs.level.name"))
			.setDesc(this.workflowsPlugin.t("settings.runLogs.level.description"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("summary", this.workflowsPlugin.t("settings.runLogs.level.options.summary"))
					.addOption("inputs", this.workflowsPlugin.t("settings.runLogs.level.options.inputs"))
					.addOption("inputs-and-outputs", this.workflowsPlugin.t("settings.runLogs.level.options.inputsAndOutputs"))
					.setValue(this.workflowsPlugin.settings.runLogLevel)
					.onChange((value) => {
						this.workflowsPlugin.settings.runLogLevel = value as typeof this.workflowsPlugin.settings.runLogLevel;
						void this.workflowsPlugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.runLogs.retention.name"))
			.setDesc(this.workflowsPlugin.t("settings.runLogs.retention.description"))
			.addText((text) =>
				text.setValue(String(this.workflowsPlugin.settings.maxRunsPerWorkflow)).onChange((value) => {
					const next = Number(value);
					if (Number.isFinite(next)) {
						this.workflowsPlugin.settings.maxRunsPerWorkflow = Math.max(10, next);
						void this.workflowsPlugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.runLogs.clear.name"))
			.setDesc(this.workflowsPlugin.t("settings.runLogs.clear.description"))
			.addButton((button) =>
				button.setButtonText(this.workflowsPlugin.t("common.clear")).onClick(() => {
					void this.workflowsPlugin.clearRunHistory().then(() => new Notice(this.workflowsPlugin.t("notices.runHistoryCleared")));
				})
			);

		new Setting(containerEl).setName(this.workflowsPlugin.t("settings.language.heading")).setHeading();

		new Setting(containerEl)
			.setName(this.workflowsPlugin.t("settings.language.name"))
			.setDesc(this.workflowsPlugin.t("settings.language.dropdownDescription"))
			.addDropdown((dropdown) => {
				dropdown.addOption("system", this.workflowsPlugin.t("common.systemDefault"));
				for (const code of this.workflowsPlugin.i18n.getAvailableLocales()) {
					dropdown.addOption(code, this.workflowsPlugin.i18n.getNativeLanguageName(code));
				}
				dropdown.setValue(this.workflowsPlugin.settings.uiLanguage ?? "system").onChange((value) => {
					this.workflowsPlugin.settings.uiLanguage = value;
					this.workflowsPlugin.i18n.setLocale(value);
					void this.workflowsPlugin.saveSettings();
				});
			});
	}

	private updateAllowedFrontmatterKeys(value: string): void {
		const entered = value
			.split(/\r?\n/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		const ignored = [...new Set(entered.filter((entry) => isReservedFrontmatterKey(entry)))];
		this.renderAllowedKeysWarning(ignored);
		const next = normalizeAllowedFrontmatterKeys(entered);
		if (next.join("\n") === this.workflowsPlugin.settings.allowedFrontmatterKeys.join("\n")) return;
		this.workflowsPlugin.settings.allowedFrontmatterKeys = next;
		void this.workflowsPlugin.saveSettingsAndReload();
	}

	private updateNameKey(value: string): void {
		const previous = this.workflowsPlugin.settings.nameKey;
		// A workflow-owned key would be consumed as the name on read and
		// overwritten on the next write-back, destroying a schema field on
		// every workflow note. Refuse it the way the allowlist does, and keep
		// the current value. `normalizeNameKey` clamps such a value to `name`,
		// so the entered text is what is tested here — silently saving `name`
		// would look like the typed key was accepted.
		const entered = value.trim();
		if (entered.length > 0 && entered !== DEFAULT_NAME_KEY && isReservedFrontmatterKey(entered)) {
			this.renderNameKeyWarning(
				`"${entered}" is a workflow-owned property and cannot be the name key. Keeping "${previous}".`
			);
			return;
		}
		const next = normalizeNameKey(entered);
		if (next === previous) return;
		this.renderNameKeyWarning(this.nameKeyFlipWarning(previous, next));
		this.workflowsPlugin.settings.nameKey = next;
		void this.workflowsPlugin.saveSettingsAndReload();
	}

	/**
	 * Going back to `name` stops holding the old key back from the allowlist,
	 * so every note that titles itself with it becomes invalid at once. Say so,
	 * with the count; migrating the notes stays the operator's call.
	 */
	private nameKeyFlipWarning(previous: string, next: string): string {
		if (next !== DEFAULT_NAME_KEY || previous === DEFAULT_NAME_KEY) return "";
		if (this.workflowsPlugin.settings.allowedFrontmatterKeys.includes(previous)) return "";
		const affected = this.workflowsPlugin.workflows.filter((loaded) => {
			const parsed = parseMarkdownFrontmatter(loaded.source);
			if (parsed.error || parsed.data === null || typeof parsed.data !== "object") return false;
			const data = parsed.data as Record<string, unknown>;
			return previous in data && !(DEFAULT_NAME_KEY in data);
		}).length;
		if (affected === 0) return "";
		return `${affected} workflow ${affected === 1 ? "note" : "notes"} name themselves with "${previous}" and have no "${DEFAULT_NAME_KEY}". They will not load until "${previous}" is added to "Extra frontmatter properties" or renamed to "${DEFAULT_NAME_KEY}". Nothing was migrated for you.`;
	}

	private renderNameKeyWarning(message: string): void {
		const warningEl = this.nameKeyWarningEl;
		if (!warningEl) return;
		warningEl.setText(message);
		warningEl.toggle(message.length > 0);
	}

	private updatePauseNotePath(value: string): void {
		// Empty is a meaningful value here: it turns the pause check off.
		const next = value.trim();
		if (next === this.workflowsPlugin.settings.pauseNotePath) return;
		this.workflowsPlugin.settings.pauseNotePath = next;
		void this.workflowsPlugin.saveSettings();
	}

	private renderAllowedKeysWarning(ignored: string[]): void {
		const warningEl = this.allowedKeysWarningEl;
		if (!warningEl) return;
		warningEl.setText(
			ignored.length > 0
				? this.workflowsPlugin.t("settings.workflowFiles.allowedFrontmatterKeys.reservedIgnored", {
						keys: ignored.join(", "),
					})
				: ""
		);
		warningEl.toggle(ignored.length > 0);
	}

	private commitTextAreaOnChange(text: TextAreaComponent, onCommit: (value: string) => void): void {
		let timer: number | null = null;
		const commit = () => {
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
			onCommit(text.getValue());
		};
		text.onChange(() => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(commit, 500);
		});
		text.inputEl.addEventListener("blur", commit);
	}

	private updateWorkflowFolder(value: string): void {
		const next = value.trim() || DEFAULT_WORKFLOW_FOLDER;
		if (next === this.workflowsPlugin.settings.workflowFolder) return;
		this.workflowsPlugin.settings.workflowFolder = next;
		void this.workflowsPlugin.saveSettingsAndReload();
	}

	private commitTextOnFinish(text: TextComponent, onCommit: (value: string) => void): void {
		const commit = () => {
			onCommit(text.getValue());
		};
		text.inputEl.addEventListener("blur", commit);
		text.inputEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			commit();
			text.inputEl.blur();
		});
	}
}
