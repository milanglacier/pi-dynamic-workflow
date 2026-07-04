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
