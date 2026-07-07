/**
 * Workflow authoring guide injected by the /workflow command, plus the
 * condensed description used on the `workflow` tool itself.
 *
 * NOTE: README.md mirrors the Script API and Design rules sections below.
 * When editing either, keep the other in sync.
 */

export const WORKFLOW_TOOL_DESCRIPTION = [
	"Execute a deterministic multi-agent workflow you author as a JavaScript script body.",
	"The script runs in a sandbox with these hooks in scope:",
	"agent(prompt, {label?, phase?, model?, tools?, cwd?, schema?, timeout?, systemPrompt?, appendSystemPrompt?, agentType?}) spawns an isolated pi subagent and resolves to its final text (or a structured object matching `schema`, a JSON Schema); resolves to null on failure or timeout. agentType names a saved agent definition (.pi/agents/*.md).",
	"parallel([...thunks]) runs thunks concurrently; failed thunks become null (never rejects).",
	"pipeline(items, ...stages) flows each item through the stages independently with no cross-item barrier; a throwing stage drops that item to null.",
	"phase(title) groups subsequent agent() calls under a phase; log(msg) records progress; args is the tool's `args` parameter.",
	"budget ({maxCost, maxTokens, spentCost(), spentTokens(), remainingCost(), remainingTokens(), exceeded()}) reflects the maxCost/maxTokens caps; once exceeded, agent() throws.",
	"workflow(nameOrPath, args) runs a saved workflow inline (one nesting level).",
	"Top-level await and return are allowed; the script's return value becomes the tool result.",
	"Scripts must be deterministic: Date.now(), Math.random(), and zero-arg new Date() throw — pass timestamps/seeds via args. Every run is journaled under a run id; pass resumeFromRunId to replay unchanged agent() calls from cache. Set background: true to return immediately and get a workflow-complete message when done.",
	"Instead of `script`, you may pass workflowName (a saved workflow) or scriptPath (a .js file).",
	"Prefer pipeline over staged parallel batches unless a stage truly needs cross-item context. Filter nulls before aggregation.",
].join(" ");

