import assert from "node:assert";
import { test } from "node:test";
import { validateToolControls } from "../src/tool-controls.ts";

test("tool controls accept omission, explicit clearing, and wildcard exclusions", () => {
	for (const controls of [{}, { noMcp: false, excludeTools: [] }, { noMcp: true, excludeTools: ["write", "mcp__github__delete_*"] }]) {
		assert.doesNotThrow(() => validateToolControls(controls));
	}
});

test("tool controls reject invalid flags and exclusion lists", () => {
	for (const noMcp of [null, "true", "false", 0, 1, []]) {
		assert.throws(() => validateToolControls({ noMcp }), /noMcp must be a boolean/);
	}
	for (const excludeTools of [null, "write", true, {}]) {
		assert.throws(() => validateToolControls({ excludeTools }), /excludeTools must be an array/);
	}
	for (const entry of [null, 1, true, "", "  ", "read,write"]) {
		assert.throws(() => validateToolControls({ excludeTools: [entry] }), /entries must be non-empty strings without commas/);
	}
	assert.throws(() => validateToolControls({ excludeTools: new Array(1) }), /entries must be non-empty/);
});

test("structured output rejects exact and wildcard exclusions of emit_result", () => {
	for (const entry of ["emit_result", "*", "emit_*", "*_result", "e*it_r*sult", " emit_result "]) {
		assert.throws(() => validateToolControls({ excludeTools: [entry] }, true), /cannot exclude emit_result when schema is supplied/);
		assert.doesNotThrow(() => validateToolControls({ excludeTools: [entry] }));
	}
});

test("exclusion patterns use literal characters apart from star", () => {
	for (const entry of ["mcp__*", "emit.result", "emit_result[abc]", "emit_resul?", "emit_result$", "emit_result.*", "emit_result\\*"]) {
		assert.doesNotThrow(() => validateToolControls({ excludeTools: [entry] }, true));
	}
});
