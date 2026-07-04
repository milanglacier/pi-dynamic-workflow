/**
 * Workflow authoring guide injected by the /workflow command, plus the
 * condensed description used on the `workflow` tool itself.
 */

export const WORKFLOW_TOOL_DESCRIPTION = [
	"Execute a deterministic multi-agent workflow you author as a JavaScript script body.",
	"The script runs in a sandbox with these hooks in scope:",
	"agent(prompt, {label?, phase?, model?, tools?, cwd?, schema?}) spawns an isolated pi subagent and resolves to its final text (or a structured object matching `schema`, a JSON Schema); resolves to null on failure.",
	"parallel([...thunks]) runs thunks concurrently; failed thunks become null (never rejects).",
	"pipeline(items, ...stages) flows each item through the stages independently with no cross-item barrier; a throwing stage drops that item to null.",
	"phase(title) groups subsequent agent() calls under a phase; log(msg) records progress; args is the tool's `args` parameter.",
	"Top-level await and return are allowed; the script's return value becomes the tool result.",
	"Prefer pipeline over staged parallel batches unless a stage truly needs cross-item context. Filter nulls before aggregation.",
].join(" ");

export const WORKFLOW_GUIDE = `# Dynamic Workflow Brief

You have access to a \`workflow\` tool that executes a JavaScript orchestration script you write. Each \`agent()\` call spawns a fully isolated pi subagent (own context window, subprocess). Use it to decompose the user's task into deterministic multi-agent control flow.

## Tool parameters

- \`name\`: short workflow name (kebab-case)
- \`description\`: one sentence describing what it does
- \`phases\`: optional list of phase titles (documentation of the plan)
- \`script\`: plain async JavaScript body (NOT a function declaration; top-level \`await\` and \`return\` work)
- \`args\`: optional JSON value available to the script as \`args\`
- \`maxConcurrency\`: optional cap on concurrent subagents

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
// cwd (working dir), schema (JSON Schema for structured output).

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
return { summary: inputs.length };  // return value becomes the tool result
\`\`\`

## Design rules

1. **Pipeline by default.** Only add a barrier (sequential \`parallel\` batches) when a stage genuinely needs to see all items at once (e.g. cross-file dedup, global ranking). Independent per-item work should flow through \`pipeline\` so fast items don't wait for slow ones.
2. **Null-filter religiously.** \`agent()\`, \`parallel()\`, and \`pipeline()\` all yield \`null\` for failures. \`.filter(Boolean)\` before joining or aggregating.
3. **Keep prompts self-contained.** Subagents share nothing with you or each other. Include file paths, acceptance criteria, and output format in every prompt. Tell agents to be concise; their final message is the return value.
4. **Use \`schema\` when you need machine-readable output** (counts, verdicts, lists). Plain text is fine for prose to be aggregated by another agent.
5. **Scale to what the user asked for.** A two-step task needs two agents, not a judge panel. Reserve heavy patterns for tasks that demand rigor.
6. **Concurrency is capped** (default min(8, cpus-2)); you may launch many agents and let the scheduler queue them. Set \`maxConcurrency\` lower for heavy tasks.
7. **Restrict tools** for read-only analysis agents (\`tools: ["read","grep","find","ls"]\`) so they cannot mutate the repo.

## Quality patterns (use when rigor matters)

- **Adversarial verify:** producer agent creates, verifier agent (different prompt, fresh context) checks against explicit criteria; loop or fix on failure.
- **Loop until clean:** \`while\` a checker agent reports issues (bounded iterations, e.g. 3), run a fixer agent on the report.
- **Judge panel:** N agents answer independently, one judge agent compares and synthesizes; good for ambiguous questions.
- **Multi-angle sweep:** fan out agents with different lenses (correctness, security, performance) over the same target, then merge.

Now author the workflow for the task below and call the \`workflow\` tool with it. Briefly state your phase plan first, then invoke the tool.`;
