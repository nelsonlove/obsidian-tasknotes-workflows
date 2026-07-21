/**
 * Plugin-wide policy for code-executing steps (js.run, and later shell.run).
 *
 * These steps run arbitrary code, so they are gated behind an explicit opt-in
 * setting. main.ts pushes the current policy here whenever settings load or
 * change; the step run functions read it via getCodeStepPolicy(). Kept as a
 * module-level value so steps (defined without a plugin reference) can reach it
 * without threading settings through the whole engine.
 */
export interface CodeStepPolicy {
	/** Master switch. When false, code steps refuse to run. */
	enabled: boolean;
}

let policy: CodeStepPolicy = { enabled: false };

export function setCodeStepPolicy(next: CodeStepPolicy): void {
	policy = { ...next };
}

export function getCodeStepPolicy(): CodeStepPolicy {
	return policy;
}
