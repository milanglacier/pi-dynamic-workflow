import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { discoverAgentTypes } from "../src/agents.ts";

let root: string;
let agentDir: string;
let projectDir: string;
let originalAgentDir: string | undefined;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-profile-controls-"));
	agentDir = path.join(root, "agent");
	projectDir = path.join(root, "project");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

function withProfile(fields: string, check: () => void): void {
	const file = path.join(projectDir, ".pi", "agents", "reviewer.md");
	fs.writeFileSync(file, `---\nname: reviewer\ndescription: reviews code\n${fields}\n---\nBe strict.\n`);
	try {
		check();
	} finally {
		fs.rmSync(file);
	}
}

test("profiles parse comma-separated exclusions and YAML booleans", () => {
	withProfile("excludeTools: write, mcp__github__delete_*\nnoMcp: true", () => {
		const profile = discoverAgentTypes(projectDir).get("reviewer");
		assert.deepStrictEqual(profile?.excludeTools, ["write", "mcp__github__delete_*"]);
		assert.strictEqual(profile?.noMcp, true);
	});
	withProfile('excludeTools: ""\nnoMcp: false', () => {
		const profile = discoverAgentTypes(projectDir).get("reviewer");
		assert.deepStrictEqual(profile?.excludeTools, []);
		assert.strictEqual(profile?.noMcp, false);
	});
});

test("profiles preserve omitted controls", () => {
	withProfile("tools: read, grep", () => {
		const profile = discoverAgentTypes(projectDir).get("reviewer");
		assert.strictEqual(profile?.excludeTools, undefined);
		assert.strictEqual(profile?.noMcp, undefined);
	});
});

test("invalid profile controls report the file and field", () => {
	for (const fields of ['noMcp: "false"', "noMcp: 1", "noMcp: null"]) {
		withProfile(fields, () => {
			assert.throws(() => discoverAgentTypes(projectDir), /reviewer\.md.*noMcp must be a boolean/);
		});
	}
	for (const fields of ["excludeTools: [write]", "excludeTools: false", "excludeTools: null"]) {
		withProfile(fields, () => {
			assert.throws(() => discoverAgentTypes(projectDir), /reviewer\.md.*excludeTools must be a comma-separated string/);
		});
	}
});

test("project profiles replace user profiles rather than merging their controls", () => {
	const userFile = path.join(agentDir, "agents", "reviewer.md");
	fs.writeFileSync(userFile, "---\nname: reviewer\ndescription: global reviewer\nexcludeTools: write\nnoMcp: true\n---\nBe strict.");
	try {
		withProfile("tools: read", () => {
			const profile = discoverAgentTypes(projectDir).get("reviewer");
			assert.strictEqual(profile?.source, "project");
			assert.strictEqual(profile?.excludeTools, undefined);
			assert.strictEqual(profile?.noMcp, undefined);
		});
	} finally {
		fs.rmSync(userFile);
	}
});
