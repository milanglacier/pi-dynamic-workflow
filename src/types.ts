/** Shared types for the dynamic workflow extension. */

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function addUsage(total: UsageStats, delta: UsageStats): void {
	total.input += delta.input;
	total.output += delta.output;
	total.cacheRead += delta.cacheRead;
	total.cacheWrite += delta.cacheWrite;
	total.cost += delta.cost;
	total.turns += delta.turns;
}

export type AgentStatus = "queued" | "running" | "done" | "error" | "aborted";

/** One subagent invocation tracked in the run state. */
export interface AgentRecord {
	label: string;
	phase?: string;
	status: AgentStatus;
	/** Preview of the prompt (for rendering). */
	promptPreview: string;
	/** Final output text (or error message). */
	output: string;
	/** Parsed structured output when a schema was supplied. */
	structured?: unknown;
	usage: UsageStats;
	model?: string;
	error?: string;
}

/** Full run state stored in the tool result `details`. */
export interface WorkflowDetails {
	name: string;
	description: string;
	phases?: string[];
	agents: AgentRecord[];
	logs: string[];
	startedAt: number;
	finishedAt?: number;
	returnValue?: unknown;
	aborted?: boolean;
	scriptError?: string;
}

/** Options accepted by the sandboxed `agent()` hook. */
export interface AgentOptions {
	label?: string;
	phase?: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	schema?: Record<string, unknown>;
}

/** Hooks injected into the workflow script sandbox. */
export interface ScriptHooks {
	agent(prompt: string, options?: AgentOptions): Promise<unknown>;
	parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;
	pipeline(
		items: unknown[],
		...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown> | unknown>
	): Promise<unknown[]>;
	phase(title: string): void;
	log(message: string): void;
	args: unknown;
}
