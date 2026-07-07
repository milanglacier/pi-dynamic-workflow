/**
 * Per-run journaling for resume: every run records each successful agent()
 * call (keyed by a hash of prompt + behavioral options) to
 * `<agentDir>/pi-dynamic-workflow/runs/<runId>.json`. A later run passing
 * `resumeFromRunId` replays cached results for matching calls and only spawns
 * subagents for new or changed ones.
 *
 * Cache semantics are a multiset (hash → queue of results in completion
 * order), not a strict sequence: parallel() completes in nondeterministic
 * order, so position-based matching would spuriously bust the cache.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentOptions, UsageStats } from "./types.ts";

/** Runs beyond this count are pruned oldest-first when a new journal is created. */
const MAX_KEPT_RUNS = 50;

export interface JournalEntry {
	hash: string;
	label: string;
	outputText: string;
	structured?: unknown;
	model?: string;
	usage: UsageStats;
}

export interface RunJournal {
	runId: string;
	name: string;
	description: string;
	script: string;
	createdAt: number;
	entries: JournalEntry[];
}

export function runsDir(): string {
	return path.join(getAgentDir(), "pi-dynamic-workflow", "runs");
}

export function journalPath(runId: string): string {
	return path.join(runsDir(), `${runId}.json`);
}

export function newRunId(name: string): string {
	// Host-side code; the sandbox determinism guards do not apply here.
	const slug = name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40) || "workflow";
	return `${slug}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

/**
 * Cache key for one agent() call. Display-only options (label, phase) are
 * excluded so cosmetic edits to a script do not invalidate cached results.
 */
export function agentCallHash(prompt: string, opts: AgentOptions): string {
	const behavioral = {
		prompt,
		model: opts.model,
		tools: opts.tools,
		cwd: opts.cwd,
		schema: opts.schema,
		systemPrompt: opts.systemPrompt,
		appendSystemPrompt: opts.appendSystemPrompt,
		agentType: opts.agentType,
		timeout: opts.timeout,
	};
	return crypto.createHash("sha256").update(stableStringify(behavioral)).digest("hex");
}

/** Load a run journal; returns null when missing or unreadable. */
export function loadJournal(runId: string): RunJournal | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(journalPath(runId), "utf-8")) as RunJournal;
		if (!Array.isArray(parsed.entries)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Group journal entries into hash → queue-of-results, preserving order. */
export function buildResumeCache(journal: RunJournal): Map<string, JournalEntry[]> {
	const cache = new Map<string, JournalEntry[]>();
	for (const entry of journal.entries) {
		const queue = cache.get(entry.hash);
		if (queue) queue.push(entry);
		else cache.set(entry.hash, [entry]);
	}
	return cache;
}

function pruneOldRuns(dir: string): void {
	let entries: Array<{ path: string; mtimeMs: number }>;
	try {
		entries = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				const p = path.join(dir, f);
				return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
			});
	} catch {
		return;
	}
	if (entries.length <= MAX_KEPT_RUNS) return;
	entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const stale of entries.slice(0, entries.length - MAX_KEPT_RUNS)) {
		try {
			fs.rmSync(stale.path, { force: true });
		} catch {
			// best-effort
		}
	}
}

/**
 * Journals a run as it progresses. All disk I/O is best-effort: a failed
 * write must never take down the workflow it is recording.
 */
export class JournalWriter {
	private readonly journal: RunJournal;
	readonly filePath: string;

	constructor(meta: { runId: string; name: string; description: string; script: string }) {
		this.journal = { ...meta, createdAt: Date.now(), entries: [] };
		this.filePath = journalPath(meta.runId);
		try {
			fs.mkdirSync(runsDir(), { recursive: true });
			pruneOldRuns(runsDir());
		} catch {
			// best-effort
		}
		this.flush();
	}

	record(entry: JournalEntry): void {
		this.journal.entries.push(entry);
		this.flush();
	}

	private flush(): void {
		try {
			fs.writeFileSync(this.filePath, JSON.stringify(this.journal));
		} catch {
			// best-effort
		}
	}
}
