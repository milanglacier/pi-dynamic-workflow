import assert from "node:assert";
import { test } from "node:test";
import { runWorkflowScript, WorkflowAbortError, WorkflowScriptError } from "../src/sandbox.ts";
import { parallel, pipeline } from "../src/scheduler.ts";
import type { ScriptHooks } from "../src/types.ts";

function makeHooks(overrides: Partial<ScriptHooks> = {}): ScriptHooks {
	return {
		agent: async (prompt) => `echo:${prompt}`,
		parallel,
		pipeline,
		phase: () => {},
		log: () => {},
		args: undefined,
		...overrides,
	};
}

test("hooks in scope, top-level await and return, console routed to log", async () => {
	const logs: string[] = [];
	let phaseTitle = "";
	const value = await runWorkflowScript(
		`
phase("work");
log("starting");
console.log("via console", 1);
const results = await parallel(args.items.map(i => () => agent(i)));
return { results, count: results.filter(Boolean).length };
`,
		makeHooks({
			phase: (t) => {
				phaseTitle = t;
			},
			log: (m) => logs.push(m),
			args: { items: ["x", "y"] },
		}),
	);
	// Compare via JSON: vm-created objects have cross-realm prototypes.
	assert.strictEqual(JSON.stringify(value), JSON.stringify({ results: ["echo:x", "echo:y"], count: 2 }));
	assert.strictEqual(phaseTitle, "work");
	assert.deepStrictEqual(logs, ["starting", "via console 1"]);
});

test("pipeline is callable from the sandbox", async () => {
	const value = await runWorkflowScript(
		`return await pipeline([1, 2], (_, n) => agent("n" + n), (prev) => prev + "!");`,
		makeHooks(),
	);
	assert.deepStrictEqual(value, ["echo:n1!", "echo:n2!"]);
});

test("syntax error surfaces as WorkflowScriptError", async () => {
	await assert.rejects(
		runWorkflowScript("const = broken", makeHooks()),
		(err: unknown) => err instanceof WorkflowScriptError && /syntax/.test((err as Error).message),
	);
});

test("runtime error surfaces as WorkflowScriptError with message", async () => {
	await assert.rejects(
		runWorkflowScript("throw new Error('kaput')", makeHooks()),
		(err: unknown) => err instanceof WorkflowScriptError && /kaput/.test((err as Error).message),
	);
});

test("WorkflowAbortError from a hook passes through unwrapped", async () => {
	await assert.rejects(
		runWorkflowScript(
			`await agent("x");`,
			makeHooks({
				agent: async () => {
					throw new WorkflowAbortError();
				},
			}),
		),
		(err: unknown) => err instanceof WorkflowAbortError,
	);
});

// NOTE: this checks lexical hygiene only. node:vm is NOT a security boundary —
// injected host functions expose host-realm constructors (see the comment in
// sandbox.ts). We only assert the sandbox doesn't casually hand out host globals.
test("sandbox does not lexically expose require or process", async () => {
	const value = await runWorkflowScript(
		`return { req: typeof require, proc: typeof process };`,
		makeHooks(),
	);
	assert.strictEqual(JSON.stringify(value), JSON.stringify({ req: "undefined", proc: "undefined" }));
});

test("top-level busy loop hits the sync-slice timeout", async () => {
	await assert.rejects(
		runWorkflowScript(`while (true) {}`, makeHooks(), { syncTimeoutMs: 100 }),
		(err: unknown) => err instanceof WorkflowScriptError && /timed out/i.test((err as Error).message),
	);
});
