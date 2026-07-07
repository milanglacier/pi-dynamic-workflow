/**
 * Runs a single pi subagent as a subprocess (`pi --mode json -p --no-session`)
 * and parses its newline-delimited JSON event stream.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createStructuredOutputExtension, EMIT_RESULT_TOOL } from "./structured.ts";
import { addUsage, emptyUsage, type UsageStats } from "./types.ts";

export interface SubagentRequest {
	prompt: string;
	model?: string;
	tools?: string[];
	cwd: string;
	schema?: Record<string, unknown>;
	signal?: AbortSignal;
	/** Wall-clock cap in ms; on expiry the subprocess is killed and the result is a non-abort failure. */
	timeoutMs?: number;
	/** Replaces the subagent's system prompt (`pi --system-prompt`). */
	systemPrompt?: string;
	/** Appended to the system prompt in order (`pi --append-system-prompt`, via temp files). */
	appendSystemPrompt?: string[];
	/** Called on each parsed event so the parent can stream progress. */
	onEvent?: (update: SubagentProgress) => void;
}

export interface SubagentProgress {
	/** Short human-readable description of the latest activity. */
	activity: string;
	usage: UsageStats;
}

export interface SubagentResult {
	ok: boolean;
	/** Last assistant text output. */
	outputText: string;
	/** Parsed `emit_result` arguments when a schema was supplied. */
	structured?: unknown;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	exitCode: number;
	aborted: boolean;
}

/** Env var counting nested subagent depth to prevent runaway recursion (fork bombs). */
const DEPTH_ENV = "PI_WORKFLOW_DEPTH";
const MAX_SUBAGENT_DEPTH = 3;

/**
 * Resolve how to invoke pi.
 *
 * Unlike the official subagent example, this only reuses `process.argv[1]`
 * when it plausibly IS pi's CLI entry point. Blindly re-invoking argv[1]
 * would fork-bomb the machine if this module is ever loaded outside pi
 * (e.g. from a test harness: argv[1] is the harness, which re-runs itself).
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const looksLikePiEntry = currentScript !== undefined && /^(pi|cli\.(js|ts|mjs))$/.test(path.basename(currentScript));
	if (currentScript && looksLikePiEntry && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function lastAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

function lastEmitResultArguments(messages: Message[]): unknown {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part?.type === "toolCall" && part.name === EMIT_RESULT_TOOL) {
				return part.arguments;
			}
		}
	}
	return undefined;
}

export async function runSubagent(request: SubagentRequest): Promise<SubagentResult> {
	const { prompt, model, tools, cwd, schema, signal, timeoutMs, systemPrompt, appendSystemPrompt, onEvent } = request;

	// Hard recursion guard: a subagent that itself spawns workflows could
	// otherwise multiply subprocesses without bound.
	const depth = Number(process.env[DEPTH_ENV] ?? "0") || 0;
	if (depth >= MAX_SUBAGENT_DEPTH) {
		return {
			ok: false,
			outputText: "",
			usage: emptyUsage(),
			exitCode: 1,
			aborted: false,
			errorMessage: `Subagent nesting depth limit (${MAX_SUBAGENT_DEPTH}) reached; refusing to spawn`,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (tools && tools.length > 0) {
		const toolList = schema ? [...new Set([...tools, EMIT_RESULT_TOOL])] : tools;
		args.push("--tools", toolList.join(","));
	}
	if (systemPrompt) args.push("--system-prompt", systemPrompt);

	// --append-system-prompt accepts text or a file path; prompt text that
	// happens to look like a path would be misread, so always pass a temp file.
	let promptDir: string | null = null;
	if (appendSystemPrompt && appendSystemPrompt.length > 0) {
		promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-sysprompt-"));
		appendSystemPrompt.forEach((text, i) => {
			const promptPath = path.join(promptDir as string, `append-${i}.md`);
			fs.writeFileSync(promptPath, text, "utf-8");
			args.push("--append-system-prompt", promptPath);
		});
	}

	let structuredExt: Awaited<ReturnType<typeof createStructuredOutputExtension>> | null = null;
	if (schema) {
		structuredExt = await createStructuredOutputExtension(schema);
		args.push("-e", structuredExt.path);
	}
	args.push(prompt);

	const messages: Message[] = [];
	const usage = emptyUsage();
	const result: SubagentResult = {
		ok: false,
		outputText: "",
		usage,
		exitCode: 0,
		aborted: false,
	};
	let stderr = "";
	let timedOut = false;

	try {
		result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [DEPTH_ENV]: String(depth + 1) },
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: Message; toolName?: string };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					messages.push(msg);
					if (msg.role === "assistant") {
						const assistant = msg as AssistantMessage;
						usage.turns++;
						if (assistant.usage) {
							addUsage(usage, {
								input: assistant.usage.input || 0,
								output: assistant.usage.output || 0,
								cacheRead: assistant.usage.cacheRead || 0,
								cacheWrite: assistant.usage.cacheWrite || 0,
								cost: assistant.usage.cost?.total || 0,
								turns: 0,
							});
						}
						if (!result.model && assistant.model) result.model = assistant.model;
						if (assistant.stopReason) result.stopReason = assistant.stopReason;
						if (assistant.errorMessage) result.errorMessage = assistant.errorMessage;

						const text = lastAssistantText([msg]);
						onEvent?.({ activity: text ? text.slice(0, 120) : "thinking...", usage: { ...usage } });
					}
				} else if (event.type === "tool_execution_start" && event.toolName) {
					onEvent?.({ activity: `→ ${event.toolName}`, usage: { ...usage } });
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			// NOTE: `proc.killed` only means a signal was *sent*, so it cannot
			// detect a child that ignores SIGTERM; check exit status instead.
			let killedByUs = false;
			const terminate = () => {
				killedByUs = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				}, 5000).unref();
			};

			let timeoutTimer: NodeJS.Timeout | undefined;
			if (timeoutMs && timeoutMs > 0) {
				timeoutTimer = setTimeout(() => {
					timedOut = true;
					terminate();
				}, timeoutMs);
				timeoutTimer.unref();
			}

			proc.on("close", (code, killSignal) => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (buffer.trim()) processLine(buffer);
				// A null code means signal death. Our own kills are reported via
				// the aborted/timedOut flags; an external kill (OOM killer, manual
				// SIGKILL) must read as failure, not as a success with partial output.
				if (code === null && !killedByUs) {
					result.errorMessage ??= `pi killed by signal ${killSignal ?? "unknown"}`;
					resolve(1);
					return;
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					result.aborted = true;
					terminate();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});
	} finally {
		structuredExt?.cleanup();
		if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true });
	}

	result.outputText = lastAssistantText(messages);

	if (result.aborted) {
		result.errorMessage ??= "Subagent aborted";
		return result;
	}

	// A timed-out child dies via SIGTERM (close code null → 0), so without this
	// check it could masquerade as a successful run with partial output.
	if (timedOut) {
		result.errorMessage = `Subagent timed out after ${timeoutMs}ms`;
		return result;
	}

	const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	if (failed) {
		result.errorMessage ??= stderr.trim() || `pi exited with code ${result.exitCode}`;
		return result;
	}

	if (schema) {
		const structured = lastEmitResultArguments(messages);
		if (structured === undefined) {
			result.errorMessage = `Subagent finished without calling ${EMIT_RESULT_TOOL} (structured output missing)`;
			return result;
		}
		result.structured = structured;
	}

	result.ok = true;
	return result;
}
