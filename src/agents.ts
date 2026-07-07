/**
 * Discovery of named agent definitions following pi's agents convention:
 * `~/.pi/agent/agents/*.md` (user) and the nearest `<project>/.pi/agents/*.md`
 * (project, overrides user on name collision). Frontmatter: name, description,
 * tools (comma-separated), model; the markdown body is the system prompt.
 *
 * Adapted from the official subagent example's discovery code ONLY — its pi
 * invocation logic (`getPiInvocation`) is intentionally not copied; see
 * CLAUDE.md and src/subagent.ts for why.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentTypeConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentTypeConfig[] {
	const agents: AgentTypeConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			...(tools && tools.length > 0 ? { tools } : {}),
			...(frontmatter.model ? { model: frontmatter.model } : {}),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// keep walking up
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** Discover agent definitions; project entries override user entries by name. */
export function discoverAgentTypes(cwd: string): Map<string, AgentTypeConfig> {
	const map = new Map<string, AgentTypeConfig>();
	for (const agent of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) {
		map.set(agent.name, agent);
	}
	const projectDir = findNearestProjectAgentsDir(cwd);
	if (projectDir) {
		for (const agent of loadAgentsFromDir(projectDir, "project")) {
			map.set(agent.name, agent);
		}
	}
	return map;
}
