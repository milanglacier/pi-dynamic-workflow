/**
 * Integration tests for the `workflow` tool's execute() against the fake pi
 * stub. Never spawns the real pi binary.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowScriptError } from "../src/sandbox.ts";
import { createWorkflowTool, stopWorkflowRun } from "../src/tool.ts";
import type { WorkflowDetails } from "../src/types.ts";
import { installFakePi } from "./fake-pi.ts";

const workflowTool = createWorkflowTool();

let fakePi: ReturnType<typeof installFakePi>;
let agentDir: string;
const ctx = { cwd: os.tmpdir(), hasUI: false } as unknown as ExtensionContext;

before(() => {
	fakePi = installFakePi();
	// Redirect getAgentDir() so run journals never touch the real ~/.pi/agent.
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-agent-dir-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
	fakePi.cleanup();
	delete process.env.PI_CODING_AGENT_DIR;
	fs.rmSync(agentDir, { recursive: true, force: true });
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

test("maxAgents cap: agent() past the cap throws into the script", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await workflowTool.execute(
		"tc9",
		{
			name: "capped",
			description: "d",
			script: `
await agent("one");
await agent("two");
try { await agent("three"); return "no-throw"; } catch (e) { return "capped:" + e.message; }
`,
			maxAgents: 2,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(result.content), /capped:.*agent cap reached \(2\)/);
	assert.strictEqual(result.details.agents.length, 2);
});

test("budget: maxCost stops further agent() calls once spent", async () => {
	process.env.FAKE_PI_MODE = "ok"; // each fake agent costs $0.001
	const result = await workflowTool.execute(
		"tc10",
		{
			name: "budgeted",
			description: "d",
			script: `
const first = await agent("one");
const spent = budget.spentCost();
try { await agent("two"); return "no-throw"; } catch (e) { return "blocked at $" + spent.toFixed(4); }
`,
			maxCost: 0.0005,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(result.content), /blocked at \$0\.0010/);
	assert.strictEqual(result.details.agents.length, 1);
	assert.ok(result.details.logs.some((l) => /budget exhausted/.test(l)));
	assert.deepStrictEqual(result.details.budget, { maxCost: 0.0005 });
});

test("budget: maxTokens stops further agent() calls with a named error", async () => {
	process.env.FAKE_PI_MODE = "ok"; // each fake agent uses 3 tokens (1 input + 2 output)
	const result = await workflowTool.execute(
		"tc16",
		{
			name: "token-budget",
			description: "d",
			script: `
await agent("one");
try { await agent("two"); return "no-throw"; } catch (e) { return "blocked:" + e.name + ":" + budget.spentTokens(); }
`,
			maxTokens: 3,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(result.content), /blocked:BudgetExceededError:3/);
	assert.strictEqual(result.details.agents.length, 1);
});

test("a run appends a workflow-run entry with its journal path", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const entries: Array<{ type: string; data: unknown }> = [];
	const tool = createWorkflowTool({
		appendEntry: ((customType: string, data: unknown) => {
			entries.push({ type: customType, data });
		}) as never,
	});
	const result = await tool.execute(
		"tc17",
		{ name: "logged", description: "d", script: `return "ok";` },
		undefined,
		undefined,
		ctx,
	);
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0]?.type, "workflow-run");
	const data = entries[0]?.data as { runId: string; path: string };
	assert.strictEqual(data.runId, result.details.runId);
	assert.ok(data.path.endsWith(`${data.runId}.jsonl`), "entry points at the journal file");
});

test("per-agent timeout resolves to null with an error record", async () => {
	process.env.FAKE_PI_MODE = "sleep";
	const start = Date.now();
	const result = await workflowTool.execute(
		"tc11",
		{
			name: "timeout",
			description: "d",
			script: `const r = await agent("x", { timeout: 200 }); return r === null ? "was-null" : "not-null";`,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.ok(Date.now() - start < 5000, "should not wait out the 30s sleep");
	assert.match(firstText(result.content), /was-null/);
	assert.strictEqual(result.details.agents[0]?.status, "error");
	assert.match(result.details.agents[0]?.error ?? "", /timed out after 200ms/);
});

test("agentType applies the definition's system prompt, tools, and model", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-agents-"));
	const agentsDir = path.join(projDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "reviewer.md"),
		`---\nname: reviewer\ndescription: reviews code\ntools: read, grep\nmodel: review-model\n---\nYou are a strict reviewer.\n`,
	);
	const argsFile = path.join(projDir, "args.json");
	process.env.FAKE_PI_ARGS_FILE = argsFile;
	process.env.FAKE_PI_COPY_APPEND_PROMPTS = "1";
	try {
		const result = await workflowTool.execute(
			"tc12",
			{
				name: "typed-agent",
				description: "d",
				script: `return await agent("check this", { agentType: "reviewer" });`,
			},
			undefined,
			undefined,
			{ cwd: projDir, hasUI: false } as typeof ctx,
		);
		assert.match(firstText(result.content), /FAKE_PI_OK/);
		const args: string[] = JSON.parse(fs.readFileSync(argsFile, "utf-8"));
		const modelIdx = args.indexOf("--model");
		assert.strictEqual(args[modelIdx + 1], "review-model");
		const toolsIdx = args.indexOf("--tools");
		assert.strictEqual(args[toolsIdx + 1], "read,grep");
		const prompts: string[] = JSON.parse(fs.readFileSync(`${argsFile}.prompts`, "utf-8"));
		assert.deepStrictEqual(prompts, ["You are a strict reviewer."]);
	} finally {
		delete process.env.FAKE_PI_ARGS_FILE;
		delete process.env.FAKE_PI_COPY_APPEND_PROMPTS;
		fs.rmSync(projDir, { recursive: true, force: true });
	}
});

test("unknown agentType throws a helpful error into the script", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-agents-none-"));
	try {
		const result = await workflowTool.execute(
			"tc13",
			{
				name: "bad-type",
				description: "d",
				script: `try { await agent("x", { agentType: "nope" }); return "no-throw"; } catch (e) { return e.message; }`,
			},
			undefined,
			undefined,
			{ cwd: projDir, hasUI: false } as typeof ctx,
		);
		assert.match(firstText(result.content), /Unknown agentType "nope"/);
	} finally {
		fs.rmSync(projDir, { recursive: true, force: true });
	}
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("background run returns immediately and sends a workflow-complete message", async () => {
	process.env.FAKE_PI_MODE = "slow";
	const messages: Array<{ msg: { customType?: string; content: unknown }; opts: unknown }> = [];
	const bgTool = createWorkflowTool({
		sendMessage: ((msg: { customType?: string; content: unknown }, opts: unknown) => {
			messages.push({ msg, opts });
		}) as never,
	});

	const start = Date.now();
	const result = await bgTool.execute(
		"bg1",
		{
			name: "bg-smoke",
			description: "d",
			script: `return await agent("hi");`,
			background: true,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.ok(Date.now() - start < 100, "returns before the 150ms slow agent finishes");
	assert.match(firstText(result.content), /started in the background/);
	assert.ok(result.details.runId);

	await waitFor(() => messages.length > 0);
	const complete = messages[0]?.msg;
	assert.strictEqual(complete?.customType, "workflow-complete");
	assert.match(String(complete?.content), /1\/1 agents succeeded/);
	assert.deepStrictEqual(messages[0]?.opts, { triggerTurn: true, deliverAs: "followUp" });
});

test("stopWorkflowRun aborts a background run", async () => {
	process.env.FAKE_PI_MODE = "sleep";
	const messages: Array<{ customType?: string; content: unknown }> = [];
	const bgTool = createWorkflowTool({
		sendMessage: ((msg: { customType?: string; content: unknown }) => {
			messages.push(msg);
		}) as never,
	});

	const result = await bgTool.execute(
		"bg2",
		{ name: "bg-stop", description: "d", script: `await agent("x"); return "unreachable";`, background: true },
		undefined,
		undefined,
		ctx,
	);
	const runId = result.details.runId as string;
	assert.strictEqual(stopWorkflowRun(runId), true, "run is registered and stoppable");

	await waitFor(() => messages.length > 0);
	assert.match(String(messages[0]?.content), /aborted/i);
	assert.strictEqual(stopWorkflowRun(runId), false, "run is deregistered after completion");
});

test("background run ignores the turn's abort signal", async () => {
	process.env.FAKE_PI_MODE = "slow";
	const messages: Array<{ content: unknown }> = [];
	const bgTool = createWorkflowTool({
		sendMessage: ((msg: { content: unknown }) => {
			messages.push(msg);
		}) as never,
	});

	const controller = new AbortController();
	await bgTool.execute(
		"bg3",
		{ name: "bg-detached", description: "d", script: `return await agent("hi");`, background: true },
		controller.signal,
		undefined,
		ctx,
	);
	controller.abort(); // the turn ends; the background run must keep going
	await waitFor(() => messages.length > 0);
	assert.match(String(messages[0]?.content), /1\/1 agents succeeded/);
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
