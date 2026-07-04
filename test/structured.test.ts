import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { createStructuredOutputExtension, EMIT_RESULT_TOOL } from "../src/structured.ts";

test("generates a temp extension embedding the schema and terminate flag", async () => {
	const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
	const ext = await createStructuredOutputExtension(schema);
	try {
		assert.ok(fs.existsSync(ext.path));
		const source = fs.readFileSync(ext.path, "utf-8");
		assert.match(source, new RegExp(EMIT_RESULT_TOOL));
		assert.match(source, /terminate: true/);
		assert.match(source, /Type\.Unsafe\(schema\)/);
		// Schema round-trips through the embedded literal.
		assert.ok(source.includes('"answer"'));
		assert.ok(source.includes('"required"'));
		// File is private to the user.
		const mode = fs.statSync(ext.path).mode & 0o777;
		assert.strictEqual(mode, 0o600);
	} finally {
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
