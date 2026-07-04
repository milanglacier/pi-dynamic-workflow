/** The `workflow` custom tool: executes an LLM-authored orchestration script. */

import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WORKFLOW_TOOL_DESCRIPTION } from "./guide.ts";
import { renderWorkflowCall, renderWorkflowResult } from "./render.ts";
import { runWorkflowScript, WorkflowAbortError } from "./sandbox.ts";
import { defaultConcurrency, parallel, pipeline, Semaphore } from "./scheduler.ts";
import { runSubagent } from "./subagent.ts";
import type { AgentOptions, AgentRecord, ScriptHooks, WorkflowDetails } from "./types.ts";
import { emptyUsage } from "./types.ts";

const WorkflowParams = Type.Object({
	name: Type.String({ description: "Short kebab-case workflow name" }),
	description: Type.String({ description: "One-sentence description of what the workflow does" }),
	phases: Type.Optional(Type.Array(Type.String(), { description: "Ordered phase titles documenting the plan" })),
	script: Type.String({
		description:
			"Plain async JavaScript body executed in the workflow sandbox (top-level await/return allowed). " +
			"In scope: agent(), parallel(), pipeline(), phase(), log(), args.",
	}),
	args: Type.Optional(Type.Any({ description: "JSON value exposed to the script as `args`" })),
	maxConcurrency: Type.Optional(
		Type.Number({ description: "Cap on concurrent subagents (default max(2, min(8, cpus-2)))" }),
	),
});

export const workflowTool = defineTool<typeof WorkflowParams, WorkflowDetails>({
	name: "workflow",
	label: "Workflow",
	description: WORKFLOW_TOOL_DESCRIPTION,
	parameters: WorkflowParams,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const details: WorkflowDetails = {
			name: params.name,
			description: params.description,
			...(params.phases ? { phases: params.phases } : {}),
			agents: [],
			logs: [],
			startedAt: Date.now(),
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
			const done = details.agents.filter((a) => a.status === "done").length;
			const running = details.agents.filter((a) => a.status === "running").length;
			const queued = details.agents.filter((a) => a.status === "queued").length;
			let line = `Workflow "${details.name}": ${done}/${details.agents.length} agents done, ${running} running`;
			if (queued > 0) line += `, ${queued} queued`;
			return line;
		};

		// Internal controller so a script error or parent abort kills in-flight subprocesses.
		const controller = new AbortController();
		const onParentAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", onParentAbort, { once: true });
		}

		const semaphore = new Semaphore(params.maxConcurrency ?? defaultConcurrency());
		let currentPhase: string | undefined;
		let agentCounter = 0;

		const runAgent = async (prompt: string, options?: AgentOptions): Promise<unknown> => {
			if (typeof prompt !== "string" || !prompt.trim()) {
				throw new Error("agent() requires a non-empty prompt string");
			}
			if (controller.signal.aborted) throw new WorkflowAbortError();

			agentCounter++;
			const opts = options ?? {};
			const phase = opts.phase ?? currentPhase;
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
				return runSubagent({
					prompt,
					...(opts.model ? { model: opts.model } : {}),
					...(opts.tools ? { tools: opts.tools } : {}),
					cwd: opts.cwd ? path.resolve(ctx.cwd, opts.cwd) : ctx.cwd,
					...(opts.schema ? { schema: opts.schema } : {}),
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
		};

		const markUnfinishedAgentsAborted = () => {
			for (const a of details.agents) {
				if (a.status === "running" || a.status === "queued") a.status = "aborted";
			}
		};

		try {
			const returnValue = await runWorkflowScript(params.script, hooks);
			details.returnValue = returnValue;
			details.finishedAt = Date.now();

			if (signal?.aborted || controller.signal.aborted) {
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

			const succeeded = details.agents.filter((a) => a.status === "done").length;
			const header = `Workflow "${details.name}" finished: ${succeeded}/${details.agents.length} agents succeeded.`;
			return {
				content: [{ type: "text", text: `${header}\n\n${text}` }],
				details: snapshot(),
			};
		} catch (error) {
			controller.abort();
			details.finishedAt = Date.now();
			markUnfinishedAgentsAborted();

			if (error instanceof WorkflowAbortError || signal?.aborted) {
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
			signal?.removeEventListener("abort", onParentAbort);
			// Kill any stragglers from un-awaited agent() calls.
			controller.abort();
		}
	},

	renderCall(args, theme) {
		return renderWorkflowCall(args, theme);
	},

	renderResult(result, options, theme) {
		return renderWorkflowResult(result, options, theme);
	},
});
