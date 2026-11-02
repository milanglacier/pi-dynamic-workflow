/**
 * Fake `pi` stub for tests (per CLAUDE.md: never spawn real pi from tests).
 *
 * Creates a temp dir containing an executable `pi` Node script that emits a
 * canned JSON event stream. Behavior is selected via the FAKE_PI_MODE env var:
 *   ok         - one assistant message with text "FAKE_PI_OK", exit 0
 *   depth      - assistant text is the child's PI_WORKFLOW_DEPTH value
 *   structured - emit_result toolCall {answer: 5} and pi's accepted tool result
 *   coerced    - emit_result toolCall {answer: "5"}; pi's tool result holds {answer: 5}
 *   rejected   - emit_result toolCall {} that pi's schema check rejects, then a final text response
 *   malformed  - unparseable emit_result arguments that pi rejects, then a final text response
 *   fail       - writes "boom" to stderr, exit 3
 *   truncated  - partial assistant text, output-limit warning, exit 1
 *   sleep      - hangs for 30s (for abort tests; SIGTERM kills it)
 *   slow       - waits 150ms, then behaves like "ok" (for concurrency tests)
 *   selfkill   - SIGKILLs itself after emitting one message (external signal death)
 *
 * If FAKE_PI_ARGS_FILE is set, the stub writes its argv (JSON array) to that
 * path before doing anything else, so tests can assert on the CLI invocation.
 *
 * If FAKE_PI_COPY_APPEND_PROMPTS is also set, the stub reads the contents of
 * every --append-system-prompt file argument and writes them (JSON array) to
 * `${FAKE_PI_ARGS_FILE}.prompts` — the parent deletes those temp files after
 * the run, so tests must snapshot them from inside the child.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const truncatedMessage: AssistantMessage = {
	role: "assistant", content: [{ type: "text", text: "PARTIAL_OUTPUT" }],
	api: "anthropic-messages", provider: "fake", model: "fake-model",
	usage: {
		input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "length", timestamp: 0,
};

const malformedArgumentsMessage: AssistantMessage = {
	...truncatedMessage,
	content: [{
		type: "toolCall", id: "malformed-1", name: "emit_result", arguments: {},
		argumentsError: "Invalid JSON in final tool arguments",
	}],
	stopReason: "toolUse",
};

const STUB_SOURCE = `#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE || "ok";
if (process.env.FAKE_PI_ARGS_FILE) {
	const fs = require("node:fs");
	const argv = process.argv.slice(2);
	fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(argv));
	if (process.env.FAKE_PI_COPY_APPEND_PROMPTS) {
		const prompts = [];
		argv.forEach((a, i) => {
			if (a === "--append-system-prompt") prompts.push(fs.readFileSync(argv[i + 1], "utf-8"));
		});
		fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE + ".prompts", JSON.stringify(prompts));
	}
}
const message = (content, stopReason = "stop") =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "fake",
			model: "fake-model",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
			stopReason,
			timestamp: 0,
		},
	});

const toolResult = (toolCallId, { details = {}, isError = false, text = "Structured result recorded." } = {}) =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "toolResult", toolCallId, toolName: "emit_result",
			content: [{ type: "text", text }], details, isError, timestamp: 0,
		},
	});

switch (mode) {
	case "ok":
		console.log(message([{ type: "text", text: "FAKE_PI_OK" }]));
		process.exit(0);
	case "depth":
		console.log(message([{ type: "text", text: String(process.env.PI_WORKFLOW_DEPTH) }]));
		process.exit(0);
	case "structured":
		console.log(
			message(
				[{ type: "toolCall", id: "t1", name: "emit_result", arguments: { answer: 5 } }],
				"toolUse",
			),
		);
		console.log(toolResult("t1", { details: { answer: 5 } }));
		process.exit(0);
	case "coerced":
		console.log(
			message(
				[{ type: "toolCall", id: "t1", name: "emit_result", arguments: { answer: "5" } }],
				"toolUse",
			),
		);
		console.log(toolResult("t1", { details: { answer: 5 } }));
		process.exit(0);
	case "rejected":
		console.log(message([{ type: "toolCall", id: "t1", name: "emit_result", arguments: {} }], "toolUse"));
		console.log(toolResult("t1", {
			isError: true,
			text: 'Validation failed for tool "emit_result":\\n  - answer: missing\\n\\nReceived arguments:\\n{}',
		}));
		console.log(message([{ type: "text", text: "Unable to emit the result." }]));
		process.exit(0);
	case "malformed":
		console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message: malformedArgumentsMessage }))});
		console.log(toolResult("malformed-1", {
			isError: true,
			text: 'Invalid arguments for tool "emit_result": Invalid JSON in final tool arguments',
		}));
		console.log(message([{ type: "text", text: "Unable to emit the result." }]));
		process.exit(0);
	case "truncated":
		console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message: truncatedMessage }))});
		console.error("Warning: response was cut off at the model's output token limit.");
		process.exit(1);
	case "fail":
		console.error("boom");
		process.exit(3);
	case "sleep":
		setTimeout(() => {}, 30000);
		break;
	case "slow":
		setTimeout(() => {
			console.log(message([{ type: "text", text: "FAKE_PI_OK" }]));
			process.exit(0);
		}, 150);
		break;
	case "selfkill":
		console.log(message([{ type: "text", text: "PARTIAL_OUTPUT" }]));
		process.kill(process.pid, "SIGKILL");
		break;
	default:
		console.error("unknown FAKE_PI_MODE: " + mode);
		process.exit(2);
}
`;

export interface FakePi {
	dir: string;
	cleanup(): void;
}

/** Create the stub and prepend its dir to PATH. Returns a cleanup that restores PATH. */
export function installFakePi(): FakePi {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
	const stubPath = path.join(dir, "pi");
	fs.writeFileSync(stubPath, STUB_SOURCE, { encoding: "utf-8", mode: 0o755 });

	const originalPath = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;

	return {
		dir,
		cleanup() {
			process.env.PATH = originalPath;
			delete process.env.FAKE_PI_MODE;
			delete process.env.FAKE_PI_ARGS_FILE;
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
