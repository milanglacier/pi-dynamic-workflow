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
		budget: {
			maxCost: null,
			maxTokens: null,
			spentCost: () => 0,
			spentTokens: () => 0,
			remainingCost: () => Infinity,
			remainingTokens: () => Infinity,
			exceeded: () => false,
		},
		workflow: async () => null,
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

test("determinism guards: Date.now, Math.random, and bare new Date throw", async () => {
	for (const expr of ["Date.now()", "Math.random()", "new Date()", "Date()"]) {
		await assert.rejects(
			runWorkflowScript(`return ${expr};`, makeHooks()),
			(err: unknown) => err instanceof WorkflowScriptError && /deterministic/.test((err as Error).message),
			`${expr} should be blocked`,
		);
	}
});

test("determinism guards: explicit Date args and other Math members still work", async () => {
	const value = await runWorkflowScript(
		`return { year: new Date(0).getUTCFullYear(), floor: Math.floor(1.9), parsed: Date.parse("1970-01-01T00:00:00Z") };`,
		makeHooks(),
	);
	assert.strictEqual(JSON.stringify(value), JSON.stringify({ year: 1970, floor: 1, parsed: 0 }));
});

test("budget global is visible to the script", async () => {
	const value = await runWorkflowScript(
		`return { max: budget.maxCost, left: budget.remainingCost(), over: budget.exceeded() };`,
		makeHooks({
			budget: {
				maxCost: 2,
				maxTokens: null,
				spentCost: () => 0.5,
				spentTokens: () => 0,
				remainingCost: () => 1.5,
				remainingTokens: () => Infinity,
				exceeded: () => false,
			},
		}),
	);
	assert.strictEqual(JSON.stringify(value), JSON.stringify({ max: 2, left: 1.5, over: false }));
});

test("top-level busy loop hits the sync-slice timeout", async () => {
	await assert.rejects(
		runWorkflowScript(`while (true) {}`, makeHooks(), { syncTimeoutMs: 100 }),
		(err: unknown) => err instanceof WorkflowScriptError && /timed out/i.test((err as Error).message),
	);
});
