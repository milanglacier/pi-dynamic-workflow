/**
 * runSubagent tests against the fake pi stub (see test/fake-pi.ts).
 * Never spawns the real pi binary.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { runSubagent } from "../src/subagent.ts";
import { installFakePi } from "./fake-pi.ts";

let fakePi: ReturnType<typeof installFakePi>;
const cwd = os.tmpdir();

before(() => {
	fakePi = installFakePi();
});

after(() => {
	fakePi.cleanup();
});

afterEach(() => {
	delete process.env.FAKE_PI_MODE;
	delete process.env.PI_WORKFLOW_DEPTH;
	delete process.env.FAKE_PI_ARGS_FILE;
});

async function capturedArgs(request: Parameters<typeof runSubagent>[0]): Promise<string[]> {
	const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-args-")), "args.json");
	process.env.FAKE_PI_ARGS_FILE = argsFile;
	try {
		await runSubagent(request);
		return JSON.parse(fs.readFileSync(argsFile, "utf-8"));
	} finally {
		fs.rmSync(path.dirname(argsFile), { recursive: true, force: true });
	}
}

test("parses the JSON event stream: text, model, usage", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await runSubagent({ prompt: "anything", cwd });
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.outputText, "FAKE_PI_OK");
	assert.strictEqual(result.model, "fake-model");
	assert.strictEqual(result.stopReason, "stop");
	assert.strictEqual(result.usage.turns, 1);
	assert.strictEqual(result.usage.input, 1);
	assert.strictEqual(result.usage.output, 2);
	assert.ok(Math.abs(result.usage.cost - 0.001) < 1e-9);
});

test("child receives incremented PI_WORKFLOW_DEPTH", async () => {
	process.env.FAKE_PI_MODE = "depth";
	const result = await runSubagent({ prompt: "anything", cwd });
	assert.strictEqual(result.outputText, "1");
});

test("refuses to spawn at the depth limit", async () => {
	process.env.FAKE_PI_MODE = "ok";
	process.env.PI_WORKFLOW_DEPTH = "3";
	const result = await runSubagent({ prompt: "anything", cwd });
	assert.strictEqual(result.ok, false);
	assert.match(result.errorMessage ?? "", /nesting depth limit/);
});

test("nonzero exit reports failure with stderr", async () => {
	process.env.FAKE_PI_MODE = "fail";
	const result = await runSubagent({ prompt: "anything", cwd });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.exitCode, 3);
	assert.match(result.errorMessage ?? "", /boom/);
});

test("schema run extracts emit_result arguments", async () => {
	process.env.FAKE_PI_MODE = "structured";
	const result = await runSubagent({
		prompt: "anything",
		cwd,
		schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
	});
	assert.strictEqual(result.ok, true);
	assert.deepStrictEqual(result.structured, { answer: 5 });
});

test("schema run without emit_result call fails", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const result = await runSubagent({
		prompt: "anything",
		cwd,
		schema: { type: "object" },
	});
	assert.strictEqual(result.ok, false);
	assert.match(result.errorMessage ?? "", /emit_result/);
});

test("--tools restriction merges emit_result when a schema is supplied", async () => {
	process.env.FAKE_PI_MODE = "structured";
	const args = await capturedArgs({
		prompt: "anything",
		cwd,
		tools: ["read", "grep"],
		schema: { type: "object" },
	});
	const toolsIdx = args.indexOf("--tools");
	assert.ok(toolsIdx >= 0, "--tools flag present");
	assert.strictEqual(args[toolsIdx + 1], "read,grep,emit_result");
	assert.ok(args.includes("-e"), "-e structured extension flag present");
});

test("--tools restriction is passed through unchanged without a schema", async () => {
	process.env.FAKE_PI_MODE = "ok";
	const args = await capturedArgs({ prompt: "anything", cwd, tools: ["read"] });
	const toolsIdx = args.indexOf("--tools");
	assert.strictEqual(args[toolsIdx + 1], "read");
	assert.ok(!args.includes("-e"));
});

test("abort signal terminates the subprocess", async () => {
	process.env.FAKE_PI_MODE = "sleep";
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const start = Date.now();
	const result = await runSubagent({ prompt: "anything", cwd, signal: controller.signal });
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.aborted, true);
	assert.ok(Date.now() - start < 5000, "should not wait out the 30s sleep");
});
