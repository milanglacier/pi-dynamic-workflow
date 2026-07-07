/** The `workflow` custom tool: executes an LLM-authored orchestration script. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentTypeConfig, discoverAgentTypes } from "./agents.ts";
import { WORKFLOW_TOOL_DESCRIPTION } from "./guide.ts";
import { agentCallHash, buildResumeCache, type JournalEntry, JournalWriter, loadJournal, newRunId } from "./journal.ts";
import { loadWorkflowSource } from "./registry.ts";
import { renderWorkflowCall, renderWorkflowResult } from "./render.ts";
import { runWorkflowScript, WorkflowAbortError } from "./sandbox.ts";
import { defaultConcurrency, parallel, pipeline, Semaphore } from "./scheduler.ts";
import { runSubagent } from "./subagent.ts";
import type { AgentOptions, AgentRecord, ScriptHooks, WorkflowBudget, WorkflowDetails } from "./types.ts";
import { addUsage, emptyUsage } from "./types.ts";

/** Runaway backstop: max agent() calls per run, regardless of tool params. */
const MAX_AGENTS_PER_RUN = 200;

const WorkflowParams = Type.Object({
	name: Type.String({ description: "Short kebab-case workflow name" }),
	description: Type.String({ description: "One-sentence description of what the workflow does" }),
	phases: Type.Optional(Type.Array(Type.String(), { description: "Ordered phase titles documenting the plan" })),
	script: Type.Optional(
		Type.String({
			description:
				"Plain async JavaScript body executed in the workflow sandbox (top-level await/return allowed). " +
				"In scope: agent(), parallel(), pipeline(), phase(), log(), args, budget, workflow(). " +
				"Provide exactly one of script, workflowName, or scriptPath.",
		}),
	),
	workflowName: Type.Optional(
		Type.String({
			description: "Run a saved workflow by name (from ~/.pi/agent/workflows/ or <project>/.pi/workflows/)",
		}),
	),
	scriptPath: Type.Optional(
		Type.String({ description: "Run a workflow script from a .js file path (relative to the session cwd)" }),
	),
	args: Type.Optional(Type.Any({ description: "JSON value exposed to the script as `args`" })),
	maxConcurrency: Type.Optional(
		Type.Number({ description: "Cap on concurrent subagents (default max(2, min(8, cpus-2)))" }),
	),
	maxAgents: Type.Optional(
		Type.Number({ description: `Cap on total agent() calls this run (default and hard max ${MAX_AGENTS_PER_RUN})` }),
	),
	maxCost: Type.Optional(
		Type.Number({ description: "Budget cap in USD; agent() throws once total subagent cost reaches it" }),
	),
	maxTokens: Type.Optional(
		Type.Number({ description: "Budget cap in tokens (input+output); agent() throws once total reaches it" }),
	),
	resumeFromRunId: Type.Optional(
		Type.String({
			description:
				"Resume from a prior run's journal: agent() calls whose prompt+options match a recorded call " +
				"return the cached result instantly; new or changed calls run live",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately and run in the background; a workflow-complete message arrives when the run " +
				"finishes. The run dies with the pi process but is resumable via its journal (resumeFromRunId)",
		}),
	),
});

/** Message type injected into the session when a background run finishes. */
export const WORKFLOW_COMPLETE_TYPE = "workflow-complete";

/** Host capabilities the tool needs beyond the per-call ExtensionContext. */
export type WorkflowToolHost = Partial<Pick<ExtensionAPI, "sendMessage" | "appendEntry">>;

/** Thrown by agent() once the run's maxCost/maxTokens budget is spent. Scripts
 * can catch it by name (`e.name === "BudgetExceededError"`) to return partial results. */
export class BudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BudgetExceededError";
	}
}

// Background runs in flight, keyed by runId, so /workflow-stop and
// session_shutdown can abort them. Module-level (not per createWorkflowTool
// instance) so the /workflow-stop command reaches runs regardless of which
// tool instance started them; one extension instance per process in practice.
const activeBackgroundRuns = new Map<string, AbortController>();

