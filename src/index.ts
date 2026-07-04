/**
 * pi-dynamic-workflow extension entry point.
 *
 * Registers the `/workflow` command and a compact renderer for the injected
 * authoring brief. The `workflow` tool itself is registered lazily on first
 * use so sessions that never invoke `/workflow` do not carry it in their
 * system prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { WORKFLOW_GUIDE } from "./guide.ts";
import { workflowTool } from "./tool.ts";

const BRIEF_TYPE = "dynamic-workflow-brief";

export default function (pi: ExtensionAPI) {
	let toolRegistered = false;

	const ensureToolRegistered = () => {
		if (toolRegistered) return;
		toolRegistered = true;
		pi.registerTool(workflowTool);
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "workflow"])]);
	};

	pi.registerCommand("workflow", {
		description: "Author and run a dynamic multi-agent workflow: /workflow <task>",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /workflow <task description>", "warning");
				return;
			}
			ensureToolRegistered();
			pi.sendMessage(
				{
					customType: BRIEF_TYPE,
					content: `${WORKFLOW_GUIDE}\n\n## Task\n\n${task}`,
					display: true,
					details: { task },
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerMessageRenderer<{ task?: string }>(BRIEF_TYPE, (message, { expanded }, theme) => {
		if (expanded) {
			return new Text(theme.fg("muted", String(message.content)), 0, 0);
		}
		const task = message.details?.task ?? "";
		const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
		return new Text(
			theme.fg("accent", "workflow brief ") + theme.fg("dim", preview || "(authoring guide injected)"),
			0,
			0,
		);
	});

	// Resumed sessions whose branch already contains workflow tool calls need
	// the tool re-registered so prior results render and remain re-invocable.
	pi.on("session_start", (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "workflow"
			) {
				ensureToolRegistered();
				break;
			}
		}
	});
}