export const WORKFLOW_GUIDE = `# Dynamic Workflow Brief

You have access to a \`workflow\` tool that executes a JavaScript orchestration script you write. Each \`agent()\` call spawns a fully isolated pi subagent (own context window, subprocess). Use it to decompose the user's task into deterministic multi-agent control flow.

## Tool parameters

- \`name\`: short workflow name (kebab-case)
- \`description\`: one sentence describing what it does
- \`phases\`: optional list of phase titles (documentation of the plan)
- \`script\`: plain async JavaScript body (NOT a function declaration; top-level \`await\` and \`return\` work)
- \`workflowName\` / \`scriptPath\`: run a saved workflow (from \`~/.pi/agent/workflows/\` or \`<project>/.pi/workflows/\`) or a \`.js\` file instead of an inline script (provide exactly one of the three)
- \`args\`: optional JSON value available to the script as \`args\`
- \`maxConcurrency\`: optional cap on concurrent subagents
- \`maxAgents\`: optional cap on total \`agent()\` calls (default 200)
- \`maxCost\` / \`maxTokens\`: optional budget; once total subagent spend reaches it, further \`agent()\` calls throw (in-flight agents finish — a soft cap)
- \`resumeFromRunId\`: replay a prior run's journal — \`agent()\` calls whose prompt+options match return the recorded result instantly; new or changed calls run live. Every result reports its run id.
- \`background\`: return immediately and run detached; a \`workflow-complete\` message arrives when the run finishes (stop early with \`/workflow-stop <runId>\`)

## Script API

\`\`\`js
// Spawn an isolated subagent. Resolves to its final text, or null on failure.
const text = await agent("Summarize src/foo.ts", { label: "summarize-foo" });

// Structured output: pass a JSON Schema; resolves to a matching object (or null).
const info = await agent("Count the exported functions in src/foo.ts", {
  label: "count-foo",
  schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
});

// Options: label (display name), phase (group), model, tools (e.g. ["read","grep"]),
// cwd (working dir), schema (JSON Schema for structured output), timeout (ms; kills
// the subagent and resolves null), systemPrompt / appendSystemPrompt, and agentType
// (a saved agent definition from ~/.pi/agent/agents/*.md or <project>/.pi/agents/*.md
// supplying its system prompt plus default tools/model).
const verdict = await agent("Review src/auth.ts for injection bugs", {
  agentType: "security-reviewer",
  timeout: 120000,
});

// Run thunks concurrently. Failures become null; the batch never rejects.
const results = await parallel(files.map(f => () => agent(\`Review \${f}\`, { label: f })));

// Per-item pipeline: each item flows through all stages independently (no barrier).
// Stage signature: (prevResult, originalItem, index). A throwing stage drops the item to null.
const fixed = await pipeline(files,
  (_, f) => agent(\`Find bugs in \${f}\`, { label: \`scan \${f}\`, phase: "scan" }),
  (bugs, f) => bugs && bugs.includes("BUG") ? agent(\`Fix these bugs in \${f}: \${bugs}\`, { phase: "fix" }) : bugs,
);

phase("aggregate");                 // set the default phase for subsequent agent() calls
log("merging results");             // progress note shown in the TUI
const inputs = fixed.filter(Boolean); // always drop nulls before aggregating

// Budget-aware loop: budget reflects the tool's maxCost/maxTokens caps.
while (budget.maxCost !== null && budget.remainingCost() > 0.05 && inputs.length < 10) {
  const more = await agent("Find one more edge case in src/", { tools: ["read","grep"] });
  if (more) inputs.push(more);
}

// Compose a saved workflow inline (one nesting level; shares this run's
// concurrency, abort, budget, and agent accounting).
const subResult = await workflow("review-sweep", { target: "src/auth" });

return { summary: inputs.length };  // return value becomes the tool result
\`\`\`

Scripts must be deterministic so runs can resume: \`Date.now()\`, \`Math.random()\`, and
zero-arg \`new Date()\` throw in the sandbox — pass timestamps or seeds in via \`args\`.
Every run is journaled; re-invoking the tool with \`resumeFromRunId\` set to a prior
run id replays unchanged \`agent()\` calls from cache and only re-runs what changed.

## Design rules

1. **Pipeline by default.** Only add a barrier (sequential \`parallel\` batches) when a stage genuinely needs to see all items at once (e.g. cross-file dedup, global ranking). Independent per-item work should flow through \`pipeline\` so fast items don't wait for slow ones.
2. **Null-filter religiously.** \`agent()\`, \`parallel()\`, and \`pipeline()\` all yield \`null\` for failures. \`.filter(Boolean)\` before joining or aggregating.
3. **Keep prompts self-contained.** Subagents share nothing with you or each other. Include file paths, acceptance criteria, and output format in every prompt. Tell agents to be concise; their final message is the return value.
4. **Use \`schema\` when you need machine-readable output** (counts, verdicts, lists). Plain text is fine for prose to be aggregated by another agent.
5. **Scale to what the user asked for.** A two-step task needs two agents, not a judge panel. Reserve heavy patterns for tasks that demand rigor.
6. **Concurrency is capped** (default max(2, min(8, cpus-2))); you may launch many agents and let the scheduler queue them. Set \`maxConcurrency\` lower for heavy tasks.
7. **Restrict tools** for read-only analysis agents (\`tools: ["read","grep","find","ls"]\`) so they cannot mutate the repo.
8. **Set \`timeout\` on agents that could wander** and \`maxCost\`/\`maxTokens\` on expensive fan-outs; a timed-out agent resolves to null like any other failure.
9. **Use \`background: true\` for long runs** the user shouldn't wait on; report the run id so it can be stopped (\`/workflow-stop\`) or resumed later.

## Quality patterns (use when rigor matters)

- **Adversarial verify:** producer agent creates, verifier agent (different prompt, fresh context) checks against explicit criteria; loop or fix on failure.
- **Loop until clean:** \`while\` a checker agent reports issues (bounded iterations, e.g. 3), run a fixer agent on the report.
- **Judge panel:** N agents answer independently, one judge agent compares and synthesizes; good for ambiguous questions.
- **Multi-angle sweep:** fan out agents with different lenses (correctness, security, performance) over the same target, then merge.

Now author the workflow for the task below and call the \`workflow\` tool with it. Briefly state your phase plan first, then invoke the tool.`;
