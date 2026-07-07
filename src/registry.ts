/**
 * Registry of saved workflow scripts: `~/.pi/agent/workflows/*.js` (user) and
 * the nearest `<project>/.pi/workflows/*.js` (project, overrides user on name
 * collision). A file's name (minus extension) is the workflow name; a leading
 * `//` comment line doubles as its description.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SavedWorkflow {
	name: string;
	description?: string;
	filePath: string;
	source: "user" | "project";
}

function firstCommentLine(source: string): string | undefined {
	const line = source.split("\n", 1)[0]?.trim();
	if (line?.startsWith("//")) return line.replace(/^\/\/\s*/, "");
	return undefined;
}

function loadWorkflowsFromDir(dir: string, source: "user" | "project"): SavedWorkflow[] {
	const workflows: SavedWorkflow[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return workflows;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".js")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let description: string | undefined;
		try {
			description = firstCommentLine(fs.readFileSync(filePath, "utf-8"));
		} catch {
			continue;
		}
		workflows.push({
			name: entry.name.slice(0, -".js".length),
			...(description ? { description } : {}),
			filePath,
			source,
		});
	}
	return workflows;
}

function findNearestProjectWorkflowsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "workflows");
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

/** Discover saved workflows; project entries override user entries by name. */
export function discoverWorkflows(cwd: string): Map<string, SavedWorkflow> {
	const map = new Map<string, SavedWorkflow>();
	for (const wf of loadWorkflowsFromDir(path.join(getAgentDir(), "workflows"), "user")) {
		map.set(wf.name, wf);
	}
	const projectDir = findNearestProjectWorkflowsDir(cwd);
	if (projectDir) {
		for (const wf of loadWorkflowsFromDir(projectDir, "project")) {
			map.set(wf.name, wf);
		}
	}
	return map;
}

/**
 * Load a workflow script body by saved name or by path (anything containing a
 * path separator or ending in .js is treated as a path relative to `cwd`).
 */
export function loadWorkflowSource(nameOrPath: string, cwd: string): { source: string; filePath: string } {
	const looksLikePath = nameOrPath.includes("/") || nameOrPath.includes(path.sep) || nameOrPath.endsWith(".js");
	if (looksLikePath) {
		const filePath = path.resolve(cwd, nameOrPath);
		return { source: fs.readFileSync(filePath, "utf-8"), filePath };
	}
	const workflows = discoverWorkflows(cwd);
	const saved = workflows.get(nameOrPath);
	if (!saved) {
		const available = [...workflows.keys()].join(", ") || "(none found)";
		throw new Error(`Unknown workflow "${nameOrPath}". Saved workflows: ${available}`);
	}
	return { source: fs.readFileSync(saved.filePath, "utf-8"), filePath: saved.filePath };
}
