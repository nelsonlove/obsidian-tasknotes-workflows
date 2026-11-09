/**
 * A step that ran to completion but whose result means it failed (for example
 * a shell command that exited non-zero). Throwing it sends the step down the
 * engine's normal failure path — the step is recorded as `failed` and, with
 * `run.onError: stop`, the run fails — while keeping the step's own result:
 * `code` becomes the step's `errorCode`, `details` its `errorDetails`, and
 * `output` its recorded `output`.
 */
export class StepFailure extends Error {
	readonly code: string;
	readonly details?: unknown;
	readonly output?: unknown;

	constructor(message: string, options: { code: string; details?: unknown; output?: unknown }) {
		super(message);
		this.name = "StepFailure";
		this.code = options.code;
		this.details = options.details;
		this.output = options.output;
	}
}

export function isStepFailure(error: unknown): error is StepFailure {
	return error instanceof StepFailure;
}
