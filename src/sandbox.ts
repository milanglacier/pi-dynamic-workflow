/**
 * Evaluates the LLM-authored workflow script body in a `node:vm` context with
 * the orchestration hooks injected.
 */

import * as vm from "node:vm";
import type { ScriptHooks } from "./types.ts";

export class WorkflowScriptError extends Error {
	constructor(kind: "syntax" | "runtime", cause: unknown) {
		const err = cause instanceof Error ? cause : new Error(String(cause));
		const stackLine = err.stack?.split("\n").find((line) => line.includes("<workflow>")) ?? "";
		super(`Workflow script ${kind} error: ${err.message}${stackLine ? `\n${stackLine.trim()}` : ""}`);
		this.name = "WorkflowScriptError";
	}
}

/**
 * Cap on the script's *initial synchronous slice* (code up to the first await).
 * Catches the common LLM mistake of a top-level busy loop (`while (true) {}`)
 * before it can wedge pi's event loop. Continuations after an await run as host
 * microtasks and are NOT covered — that residual hang requires worker threads
 * to fix and is accepted as a known limitation.
 */
const SYNC_SLICE_TIMEOUT_MS = 5000;

/** Run a plain async JS body with the hooks in scope. Returns the script's return value. */
export async function runWorkflowScript(
	source: string,
	hooks: ScriptHooks,
	options?: { syncTimeoutMs?: number },
): Promise<unknown> {
	const sandboxConsole = {
		log: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
		error: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
		warn: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
		info: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
	};

	// SECURITY NOTE: node:vm provides isolation hygiene, not a security boundary.
	// The injected hooks are host-realm functions, so a determined script can reach
	// host globals via e.g. `agent.constructor("return process")()`. This is
	// acceptable here because the script author is the session LLM, which already
	// has full tool access through pi itself. Do not treat this context as a
	// jail for untrusted third-party code.
	const context = vm.createContext({
		agent: hooks.agent,
		parallel: hooks.parallel,
		pipeline: hooks.pipeline,
		phase: hooks.phase,
		log: hooks.log,
		args: hooks.args,
		console: sandboxConsole,
		setTimeout,
		clearTimeout,
	});

	let script: vm.Script;
	try {
		script = new vm.Script(`(async () => {\n${source}\n})()`, { filename: "<workflow>" });
	} catch (error) {
		throw new WorkflowScriptError("syntax", error);
	}

	try {
		return await script.runInContext(context, { timeout: options?.syncTimeoutMs ?? SYNC_SLICE_TIMEOUT_MS });
	} catch (error) {
		if (error instanceof WorkflowAbortError) throw error;
		throw new WorkflowScriptError("runtime", error);
	}
}

/** Thrown by hooks when the parent tool call is aborted; passes through untouched. */
export class WorkflowAbortError extends Error {
	constructor() {
		super("Workflow aborted");
		this.name = "WorkflowAbortError";
	}
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
