/** Tool selection controls shared by scripts, agent profiles, and subprocess requests. */

import { EMIT_RESULT_TOOL } from "./structured.ts";

export interface ToolControls {
	/** Names or `*` patterns excluded after tool selection. */
	excludeTools?: string[];
	/** Disable Pi's built-in MCP support for this subagent. */
	noMcp?: boolean;
}

/** Validate controls before cache lookup or subprocess creation. */
export function validateToolControls(
	controls: { excludeTools?: unknown; noMcp?: unknown },
	structuredOutput = false,
): asserts controls is ToolControls {
	if (controls.noMcp !== undefined && typeof controls.noMcp !== "boolean") {
		throw new Error("noMcp must be a boolean");
	}
	if (controls.excludeTools === undefined) return;
	if (!Array.isArray(controls.excludeTools)) {
		throw new Error("excludeTools must be an array of tool names or patterns");
	}
	for (const entry of controls.excludeTools) {
		if (typeof entry !== "string" || !entry.trim() || entry.includes(",")) {
			throw new Error("excludeTools entries must be non-empty strings without commas");
		}
		if (structuredOutput) {
			const source = entry.trim()
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*");
			if (new RegExp(`^${source}$`).test(EMIT_RESULT_TOOL)) {
				throw new Error(`excludeTools cannot exclude ${EMIT_RESULT_TOOL} when schema is supplied`);
			}
		}
	}
}
