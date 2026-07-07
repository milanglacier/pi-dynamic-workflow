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
import { discoverWorkflows } from "./registry.ts";
import { createWorkflowTool, listActiveWorkflowRuns, stopWorkflowRun, WORKFLOW_COMPLETE_TYPE } from "./tool.ts";

const BRIEF_TYPE = "dynamic-workflow-brief";

export default function (pi: ExtensionAPI) {
	const workflowTool = createWorkflowTool(pi);
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
			const sections = [WORKFLOW_GUIDE];
			const saved = discoverWorkflows(ctx.cwd);
			if (saved.size > 0) {
				const list = [...saved.values()]
					.map((w) => `- ${w.name} (${w.source})${w.description ? `: ${w.description}` : ""}`)
					.join("\n");
				sections.push(
					`## Saved workflows\n\nWhen one of these fits the task, invoke the tool with \`workflowName\` (plus \`args\`) instead of authoring a script:\n\n${list}`,
				);
			}
			sections.push(`## Task\n\n${task}`);
			pi.sendMessage(
				{
					customType: BRIEF_TYPE,
					content: sections.join("\n\n"),
					display: true,
					details: { task },
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("workflow-stop", {
		description: "Stop a background workflow run: /workflow-stop <runId>",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				const active = listActiveWorkflowRuns();
				ctx.ui.notify(
					active.length > 0
						? `Active background runs: ${active.join(", ")}. Usage: /workflow-stop <runId>`
						: "No background workflow runs are active.",
					"info",
				);
				return;
			}
			if (stopWorkflowRun(runId)) {
				ctx.ui.notify(`Aborting background workflow run ${runId}`, "info");
			} else {
				ctx.ui.notify(`No active background run "${runId}"`, "warning");
			}
		},
	});

	pi.registerMessageRenderer(WORKFLOW_COMPLETE_TYPE, (message, { expanded }, theme) => {
		const content = String(message.content);
		if (expanded) return new Text(theme.fg("muted", content), 0, 0);
		const firstLine = content.split("\n")[0] ?? "";
		return new Text(theme.fg("accent", "workflow complete ") + theme.fg("dim", firstLine), 0, 0);
	});

	// Background runs must not outlive the session that owns their subprocesses.
	pi.on("session_shutdown", () => {
		for (const runId of listActiveWorkflowRuns()) stopWorkflowRun(runId);
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
