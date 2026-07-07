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

export type AgentStatus = "queued" | "running" | "done" | "error" | "aborted" | "cached";

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

/** Budget caps configured on the run (kept in details for rendering). */
export interface BudgetCaps {
	maxCost?: number;
	maxTokens?: number;
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
	budget?: BudgetCaps;
	/** Journal id of this run (pass as resumeFromRunId to resume/re-run it). */
	runId?: string;
	/** Run id this run resumed from, when resumeFromRunId was given. */
	resumedFrom?: string;
}

/** Options accepted by the sandboxed `agent()` hook. */
export interface AgentOptions {
	label?: string;
	phase?: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	schema?: Record<string, unknown>;
	/** Wall-clock cap in ms; on expiry the subprocess is killed and agent() resolves to null. */
	timeout?: number;
	/** Replace the subagent's system prompt entirely (pi --system-prompt). */
	systemPrompt?: string;
	/** Append text to the subagent's system prompt (pi --append-system-prompt). */
	appendSystemPrompt?: string;
	/**
	 * Named agent definition resolved from pi's agents convention
	 * (~/.pi/agent/agents/*.md and <project>/.pi/agents/*.md). Supplies the
	 * subagent's system prompt (appended) plus default tools/model; explicit
	 * `tools`/`model` options win.
	 */
	agentType?: string;
}

/**
 * Budget view exposed to scripts as `budget`. Enforcement is a soft cap:
 * agent() refuses to spawn once a cap is reached, but in-flight agents finish.
 */
export interface WorkflowBudget {
	maxCost: number | null;
	maxTokens: number | null;
	spentCost(): number;
	/** Tokens counted as input + output (cache reads/writes excluded). */
	spentTokens(): number;
	remainingCost(): number;
	remainingTokens(): number;
	exceeded(): boolean;
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
	budget: WorkflowBudget;
	/** Run a saved workflow (by name or .js path) inline as a sub-step; one nesting level only. */
	workflow(nameOrPath: string, args?: unknown): Promise<unknown>;
}