/** Abort a background run. Returns false when no such run is active. */
export function stopWorkflowRun(runId: string): boolean {
	const controller = activeBackgroundRuns.get(runId);
	if (!controller) return false;
	// Deregister immediately so a stopping run is no longer listed as active.
	activeBackgroundRuns.delete(runId);
	controller.abort();
	return true;
}

export function listActiveWorkflowRuns(): string[] {
	return [...activeBackgroundRuns.keys()];
}

export const createWorkflowTool = (host: WorkflowToolHost = {}) =>
	defineTool<typeof WorkflowParams, WorkflowDetails>({
		name: "workflow",
		label: "Workflow",
		description: WORKFLOW_TOOL_DESCRIPTION,
		parameters: WorkflowParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const maxCost = params.maxCost ?? null;
		const maxTokens = params.maxTokens ?? null;
		const runId = newRunId(params.name);
		const details: WorkflowDetails = {
			name: params.name,
			description: params.description,
			...(params.phases ? { phases: params.phases } : {}),
			agents: [],
			logs: [],
			startedAt: Date.now(),
			runId,
			...(params.resumeFromRunId ? { resumedFrom: params.resumeFromRunId } : {}),
			...(maxCost !== null || maxTokens !== null
				? {
						budget: {
							...(maxCost !== null ? { maxCost } : {}),
							...(maxTokens !== null ? { maxTokens } : {}),
						},
					}
				: {}),
		};

		const snapshot = (): WorkflowDetails => ({
			...details,
			agents: details.agents.map((a) => ({ ...a })),
			logs: [...details.logs],
		});

		// Set once execute() delivers its result; dangling fire-and-forget agent()
		// continuations settle after that and must not call onUpdate for a
		// completed tool call.
		let finished = false;

		const emit = () => {
			if (finished) return;
			onUpdate?.({
				content: [{ type: "text", text: progressLine() }],
				details: snapshot(),
			});
		};

		const progressLine = () => {
			const done = details.agents.filter((a) => a.status === "done" || a.status === "cached").length;
			const running = details.agents.filter((a) => a.status === "running").length;
			const queued = details.agents.filter((a) => a.status === "queued").length;
			let line = `Workflow "${details.name}": ${done}/${details.agents.length} agents done, ${running} running`;
			if (queued > 0) line += `, ${queued} queued`;
			return line;
		};

		// Internal controller so a script error or parent abort kills in-flight subprocesses.
		const controller = new AbortController();
		const onParentAbort = () => controller.abort();
		// Background runs outlive the tool call on purpose: they ignore the
		// turn's abort signal and are stopped via stopWorkflowRun instead.
		const parentSignal = params.background ? undefined : signal;
		if (parentSignal) {
			if (parentSignal.aborted) controller.abort();
			else parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}

		const semaphore = new Semaphore(Math.max(1, params.maxConcurrency ?? defaultConcurrency()));
		let currentPhase: string | undefined;
		let agentCounter = 0;
		const maxAgents = Math.max(1, Math.min(params.maxAgents ?? MAX_AGENTS_PER_RUN, MAX_AGENTS_PER_RUN));

		// Budget counts only live spend this run; cached (replayed) results are free.
		const spentUsage = () => {
			const total = emptyUsage();
			for (const a of details.agents) {
				if (a.status !== "cached") addUsage(total, a.usage);
			}
			return total;
		};
		const budget: WorkflowBudget = {
			maxCost,
			maxTokens,
			spentCost: () => spentUsage().cost,
			spentTokens: () => {
				const u = spentUsage();
				return u.input + u.output;
			},
			remainingCost: () => (maxCost === null ? Infinity : Math.max(0, maxCost - budget.spentCost())),
			remainingTokens: () => (maxTokens === null ? Infinity : Math.max(0, maxTokens - budget.spentTokens())),
			exceeded: () =>
				(maxCost !== null && budget.spentCost() >= maxCost) ||
				(maxTokens !== null && budget.spentTokens() >= maxTokens),
		};
		let budgetLogged = false;

		// Journal this run for later resume; replay from a prior run's journal.
		let journal: JournalWriter | null = null;
		let resumeCache: Map<string, JournalEntry[]> | null = null;
		if (params.resumeFromRunId) {
			const prior = loadJournal(params.resumeFromRunId);
			if (prior) {
				resumeCache = buildResumeCache(prior);
			} else {
				details.logs.push(`resume: no journal found for run "${params.resumeFromRunId}"; running everything live`);
			}
		}

		// Agent-type definitions are discovered once per run, on first use.
		let agentTypes: Map<string, AgentTypeConfig> | null = null;
		const resolveAgentType = (name: string): AgentTypeConfig => {
			agentTypes ??= discoverAgentTypes(ctx.cwd);
			const def = agentTypes.get(name);
			if (!def) {
				const available = [...agentTypes.keys()].join(", ") || "(none found)";
				throw new Error(`Unknown agentType "${name}". Available agent types: ${available}`);
			}
			return def;
		};

		const runAgent = async (prompt: string, options?: AgentOptions): Promise<unknown> => {
			if (typeof prompt !== "string" || !prompt.trim()) {
				throw new Error("agent() requires a non-empty prompt string");
			}
			if (controller.signal.aborted) throw new WorkflowAbortError();
			if (agentCounter >= maxAgents) {
				throw new Error(`Workflow agent cap reached (${maxAgents}); refusing to spawn another agent`);
			}

			agentCounter++;
			const opts = options ?? {};
			const agentDef = opts.agentType ? resolveAgentType(opts.agentType) : undefined;
			const phase = opts.phase ?? currentPhase;
			const callHash = agentCallHash(prompt, opts, agentDef);

			// Resume: replay a recorded result for a matching call without spawning.
			const cachedEntry = resumeCache?.get(callHash)?.shift();
			if (cachedEntry) {
				const cachedRecord: AgentRecord = {
					label: opts.label ?? cachedEntry.label,
					...(phase !== undefined ? { phase } : {}),
					status: "cached",
					promptPreview: prompt.slice(0, 200),
					output: cachedEntry.outputText,
					...(cachedEntry.structured !== undefined ? { structured: cachedEntry.structured } : {}),
					usage: cachedEntry.usage,
					...(cachedEntry.model !== undefined ? { model: cachedEntry.model } : {}),
				};
				details.agents.push(cachedRecord);
				emit();
				// Re-record so the resumed run's own journal is complete and resumable.
				journal?.record({ ...cachedEntry, hash: callHash });
				return opts.schema ? cachedEntry.structured : cachedEntry.outputText;
			}

			// Budget gates live spawns only; cached replays above are free.
			if (budget.exceeded()) {
				const u = spentUsage();
				if (!budgetLogged) {
					budgetLogged = true;
					details.logs.push(`budget exhausted: $${u.cost.toFixed(4)} spent, ${u.input + u.output} tokens`);
					emit();
				}
				throw new BudgetExceededError(
					`Workflow budget exceeded (spent $${u.cost.toFixed(4)}, ${u.input + u.output} tokens); agent() refused`,
				);
			}

			const record: AgentRecord = {
				label: opts.label ?? `agent-${agentCounter}`,
				...(phase !== undefined ? { phase } : {}),
				status: "queued",
				promptPreview: prompt.slice(0, 200),
				output: "",
				usage: emptyUsage(),
			};
			details.agents.push(record);
			emit();

			const result = await semaphore.run(() => {
				if (controller.signal.aborted) {
					record.status = "aborted";
					throw new WorkflowAbortError();
				}
				// Only mark "running" once the semaphore slot is held, so queued
				// agents are not misreported as active subprocesses.
				record.status = "running";
				emit();
				// Explicit options win over the agent-type definition's defaults.
				const model = opts.model ?? agentDef?.model;
				const tools = opts.tools ?? agentDef?.tools;
				const appendPrompts: string[] = [];
				if (agentDef) appendPrompts.push(agentDef.systemPrompt);
				if (opts.appendSystemPrompt) appendPrompts.push(opts.appendSystemPrompt);
				return runSubagent({
					prompt,
					...(model ? { model } : {}),
					...(tools ? { tools } : {}),
					cwd: opts.cwd ? path.resolve(ctx.cwd, opts.cwd) : ctx.cwd,
					...(opts.schema ? { schema: opts.schema } : {}),
					...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
					...(appendPrompts.length > 0 ? { appendSystemPrompt: appendPrompts } : {}),
					...(opts.timeout ? { timeoutMs: opts.timeout } : {}),
					signal: controller.signal,
					onEvent: (update) => {
						record.usage = update.usage;
						emit();
					},
				});
			});

			record.usage = result.usage;
			if (result.model !== undefined) record.model = result.model;
			record.output = result.outputText;

			if (result.aborted) {
				record.status = "aborted";
				emit();
				throw new WorkflowAbortError();
			}
			if (!result.ok) {
				record.status = "error";
				record.error = result.errorMessage ?? "subagent failed";
				emit();
				return null;
			}

			record.status = "done";
			if (result.structured !== undefined) record.structured = result.structured;
			emit();
			journal?.record({
				hash: callHash,
				label: record.label,
				outputText: result.outputText,
				...(result.structured !== undefined ? { structured: result.structured } : {}),
				...(result.model !== undefined ? { model: result.model } : {}),
				usage: result.usage,
			});
			return opts.schema ? result.structured : result.outputText;
		};

		const agentHook: ScriptHooks["agent"] = (prompt, options?: AgentOptions) => {
			const promise = runAgent(prompt, options);
			// A fire-and-forget agent() call (script never awaits it) would otherwise
			// surface WorkflowAbortError as an unhandledRejection in the host pi
			// process when the finally-abort fires. The no-op catch marks the
			// rejection handled; awaited callers still receive it.
			promise.catch(() => {});
			return promise;
		};

		// Nested saved workflows share this run's agent hook, semaphore, abort
		// controller, and agent/budget accounting (all closures above). This is
		// orthogonal to the PI_WORKFLOW_DEPTH guard in subagent.ts: no extra pi
		// process is spawned for a nested workflow, only for its agent() calls.
		// The one-level limit is enforced per invocation chain (the child gets a
		// throwing workflow hook), not via a shared counter, so concurrent
		// sibling workflow() calls at the top level are allowed.
		const runNestedWorkflow = async (nameOrPath: string, nestedArgs?: unknown): Promise<unknown> => {
			if (typeof nameOrPath !== "string" || !nameOrPath.trim()) {
				throw new Error("workflow() requires a saved workflow name or a .js path");
			}
			const loaded = loadWorkflowSource(nameOrPath, ctx.cwd);
			const childName = path.basename(nameOrPath, ".js");
			const prevPhase = currentPhase;
			hooks.log(`── workflow ${nameOrPath}`);
			const childHooks: ScriptHooks = {
				...hooks,
				args: nestedArgs,
				// Attribute the child's output: its logs and phases carry its name.
				log: (message) => hooks.log(`[${childName}] ${message}`),
				phase: (title) => hooks.phase(`${childName}: ${title}`),
				workflow: async () => {
					throw new Error("workflow() nesting is limited to one level");
				},
			};
			try {
				return await runWorkflowScript(loaded.source, childHooks);
			} finally {
				// Best-effort restore; display-only, so last-finisher-wins among
				// concurrent siblings is acceptable.
				currentPhase = prevPhase;
			}
		};

		const hooks: ScriptHooks = {
			agent: agentHook,
			parallel,
			pipeline,
			phase(title: string) {
				currentPhase = String(title);
				details.logs.push(`── ${currentPhase}`);
				emit();
			},
			log(message: string) {
				details.logs.push(typeof message === "string" ? message : JSON.stringify(message));
				emit();
			},
			args: params.args,
			budget,
			workflow: runNestedWorkflow,
		};

		const markUnfinishedAgentsAborted = () => {
			for (const a of details.agents) {
				if (a.status === "running" || a.status === "queued") a.status = "aborted";
			}
		};

		const runToCompletion = async (): Promise<AgentToolResult<WorkflowDetails>> => {
			try {
			const sourceParams = [params.script, params.workflowName, params.scriptPath].filter(
				(p) => p !== undefined,
			).length;
			if (sourceParams !== 1) {
				throw new Error("Provide exactly one of `script`, `workflowName`, or `scriptPath`");
			}
			const scriptSource =
				params.script ??
				(params.scriptPath !== undefined
					? fs.readFileSync(path.resolve(ctx.cwd, params.scriptPath), "utf-8")
					: loadWorkflowSource(params.workflowName as string, ctx.cwd).source);

			journal = new JournalWriter({
				runId,
				name: params.name,
				description: params.description,
				script: scriptSource,
			});
			// Persist a pointer in the session JSONL (outside LLM context) so
			// resumable runs are discoverable even after a crash.
			host.appendEntry?.("workflow-run", { runId, path: journal.filePath });

			const returnValue = await runWorkflowScript(scriptSource, hooks);
			details.returnValue = returnValue;
			details.finishedAt = Date.now();

			if (parentSignal?.aborted || controller.signal.aborted) {
				details.aborted = true;
				markUnfinishedAgentsAborted();
				return {
					content: [{ type: "text", text: `Workflow "${details.name}" aborted. Partial progress: ${progressLine()}` }],
					details: snapshot(),
				};
			}

			// The finally-abort is about to kill any fire-and-forget agents still
			// in flight; mark them aborted now so the final snapshot doesn't
			// freeze them as "running".
			markUnfinishedAgentsAborted();

			const rendered =
				returnValue === undefined
					? "(no return value)"
					: typeof returnValue === "string"
						? returnValue
						: JSON.stringify(returnValue, null, 2);
			const truncation = truncateHead(rendered, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Result truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown]`;
			}

			const succeeded = details.agents.filter((a) => a.status === "done" || a.status === "cached").length;
			const cachedCount = details.agents.filter((a) => a.status === "cached").length;
			const header =
				`Workflow "${details.name}" finished: ${succeeded}/${details.agents.length} agents succeeded` +
				`${cachedCount > 0 ? ` (${cachedCount} from cache)` : ""}. Run id: ${runId} (resumable via resumeFromRunId).`;
			return {
				content: [{ type: "text", text: `${header}\n\n${text}` }],
				details: snapshot(),
			};
		} catch (error) {
			controller.abort();
			details.finishedAt = Date.now();
			markUnfinishedAgentsAborted();

			if (error instanceof WorkflowAbortError || parentSignal?.aborted) {
				details.aborted = true;
				return {
					content: [{ type: "text", text: `Workflow "${details.name}" aborted. Partial progress: ${progressLine()}` }],
					details: snapshot(),
				};
			}

			details.scriptError = error instanceof Error ? error.message : String(error);
			emit();
			throw error;
		} finally {
			finished = true;
			parentSignal?.removeEventListener("abort", onParentAbort);
			// Kill any stragglers from un-awaited agent() calls.
			controller.abort();
		}
		};

		if (params.background) {
			// The tool call completes now; suppress all later onUpdate emissions.
			finished = true;
			activeBackgroundRuns.set(runId, controller);
			const notify = (content: string) => {
				activeBackgroundRuns.delete(runId);
				host.sendMessage?.(
					{ customType: WORKFLOW_COMPLETE_TYPE, content, display: true, details: snapshot() },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			};
			void runToCompletion().then(
				(final) => {
					const first = final.content[0];
					notify(first?.type === "text" ? first.text : `Workflow "${params.name}" finished.`);
				},
				(error: unknown) => {
					notify(
						`Background workflow "${params.name}" failed: ` +
							`${error instanceof Error ? error.message : String(error)} (run id: ${runId})`,
					);
				},
			);
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow "${params.name}" started in the background (run id: ${runId}). ` +
							"A workflow-complete message will arrive when it finishes. " +
							`Stop it with /workflow-stop ${runId}. If pi exits first, resume via resumeFromRunId.`,
					},
				],
				details: snapshot(),
			};
		}

		return runToCompletion();
	},

	renderCall(args, theme) {
		return renderWorkflowCall(args, theme);
	},

	renderResult(result, options, theme) {
		return renderWorkflowResult(result, options, theme);
	},
});
