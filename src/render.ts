/** TUI rendering for the `workflow` tool. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentRecord, UsageStats, WorkflowDetails } from "./types.ts";

const COLLAPSED_LOG_COUNT = 5;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function aggregateUsage(agents: AgentRecord[]): UsageStats {
	const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const a of agents) {
		total.input += a.usage.input;
		total.output += a.usage.output;
		total.cacheRead += a.usage.cacheRead;
		total.cacheWrite += a.usage.cacheWrite;
		total.cost += a.usage.cost;
		total.turns += a.usage.turns;
	}
	return total;
}

function statusIcon(status: AgentRecord["status"], theme: Theme): string {
	switch (status) {
		case "queued":
			return theme.fg("muted", "·");
		case "running":
			return theme.fg("warning", "⏳");
		case "done":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("muted", "⊘");
	}
}

/** Group agents by phase, preserving first-seen phase order. */
function groupByPhase(agents: AgentRecord[]): Map<string, AgentRecord[]> {
	const groups = new Map<string, AgentRecord[]>();
	for (const a of agents) {
		const key = a.phase ?? "";
		const list = groups.get(key);
		if (list) list.push(a);
		else groups.set(key, [a]);
	}
	return groups;
}

export function renderWorkflowCall(
	args: { name?: string; description?: string; phases?: string[] },
	theme: Theme,
): Text {
	let text = theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", args.name ?? "...");
	if (args.description) {
		const firstLine = args.description.split("\n")[0] ?? "";
		text += theme.fg("dim", ` ${firstLine}`);
	}
	if (args.phases && args.phases.length > 0) {
		text += `\n  ${theme.fg("muted", `phases: ${args.phases.join(" → ")}`)}`;
	}
	return new Text(text, 0, 0);
}

export function renderWorkflowResult(
	result: AgentToolResult<WorkflowDetails>,
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
): Container | Text {
	const details = result.details;
	if (!details) {
		const first = result.content[0];
		return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
	}

	const { expanded } = options;
	const running = details.agents.filter((a) => a.status === "running" || a.status === "queued").length;
	const failed = details.agents.filter((a) => a.status === "error").length;
	const isRunning = running > 0 || !details.finishedAt;

	const headerIcon = details.scriptError
		? theme.fg("error", "✗")
		: details.aborted
			? theme.fg("muted", "⊘")
			: isRunning
				? theme.fg("warning", "⏳")
				: failed > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");

	const doneCount = details.agents.filter((a) => a.status === "done").length;
	const status = isRunning
		? `${doneCount}/${details.agents.length} agents done, ${running} running`
		: `${doneCount}/${details.agents.length} agents`;

	let header = `${headerIcon} ${theme.fg("toolTitle", theme.bold(details.name))} ${theme.fg("accent", status)}`;
	if (details.aborted) header += ` ${theme.fg("muted", "[aborted]")}`;

	const container = new Container();
	container.addChild(new Text(header, 0, 0));

	if (details.scriptError) {
		container.addChild(new Text(theme.fg("error", details.scriptError), 0, 0));
	}

	for (const [phaseName, agents] of groupByPhase(details.agents)) {
		if (phaseName) {
			container.addChild(new Text(theme.fg("muted", `─── ${phaseName} ───`), 0, 0));
		}
		for (const a of agents) {
			let line = `${statusIcon(a.status, theme)} ${theme.fg("accent", a.label)}`;
			const usageStr = formatUsage(a.usage, a.model);
			if (usageStr) line += ` ${theme.fg("dim", usageStr)}`;
			container.addChild(new Text(line, 0, 0));
			if (a.status === "error" && a.error) {
				container.addChild(new Text(theme.fg("error", `  ${a.error}`), 0, 0));
			}
			if (expanded && a.output) {
				container.addChild(new Markdown(a.output.trim(), 0, 0, getMarkdownTheme()));
				container.addChild(new Spacer(1));
			}
		}
	}

	if (details.logs.length > 0) {
		const logs = expanded ? details.logs : details.logs.slice(-COLLAPSED_LOG_COUNT);
		const skipped = details.logs.length - logs.length;
		container.addChild(new Text(theme.fg("muted", "─── log ───"), 0, 0));
		if (skipped > 0) container.addChild(new Text(theme.fg("muted", `... ${skipped} earlier entries`), 0, 0));
		for (const line of logs) {
			container.addChild(new Text(theme.fg("dim", line), 0, 0));
		}
	}

	if (expanded && details.returnValue !== undefined) {
		container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
		const text =
			typeof details.returnValue === "string"
				? details.returnValue
				: JSON.stringify(details.returnValue, null, 2);
		container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
	}

	const total = aggregateUsage(details.agents);
	const totalStr = formatUsage(total);
	if (totalStr) {
		container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
	}
	if (!expanded && !isRunning) {
		container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
	}
	return container;
}
