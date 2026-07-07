/**
 * Saved-workflow registry tests plus tool-level workflowName/scriptPath and
 * nested workflow() runs against the fake pi stub.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverWorkflows, loadWorkflowSource } from "../src/registry.ts";
import { createWorkflowTool } from "../src/tool.ts";
import { installFakePi } from "./fake-pi.ts";

const workflowTool = createWorkflowTool();

let fakePi: ReturnType<typeof installFakePi>;
let agentDir: string;

before(() => {
	fakePi = installFakePi();
	// Redirect getAgentDir() so run journals and user-scope discovery never
	// touch the real ~/.pi/agent.
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

/** Create a temp project with .pi/workflows/ prepopulated. */
function makeProject(workflows: Record<string, string>): { dir: string; cleanup(): void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-"));
	const wfDir = path.join(dir, ".pi", "workflows");
	fs.mkdirSync(wfDir, { recursive: true });
	for (const [name, source] of Object.entries(workflows)) {
		fs.writeFileSync(path.join(wfDir, `${name}.js`), source);
	}
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function ctxFor(dir: string): ExtensionContext {
	return { cwd: dir, hasUI: false } as unknown as ExtensionContext;
}

test("discoverWorkflows finds project workflows with descriptions, walking up from a subdir", () => {
	const proj = makeProject({
		"review-sweep": `// Multi-lens review sweep\nreturn 1;`,
		"no-desc": `return 2;`,
	});
	try {
		const sub = path.join(proj.dir, "src", "deep");
		fs.mkdirSync(sub, { recursive: true });
		const found = discoverWorkflows(sub);
		const review = found.get("review-sweep");
		assert.ok(review, "review-sweep discovered from a nested cwd");
		assert.strictEqual(review.source, "project");
		assert.strictEqual(review.description, "Multi-lens review sweep");
		assert.strictEqual(found.get("no-desc")?.description, undefined);
	} finally {
		proj.cleanup();
	}
});

test("loadWorkflowSource resolves by name and by path; unknown name lists available", () => {
	const proj = makeProject({ child: `return "hi";` });
	try {
		assert.strictEqual(loadWorkflowSource("child", proj.dir).source, `return "hi";`);
		assert.strictEqual(loadWorkflowSource(".pi/workflows/child.js", proj.dir).source, `return "hi";`);
		assert.throws(() => loadWorkflowSource("missing", proj.dir), /Unknown workflow "missing".*child/);
	} finally {
		proj.cleanup();
	}
});

test("workflowName runs a saved workflow with args", async () => {
	const proj = makeProject({ greet: `return "saved:" + args.who;` });
	try {
		const result = await workflowTool.execute(
			"reg1",
			{ name: "saved-run", description: "d", workflowName: "greet", args: { who: "pi" } },
			undefined,
			undefined,
			ctxFor(proj.dir),
		);
		assert.match(firstText(result.content), /saved:pi/);
	} finally {
		proj.cleanup();
	}
});

test("scriptPath runs a script file relative to cwd", async () => {
	const proj = makeProject({});
	try {
		fs.writeFileSync(path.join(proj.dir, "adhoc.js"), `return "from-path";`);
		const result = await workflowTool.execute(
			"reg2",
			{ name: "path-run", description: "d", scriptPath: "adhoc.js" },
			undefined,
			undefined,
			ctxFor(proj.dir),
		);
		assert.match(firstText(result.content), /from-path/);
	} finally {
		proj.cleanup();
	}
});

test("providing zero or multiple script sources is rejected", async () => {
	const proj = makeProject({ child: `return 1;` });
	try {
		for (const params of [
			{ name: "none", description: "d" },
			{ name: "both", description: "d", script: "return 1;", workflowName: "child" },
		]) {
			await assert.rejects(
				workflowTool.execute("reg3", params, undefined, undefined, ctxFor(proj.dir)),
				/exactly one of/,
			);
		}
	} finally {
		proj.cleanup();
	}
});

test("nested workflow() shares agent accounting and passes args", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const proj = makeProject({
		child: `const out = await agent("from child " + args.tag); return "child:" + out;`,
	});
	try {
		const result = await workflowTool.execute(
			"reg4",
			{
				name: "nested",
				description: "d",
				script: `const r = await workflow("child", { tag: "t1" }); return r + "|parent";`,
			},
			undefined,
			undefined,
			ctxFor(proj.dir),
		);
		assert.match(firstText(result.content), /child:FAKE_PI_OK\|parent/);
		// The child's agent() call is tracked in the parent run's records.
		assert.strictEqual(result.details.agents.length, 1);
		assert.ok(result.details.logs.some((l) => /── workflow child/.test(l)));
	} finally {
		proj.cleanup();
	}
});

test("concurrent sibling workflow() calls are allowed; child logs and phases are prefixed", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const proj = makeProject({
		child: `phase("scan"); log("inside"); const out = await agent("go " + args.tag); return args.tag + ":" + out;`,
	});
	try {
		const result = await workflowTool.execute(
			"reg6",
			{
				name: "siblings",
				description: "d",
				script: `
const [a, b] = await parallel([
  () => workflow("child", { tag: "one" }),
  () => workflow("child", { tag: "two" }),
]);
return a + "|" + b;
`,
			},
			undefined,
			undefined,
			ctxFor(proj.dir),
		);
		// Top-level siblings are not nesting; both must run (parallel() maps a
		// spurious nesting rejection to null, which would fail these asserts).
		assert.match(firstText(result.content), /one:FAKE_PI_OK\|two:FAKE_PI_OK/);
		assert.strictEqual(result.details.agents.length, 2);
		assert.ok(
			result.details.logs.some((l) => l === "[child] inside"),
			"child log() lines carry the child's name",
		);
		assert.ok(
			result.details.logs.some((l) => l === "── child: scan"),
			"child phase() titles carry the child's name",
		);
	} finally {
		proj.cleanup();
	}
});

test("workflow() nesting beyond one level is refused", async () => {
	const proj = makeProject({
		level1: `return await workflow("level2");`,
		level2: `return "too deep";`,
	});
	try {
		const result = await workflowTool.execute(
			"reg5",
			{
				name: "deep",
				description: "d",
				script: `try { return await workflow("level1"); } catch (e) { return "refused: " + e.message; }`,
			},
			undefined,
			undefined,
			ctxFor(proj.dir),
		);
		assert.match(firstText(result.content), /refused: .*nesting is limited to one level/);
	} finally {
		proj.cleanup();
	}
});
