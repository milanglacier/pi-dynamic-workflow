import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createStructuredOutputExtension, EMIT_RESULT_TOOL } from "../src/structured.ts";

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute(toolCallId: string, params: unknown): Promise<{ details: unknown; terminate?: boolean }>;
}

test("generated extension registers a terminating emit_result tool embedding the schema", async () => {
	const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
	const ext = await createStructuredOutputExtension(schema);
	// The generated file imports `typebox` at runtime; make it resolvable from
	// the temp dir by symlinking the project's node_modules next to it.
	const nodeModulesLink = path.join(path.dirname(ext.path), "node_modules");
	fs.symlinkSync(path.resolve(import.meta.dirname, "..", "node_modules"), nodeModulesLink, "dir");
	try {
		// File is private to the user.
		const mode = fs.statSync(ext.path).mode & 0o777;
		assert.strictEqual(mode, 0o600);

		// Behavioral check: import the generated module and drive it like pi would.
		const mod = await import(pathToFileURL(ext.path).href);
		let registered: RegisteredTool | undefined;
		mod.default({
			registerTool(tool: RegisteredTool) {
				registered = tool;
			},
		});
		assert.ok(registered, "extension registered a tool");
		assert.strictEqual(registered.name, EMIT_RESULT_TOOL);
		// Type.Unsafe passes the schema through; compare via JSON (symbol keys drop out).
		assert.strictEqual(JSON.stringify(registered.parameters), JSON.stringify(schema));

		const result = await registered.execute("t1", { answer: 5 });
		assert.strictEqual(result.terminate, true);
		assert.deepStrictEqual(result.details, { answer: 5 });
	} finally {
		fs.unlinkSync(nodeModulesLink);
		ext.cleanup();
	}
});

test("cleanup removes the file and its directory", async () => {
	const ext = await createStructuredOutputExtension({ type: "object" });
	const dir = path.dirname(ext.path);
	ext.cleanup();
	assert.ok(!fs.existsSync(ext.path));
	assert.ok(!fs.existsSync(dir));
	// Idempotent.
	ext.cleanup();
});
