/**
 * Fake `pi` stub for tests (per CLAUDE.md: never spawn real pi from tests).
 *
 * Creates a temp dir containing an executable `pi` Node script that emits a
 * canned JSON event stream. Behavior is selected via the FAKE_PI_MODE env var:
 *   ok         - one assistant message with text "FAKE_PI_OK", exit 0
 *   depth      - assistant text is the child's PI_WORKFLOW_DEPTH value
 *   structured - assistant message with an emit_result toolCall {answer: 5}
 *   fail       - writes "boom" to stderr, exit 3
 *   sleep      - hangs for 30s (for abort tests; SIGTERM kills it)
 *   slow       - waits 150ms, then behaves like "ok" (for concurrency tests)
 *
 * If FAKE_PI_ARGS_FILE is set, the stub writes its argv (JSON array) to that
 * path before doing anything else, so tests can assert on the CLI invocation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STUB_SOURCE = `#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE || "ok";
if (process.env.FAKE_PI_ARGS_FILE) {
	require("node:fs").writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
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
		process.exit(0);
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
