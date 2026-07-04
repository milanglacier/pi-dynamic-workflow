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

/** Run a plain async JS body with the hooks in scope. Returns the script's return value. */
export async function runWorkflowScript(source: string, hooks: ScriptHooks): Promise<unknown> {
	const sandboxConsole = {
		log: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
		error: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
		warn: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
		info: (...parts: unknown[]) => hooks.log(parts.map(stringify).join(" ")),
	};

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
		return await script.runInContext(context);
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
