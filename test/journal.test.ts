/**
 * Journaling and resume tests against the fake pi stub. getAgentDir() is
 * redirected to a temp dir for the whole file.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentCallHash, buildResumeCache, journalPath, loadJournal, type RunJournal } from "../src/journal.ts";
import { createWorkflowTool } from "../src/tool.ts";
import { installFakePi } from "./fake-pi.ts";

const workflowTool = createWorkflowTool();

let fakePi: ReturnType<typeof installFakePi>;
let agentDir: string;
const ctx = { cwd: os.tmpdir(), hasUI: false } as unknown as ExtensionContext;

before(() => {
	fakePi = installFakePi();
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

test("agentCallHash: stable across key order, ignores label/phase, changes with prompt/model", () => {
	const a = agentCallHash("p", { model: "m", tools: ["read"] });
	const b = agentCallHash("p", { tools: ["read"], model: "m", label: "x", phase: "y" });
	assert.strictEqual(a, b, "label/phase and option order must not affect the hash");
	assert.notStrictEqual(a, agentCallHash("p2", { model: "m", tools: ["read"] }));
	assert.notStrictEqual(a, agentCallHash("p", { model: "m2", tools: ["read"] }));
});

test("agentCallHash changes when the resolved agentType definition changes", () => {
	const opts = { agentType: "reviewer" };
	const v1 = agentCallHash("p", opts, { systemPrompt: "Be strict.", tools: ["read"], model: "m" });
	const v1Again = agentCallHash("p", opts, { systemPrompt: "Be strict.", tools: ["read"], model: "m" });
	assert.strictEqual(v1, v1Again, "identical resolved definitions hash identically");
	assert.notStrictEqual(v1, agentCallHash("p", opts, { systemPrompt: "Be lenient.", tools: ["read"], model: "m" }));
	assert.notStrictEqual(v1, agentCallHash("p", opts, { systemPrompt: "Be strict.", tools: ["read", "bash"], model: "m" }));
	assert.notStrictEqual(v1, agentCallHash("p", opts, { systemPrompt: "Be strict.", tools: ["read"], model: "m2" }));
});

test("buildResumeCache groups duplicate hashes into queues", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const journal: RunJournal = {
		runId: "r",
		name: "n",
		description: "d",
		script: "s",
		createdAt: 0,
		entries: [
			{ hash: "h1", label: "a", outputText: "first", usage },
			{ hash: "h1", label: "b", outputText: "second", usage },
			{ hash: "h2", label: "c", outputText: "other", usage },
		],
	};
	const cache = buildResumeCache(journal);
	assert.strictEqual(cache.get("h1")?.length, 2);
	assert.strictEqual(cache.get("h1")?.[0]?.outputText, "first");
	assert.strictEqual(cache.get("h2")?.length, 1);
});

test("a run journals successful agents; failures are not journaled", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await workflowTool.execute(
		"j1",
		{
			name: "journaled",
			description: "d",
			script: `await agent("one"); await agent("two"); return "ok";`,
		},
		undefined,
		undefined,
		ctx,
	);
	const runId = result.details.runId;
	assert.ok(runId, "runId present in details");
	assert.match(firstText(result.content), new RegExp(`Run id: ${runId}`));

	const journal = loadJournal(runId as string);
	assert.ok(journal, "journal file written");
	assert.strictEqual(journal.entries.length, 2);
	assert.strictEqual(journal.script, `await agent("one"); await agent("two"); return "ok";`);

	process.env.FAKE_PI_MODE = "fail";
	const failed = await workflowTool.execute(
		"j2",
		{ name: "failing", description: "d", script: `await agent("boom"); return "ok";` },
		undefined,
		undefined,
		ctx,
	);
	const failedJournal = loadJournal(failed.details.runId as string);
	assert.ok(failedJournal);
	assert.strictEqual(failedJournal.entries.length, 0, "failed agent must not be journaled");
});

test("resume replays matching calls from cache without spawning; changed calls run live", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const first = await workflowTool.execute(
		"j3",
		{ name: "resume-src", description: "d", script: `return await agent("stable prompt");` },
		undefined,
		undefined,
		ctx,
	);
	const runId = first.details.runId as string;

	// Same call resumed: must be served from cache. FAKE_PI_MODE=fail proves no
	// subprocess ran — a live spawn would produce an error, not FAKE_PI_OK.
	process.env.FAKE_PI_MODE = "fail";
	const resumed = await workflowTool.execute(
		"j4",
		{
			name: "resume-hit",
			description: "d",
			script: `return await agent("stable prompt");`,
			resumeFromRunId: runId,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(resumed.content), /FAKE_PI_OK/);
	assert.match(firstText(resumed.content), /1 from cache/);
	assert.strictEqual(resumed.details.agents[0]?.status, "cached");
	assert.strictEqual(resumed.details.resumedFrom, runId);

	// The resumed run's own journal re-records the cached entry (resumable again).
	const resumedJournal = loadJournal(resumed.details.runId as string);
	assert.strictEqual(resumedJournal?.entries.length, 1);

	// A changed prompt misses the cache and runs live.
	process.env.FAKE_PI_MODE = "ok";
	const changed = await workflowTool.execute(
		"j5",
		{
			name: "resume-miss",
			description: "d",
			script: `return await agent("different prompt");`,
			resumeFromRunId: runId,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.strictEqual(changed.details.agents[0]?.status, "done");
});

test("resume with an unknown runId logs and runs everything live", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await workflowTool.execute(
		"j6",
		{
			name: "resume-missing",
			description: "d",
			script: `return await agent("x");`,
			resumeFromRunId: "no-such-run",
		},
		undefined,
		undefined,
		ctx,
	);
	assert.strictEqual(result.details.agents[0]?.status, "done");
	assert.ok(result.details.logs.some((l) => /no journal found/.test(l)));
});

test("resume after an agent-definition edit runs live instead of replaying stale results", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-agents-edit-"));
	const agentsDir = path.join(projDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const writeDef = (prompt: string) =>
		fs.writeFileSync(
			path.join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: reviews code\n---\n${prompt}\n`,
		);
	const projCtx = { cwd: projDir, hasUI: false } as unknown as ExtensionContext;
	const script = `return await agent("check", { agentType: "reviewer" });`;
	try {
		writeDef("Be strict.");
		const first = await workflowTool.execute(
			"j9",
			{ name: "typed-src", description: "d", script },
			undefined,
			undefined,
			projCtx,
		);
		const runId = first.details.runId as string;

		// Unchanged definition: served from cache.
		const unchanged = await workflowTool.execute(
			"j10",
			{ name: "typed-hit", description: "d", script, resumeFromRunId: runId },
			undefined,
			undefined,
			projCtx,
		);
		assert.strictEqual(unchanged.details.agents[0]?.status, "cached");

		// Edited definition: same prompt and options, but the resolved system
		// prompt changed — the cache must miss and the agent run live.
		writeDef("Be lenient.");
		const edited = await workflowTool.execute(
			"j11",
			{ name: "typed-miss", description: "d", script, resumeFromRunId: runId },
			undefined,
			undefined,
			projCtx,
		);
		assert.strictEqual(edited.details.agents[0]?.status, "done");
	} finally {
		fs.rmSync(projDir, { recursive: true, force: true });
	}
});

test("loadJournal tolerates a truncated final line (crash mid-append)", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await workflowTool.execute(
		"j12",
		{ name: "trunc", description: "d", script: `await agent("a"); await agent("b"); return "ok";` },
		undefined,
		undefined,
		ctx,
	);
	const runId = result.details.runId as string;
	fs.appendFileSync(journalPath(runId), '{"hash":"partia');
	const journal = loadJournal(runId);
	assert.ok(journal, "journal still loads");
	assert.strictEqual(journal.entries.length, 2, "only the truncated line is dropped");
	assert.strictEqual(journal.runId, runId);
});

test("background run resumes from a prior journal", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const first = await workflowTool.execute(
		"j13",
		{ name: "bg-src", description: "d", script: `return await agent("bg prompt");` },
		undefined,
		undefined,
		ctx,
	);
	const runId = first.details.runId as string;

	const messages: string[] = [];
	const bgTool = createWorkflowTool({
		sendMessage: ((msg: { content: unknown }) => {
			messages.push(String(msg.content));
		}) as never,
	});
	// A live spawn would fail under FAKE_PI_MODE=fail; the cache must serve it.
	process.env.FAKE_PI_MODE = "fail";
	await bgTool.execute(
		"j14",
		{
			name: "bg-resume",
			description: "d",
			script: `return await agent("bg prompt");`,
			background: true,
			resumeFromRunId: runId,
		},
		undefined,
		undefined,
		ctx,
	);
	const start = Date.now();
	while (messages.length === 0) {
		if (Date.now() - start > 5000) throw new Error("timed out waiting for workflow-complete");
		await new Promise((r) => setTimeout(r, 25));
	}
	assert.match(messages[0] as string, /1\/1 agents succeeded \(1 from cache\)/);
});

test("cached replays do not count against the budget", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const first = await workflowTool.execute(
		"j7",
		{ name: "budget-src", description: "d", script: `await agent("a"); await agent("b"); return "ok";` },
		undefined,
		undefined,
		ctx,
	);
	const runId = first.details.runId as string;

	// Budget far below two live agents' cost; both replays must still succeed.
	const resumed = await workflowTool.execute(
		"j8",
		{
			name: "budget-resume",
			description: "d",
			script: `await agent("a"); await agent("b"); return "replayed";`,
			resumeFromRunId: runId,
			maxCost: 0.0001,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.match(firstText(resumed.content), /replayed/);
	assert.strictEqual(resumed.details.agents.filter((a) => a.status === "cached").length, 2);
});
