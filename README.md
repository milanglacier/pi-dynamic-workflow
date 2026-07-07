# pi-dynamic-workflow

A [pi](https://github.com/badlogic/pi-mono) extension that lets the LLM author a JavaScript orchestration script and fan it out into isolated `pi` subagent subprocesses.

> `/workflow <task>` — author a multi-agent workflow on the fly and run it.

The session LLM receives an authoring brief, writes a small async JS body that calls `agent(...)` to spawn fully-isolated subagents (each with its own context window, in its own subprocess), and composes them with `parallel()` / `pipeline()`. Subagent failures become `null` rather than rejecting the batch, so scripts can `.filter(Boolean)` and keep going. The script's return value becomes the tool's result.

## Install

The package is not on npm yet. Install from the GitHub repository:

```bash
pi install git:github.com/milanglacier/pi-dynamic-workflow
```

For local development, drop the path into your `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/path/to/pi-dynamic-workflow"]
}
```

## Usage

### `/workflow` command

```
/workflow review the auth module for security issues across 3 lenses
```

This injects a brief into the next turn. The LLM plans phases, calls the `workflow` tool with a `script` parameter, and the orchestration runs.

### The `workflow` tool

| Parameter         | Type        | Description                                                                     |
| ----------------- | ----------- | ------------------------------------------------------------------------------- |
| `name`            | `string`    | Short kebab-case workflow name                                                  |
| `description`     | `string`    | One-sentence description                                                        |
| `phases`          | `string[]?` | Optional ordered phase titles (documentation of the plan)                       |
| `script`          | `string?`   | Plain async JS body (top-level `await` / `return` allowed)                      |
| `workflowName`    | `string?`   | Run a saved workflow by name instead of an inline script                        |
| `scriptPath`      | `string?`   | Run a workflow script from a `.js` file (relative to the session cwd)           |
| `args`            | `any?`      | JSON value exposed to the script as `args`                                      |
| `maxConcurrency`  | `number?`   | Cap on concurrent subagents (default `max(2, min(8, cpus - 2))`)                |
| `maxAgents`       | `number?`   | Cap on total `agent()` calls per run (default and hard max 200)                 |
| `maxCost`         | `number?`   | Budget in USD; once spent, further `agent()` calls throw (soft cap)             |
| `maxTokens`       | `number?`   | Budget in tokens (input+output); same enforcement as `maxCost`                  |
| `resumeFromRunId` | `string?`   | Replay a prior run's journal; unchanged `agent()` calls return cached results   |
| `background`      | `boolean?`  | Return immediately; a `workflow-complete` message arrives when the run finishes |

Provide exactly one of `script`, `workflowName`, or `scriptPath`.

### Script API

```js
// Spawn an isolated subagent. Resolves to its final text, or null on failure.
const text = await agent("Summarize src/foo.ts", { label: "summarize-foo" });

// Structured output: pass a JSON Schema; resolves to a matching object (or null).
const info = await agent("Count the exported functions in src/foo.ts", {
  label: "count-foo",
  schema: {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  },
});

// Per-agent options: label, phase, model, tools (e.g. ["read","grep"]),
// cwd (working dir relative to the session), schema (JSON Schema),
// timeout (ms; kills the subagent and resolves null), systemPrompt,
// appendSystemPrompt, and agentType — a saved agent definition from
// ~/.pi/agent/agents/*.md or <project>/.pi/agents/*.md (frontmatter
// name/description/tools/model; body = system prompt).
const verdict = await agent("Review src/auth.ts", { agentType: "security-reviewer", timeout: 120000 });

// Run thunks concurrently. Failures become null; the batch never rejects.
const results = await parallel(files.map(f => () => agent(`Review ${f}`, { label: f })));

// Per-item pipeline: each item flows through all stages independently
// (no cross-item barrier). A throwing stage drops that item to null.
const fixed = await pipeline(files,
  (_, f) => agent(`Find bugs in ${f}`, { label: `scan ${f}`, phase: "scan" }),
  (bugs, f) => bugs?.includes("BUG")
    ? agent(`Fix these bugs in ${f}: ${bugs}`, { phase: "fix" })
    : bugs,
);

phase("aggregate");                       // set the default phase for subsequent agent() calls
log("merging results");                   // progress note shown in the TUI
const inputs = fixed.filter(Boolean);     // always drop nulls before aggregating

// budget reflects the tool's maxCost/maxTokens caps.
if (budget.exceeded()) return { partial: inputs.length };

// Compose a saved workflow inline (one nesting level; shares this run's
// concurrency, abort, budget, and agent accounting).
const sub = await workflow("review-sweep", { target: "src/auth" });

return { summary: inputs.length };        // return value becomes the tool result
```

Scripts must be deterministic so runs can resume: `Date.now()`, `Math.random()`, and
zero-arg `new Date()` throw in the sandbox — pass timestamps or seeds in via `args`.

### Saved workflows

Drop reusable scripts in `~/.pi/agent/workflows/*.js` (user) or `<project>/.pi/workflows/*.js`
(project; overrides user on name collision). The file name is the workflow name; a leading
`//` comment is its description, shown in the `/workflow` brief. Run them via the
`workflowName` tool parameter or compose them from a script with `workflow(name, args)`.

### Resume

Every run writes a journal to `~/.pi/agent/pi-dynamic-workflow/runs/<runId>.json`
(successful agent calls only, keyed by a hash of prompt + behavioral options; the 50
newest runs are kept). Re-invoking the tool with `resumeFromRunId` replays matching
calls from cache — shown with a `↺` icon, free of budget — and only runs what changed.

### Background runs

`background: true` makes the tool return immediately with the run id; the run continues
detached and injects a `workflow-complete` message (triggering a turn) when it finishes.
Stop one early with `/workflow-stop <runId>` (no argument lists active runs). Background
runs die with the pi process, but their journal makes them resumable.

## Design rules

1. **Pipeline by default.** Only add a barrier (sequential `parallel` batches) when a stage genuinely needs to see all items at once (e.g. cross-file dedup, global ranking). Independent per-item work should flow through `pipeline` so fast items don't wait for slow ones.
2. **Null-filter religiously.** `agent()`, `parallel()`, and `pipeline()` all yield `null` for failures. `.filter(Boolean)` before joining or aggregating.
3. **Keep prompts self-contained.** Subagents share nothing with you or each other. Include file paths, acceptance criteria, and output format in every prompt. Tell agents to be concise — their final message is the return value.
4. **Use `schema` when you need machine-readable output** (counts, verdicts, lists). Plain text is fine for prose to be aggregated by another agent.
5. **Scale to what the user asked for.** A two-step task needs two agents, not a judge panel. Reserve heavy patterns for tasks that demand rigor.
6. **Concurrency is capped** (default `max(2, min(8, cpus - 2))`); you may launch many agents and let the scheduler queue them. Set `maxConcurrency` lower for heavy tasks.
7. **Restrict tools** for read-only analysis agents (`tools: ["read","grep","find","ls"]`) so they cannot mutate the repo.
8. **Set `timeout` on agents that could wander** and `maxCost`/`maxTokens` on expensive fan-outs; a timed-out agent resolves to null like any other failure.
9. **Use `background: true` for long runs** the user shouldn't wait on; report the run id so it can be stopped (`/workflow-stop`) or resumed later.

### Quality patterns (use when rigor matters)

- **Adversarial verify:** producer agent creates, verifier agent (different prompt, fresh context) checks against explicit criteria; loop or fix on failure.
- **Loop until clean:** `while` a checker agent reports issues (bounded iterations, e.g. 3), run a fixer agent on the report.
- **Judge panel:** N agents answer independently, one judge agent compares and synthesizes — good for ambiguous questions.
- **Multi-angle sweep:** fan out agents with different lenses (correctness, security, performance) over the same target, then merge.

## Safety

The script is the session LLM's, not untrusted user input. The `node:vm` sandbox provides isolation hygiene, not a security boundary — treat it as an execution context for code the same model wrote, not a jail.

To prevent the obvious failure mode (a script that spawns subagents that spawn workflows that spawn…), nested subagent depth is capped at 3, total `agent()` calls per run at 200, and in-script `workflow()` composition at one nesting level.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test "test/*.test.ts"
```

Tests use zero deps — `node --test` with native TypeScript type stripping, and route all subprocess spawning through a fake `pi` stub so they never invoke the real binary.

## License

[MIT](LICENSE).
