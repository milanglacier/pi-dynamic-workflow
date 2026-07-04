/**
 * Integration tests for the `workflow` tool's execute() against the fake pi
 * stub. Never spawns the real pi binary.
 */

import assert from "node:assert";
import * as os from "node:os";
import { after, afterEach, before, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowScriptError } from "../src/sandbox.ts";
import { workflowTool } from "../src/tool.ts";
import type { WorkflowDetails } from "../src/types.ts";
import { installFakePi } from "./fake-pi.ts";

let fakePi: ReturnType<typeof installFakePi>;
const ctx = { cwd: os.tmpdir(), hasUI: false } as unknown as ExtensionContext;

before(() => {
	fakePi = installFakePi();
});

after(() => {
	fakePi.cleanup();
});

afterEach(() => {
	delete process.env.FAKE_PI_MODE;
});

function firstText(content: Array<{ type: string; text?: string }>): string {
	const part = content[0];
	return part?.type === "text" ? (part.text ?? "") : "";
}

test("script return value becomes the tool result; agent record tracked", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const updates: WorkflowDetails[] = [];
	const result = await workflowTool.execute(
		"tc1",
		{
			name: "smoke",
			description: "test workflow",
			script: `phase("only"); const out = await agent("hi", { label: "greeter" }); return out;`,
		},
		undefined,
		(partial) => {
			if (partial.details) updates.push(partial.details);
		},
		ctx,
	);

	const text = firstText(result.content);
	assert.match(text, /FAKE_PI_OK/);
	assert.match(text, /1\/1 agents succeeded/);

	const details = result.details;
	assert.strictEqual(details.agents.length, 1);
	assert.strictEqual(details.agents[0]?.label, "greeter");
	assert.strictEqual(details.agents[0]?.phase, "only");
	assert.strictEqual(details.agents[0]?.status, "done");
	assert.strictEqual(details.agents[0]?.output, "FAKE_PI_OK");
	assert.strictEqual(details.returnValue, "FAKE_PI_OK");
	assert.ok(details.finishedAt);
	assert.ok(updates.length > 0, "onUpdate streamed progress");
});

test("object return value is JSON-serialized", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await workflowTool.execute(
		"tc2",
		{
			name: "obj",
			description: "d",
			script: `return { n: (args.xs ?? []).length };`,
			args: { xs: [1, 2, 3] },
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(result.content), /"n": 3/);
});

test("failed agent resolves to null; workflow continues", async () => {
	process.env.FAKE_PI_MODE = "fail";
	const result = await workflowTool.execute(
		"tc3",
		{
			name: "null-check",
			description: "d",
			script: `const r = await agent("x"); return r === null ? "was-null" : "not-null";`,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(result.content), /was-null/);
	assert.strictEqual(result.details.agents[0]?.status, "error");
	assert.match(result.details.agents[0]?.error ?? "", /boom/);
});

test("script error is thrown (pi marks isError)", async () => {
	await assert.rejects(
		workflowTool.execute(
			"tc4",
			{ name: "bad", description: "d", script: `throw new Error("kaput")` },
			undefined,
			undefined,
			ctx,
		),
		(err: unknown) => err instanceof WorkflowScriptError && /kaput/.test((err as Error).message),
	);
});

test("mid-run abort kills the in-flight agent and returns a partial result", async () => {
	process.env.FAKE_PI_MODE = "sleep";
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const start = Date.now();
	const result = await workflowTool.execute(
		"tc6",
		{ name: "mid-abort", description: "d", script: `await agent("x"); return "unreachable";` },
		controller.signal,
		undefined,
		ctx,
	);
	assert.ok(Date.now() - start < 5000, "should not wait out the 30s sleep");
	assert.strictEqual(result.details.aborted, true);
	assert.strictEqual(result.details.agents[0]?.status, "aborted");
	assert.match(firstText(result.content), /aborted/i);
});

test("maxConcurrency: 1 serializes parallel agents", async () => {
	process.env.FAKE_PI_MODE = "slow";
	let peakRunning = 0;
	const result = await workflowTool.execute(
		"tc7",
		{
			name: "serial",
			description: "d",
			script: `return await parallel([() => agent("a"), () => agent("b")]);`,
			maxConcurrency: 1,
		},
		undefined,
		(partial) => {
			const running = partial.details?.agents.filter((a) => a.status === "running").length ?? 0;
			peakRunning = Math.max(peakRunning, running);
		},
		ctx,
	);
	assert.strictEqual(peakRunning, 1, "never more than one agent running");
	assert.strictEqual(result.details.agents.filter((a) => a.status === "done").length, 2);
});

test("un-awaited agent() does not surface an unhandled rejection", async () => {
	process.env.FAKE_PI_MODE = "sleep";
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		let returned = false;
		let updatesAfterReturn = 0;
		const result = await workflowTool.execute(
			"tc8",
			{
				name: "fire-and-forget",
				description: "d",
				// agent() is never awaited; the finally-abort makes its promise reject.
				script: `agent("x"); return "done";`,
			},
			undefined,
			() => {
				if (returned) updatesAfterReturn++;
			},
			ctx,
		);
		returned = true;
		assert.match(firstText(result.content), /done/);
		// The in-flight agent must not be frozen as "running" in the final snapshot.
		assert.strictEqual(result.details.agents[0]?.status, "aborted");
		// Give the SIGTERM'd subprocess time to close and the dangling promise to settle.
		await new Promise((r) => setTimeout(r, 300));
		assert.deepStrictEqual(rejections, []);
		// The dangling continuation must not call onUpdate for a completed tool call.
		assert.strictEqual(updatesAfterReturn, 0);
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("pre-aborted signal returns an aborted partial result without throwing", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const controller = new AbortController();
	controller.abort();
	const result = await workflowTool.execute(
		"tc5",
		{ name: "aborted", description: "d", script: `await agent("x"); return "unreachable";` },
		controller.signal,
		undefined,
		ctx,
	);
	assert.strictEqual(result.details.aborted, true);
	assert.match(firstText(result.content), /aborted/i);
});
