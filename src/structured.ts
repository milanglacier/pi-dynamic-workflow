/**
 * Schema-enforced structured output for subagents.
 *
 * Generates a temporary pi extension that registers a terminating `emit_result`
 * tool whose parameters are the caller-supplied JSON schema. pi validates tool
 * arguments against the schema (and retries the model on validation errors), so
 * the parent only needs to extract the final `emit_result` call arguments.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const EMIT_RESULT_TOOL = "emit_result";

export interface StructuredOutputExtension {
	/** Path to the generated extension file (pass to `pi -e`). */
	path: string;
	/** Remove the temp file and directory. */
	cleanup(): void;
}

export async function createStructuredOutputExtension(
	schema: Record<string, unknown>,
): Promise<StructuredOutputExtension> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-schema-"));
	const filePath = path.join(dir, "structured-output.ts");

	const source = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const schema = ${JSON.stringify(schema, null, "\t")} as const;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: ${JSON.stringify(EMIT_RESULT_TOOL)},
		label: "Emit Result",
		description:
			"Emit the final structured result for this task. Call this exactly once, as your last action, with the complete answer matching the required schema.",
		promptSnippet: "Emit the final structured result (required last action)",
		promptGuidelines: [
			"You MUST finish by calling ${EMIT_RESULT_TOOL} exactly once with the final answer matching its parameter schema. Do not answer in plain text.",
		],
		parameters: Type.Unsafe(schema),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Structured result recorded." }],
				details: params,
				terminate: true,
			};
		},
	});
}
`;

	await fs.promises.writeFile(filePath, source, { encoding: "utf-8", mode: 0o600 });

	return {
		path: filePath,
		cleanup() {
			try {
				fs.unlinkSync(filePath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmdirSync(dir);
			} catch {
				/* ignore */
			}
		},
	};
}
