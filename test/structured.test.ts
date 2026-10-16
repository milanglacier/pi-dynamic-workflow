import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createStructuredOutputExtension, EMIT_RESULT_TOOL } from "../src/structured.ts";
import { createToolContext } from "./tool-context.ts";

type RegisteredTool = Pick<ToolDefinition, "name" | "parameters" | "execute">;

test("generated extension registers a terminating emit_result tool embedding the schema", async () => {
	const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
	const ext = await createStructuredOutputExtension(schema);
	// The generated file imports `typebox` at runtime; make it resolvable from
	// the temp dir by symlinking the project's node_modules next to it.
	const nodeModulesLink = path.join(path.dirname(ext.path), "node_modules");
	const tsconfigPath = path.join(path.dirname(ext.path), "tsconfig.json");
	fs.symlinkSync(path.resolve(import.meta.dirname, "..", "node_modules"), nodeModulesLink, "dir");
	try {
		// Generated production code uses the same strict SDK checks as checked-in source.
		fs.writeFileSync(tsconfigPath, JSON.stringify({
			extends: path.resolve(import.meta.dirname, "..", "tsconfig.json"),
			include: [ext.path],
		}));
		const checked = spawnSync(process.execPath, [
			fileURLToPath(import.meta.resolve("typescript/lib/tsc.js")), "--project", tsconfigPath,
		], { encoding: "utf-8", timeout: 30_000 });
		assert.ifError(checked.error);
		assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);

		// File is private to the user.
		const mode = fs.statSync(ext.path).mode & 0o777;
		assert.strictEqual(mode, 0o600);

		// Behavioral check: import the generated module and drive it like pi would.
		const mod: { default: (pi: Pick<ExtensionAPI, "registerTool">) => void } =
			await import(pathToFileURL(ext.path).href);
		let registered: RegisteredTool | undefined;
		const host = {
			registerTool(tool) {
				registered = tool;
			},
		} satisfies Pick<ExtensionAPI, "registerTool">;
		mod.default(host);
		assert.ok(registered, "extension registered a tool");
		assert.strictEqual(registered.name, EMIT_RESULT_TOOL);
		// Type.Unsafe passes the schema through; compare via JSON (symbol keys drop out).
		assert.strictEqual(JSON.stringify(registered.parameters), JSON.stringify(schema));

		const result = await registered.execute("t1", { answer: 5 }, undefined, undefined, createToolContext(process.cwd()));
		assert.strictEqual(result.terminate, true);
		assert.deepStrictEqual(result.details, { answer: 5 });
	} finally {
		fs.rmSync(tsconfigPath, { force: true });
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
