# pi-dynamic-workflow

A [pi](https://github.com/badlogic/pi-mono) extension that lets the LLM author a JavaScript orchestration script and fan it out into isolated `pi` subagent subprocesses.

> `/workflow <task>` — author a multi-agent workflow on the fly and run it.

The session LLM receives an authoring brief, writes a small async JS body that calls `agent(...)` to spawn fully-isolated subagents (each with its own context window, in its own subprocess), and composes them with `parallel()` / `pipeline()`. Subagent failures become `null` rather than rejecting the batch, so scripts can `.filter(Boolean)` and keep going. The script's return value becomes the tool's result.

## Install

Install from npm with pi's package manager:

```bash
pi install npm:pi-dynamic-workflow
```

Or install directly from the GitHub repository:

```bash
pi install git:github.com/milanglacier/pi-dynamic-workflow
```

For local development, drop the path into your `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/path/to/pi-dynamic-workflow"]
}
```

## User Guide

### When to reach for `/workflow`

`/workflow` shines when a task benefits from **independent parallel work** or **multi-stage pipelines with quality gates**. Good fits:

- **Auditing or reviewing** across multiple files, lenses, or criteria (security, correctness, style).
- **Batch transformations** where each file/item flows through the same pipeline (scan → fix → verify).
- **Research or comparison** that needs multiple perspectives synthesized by a judge.
- **Any task where you'd otherwise say** "do the same thing to each of these" or "check my work from a different angle."

Not every task needs an orchestra. A single-file edit or a straightforward question is better handled directly — the overhead of spawning subagents isn't worth it for a one-step job.

### Prompting the agent

The LLM decides what script to write and how to structure the workflow. You steer it with natural language in your `/workflow` prompt. Here are the levers you can pull:

#### Pick a quality pattern

Tell the agent which pattern to use by name:

```
/workflow review src/auth.ts using the adversarial verify pattern
/workflow audit the API layer — use a judge panel with 3 reviewers
/workflow scan the codebase for bugs — multi-angle sweep: correctness, security, and performance
```

The agent knows these patterns from its authoring brief. If you don't name one, it picks what fits the task. See the [Quality patterns](#quality-patterns) reference for what each one does.

#### Set a spending cap

```
/workflow audit every module — cap spending at $2
/workflow review the entire codebase with a budget of 50k tokens
```

This sets `maxCost` or `maxTokens` on the tool call. The script gets a `budget` object it can check — once exceeded, new `agent()` calls throw a `BudgetExceededError`. In-flight agents still finish, so you get partial results rather than nothing.

#### Control concurrency

```
/workflow review all 40 services — limit to 4 at a time
```

Sets `maxConcurrency`. Useful when you're hitting rate limits or don't want to saturate your machine. The default is `max(2, min(8, cpus - 2))`.

#### Run in the background

```
/workflow audit the entire monorepo — run this in the background
```

Sets `background: true`. The tool returns immediately and the workflow keeps running detached. A notification message arrives when it finishes (triggering a new turn). Stop it early with `/workflow-stop <runId>` (no argument lists active runs).

#### Use a custom agent type

If you've defined agent types (see [Configuring agent types](#configuring-agent-types)), ask the LLM to use them:

```
/workflow review the PR — use my security-reviewer and style-checker agent types
```

The LLM will set `agentType` on the relevant `agent()` calls. Each agent type brings its own system prompt, default model, and tool restrictions.

#### Restrict what subagents can do

```
/workflow audit the codebase — all subagents should be read-only
```

The LLM will set `tools: ["read", "grep", "find", "ls"]` on `agent()` calls so subagents can't modify files.

#### Resume a previous run

If a run crashed or you want to re-run with small changes, ask the agent to resume:

```
/workflow re-run my last audit but add a performance lens — resume from the previous run
```

Changed prompts re-run; unchanged ones replay from cache instantly (free, marked with ↺). See [Resume](#resume) for how this works under the hood.

#### Compose with saved workflows

```
/workflow pipeline: first run my review-sweep on src/, then aggregate the findings
```

If you have saved workflows (see [Creating saved workflows](#creating-saved-workflows)), the agent can compose them inline.

### Quick reference: all the knobs

| What you want                       | How to say it in a `/workflow` prompt                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Use a quality pattern               | `... using the judge panel pattern`                                         |
| Cap spending                        | `... with a $3 budget` or `... cap at 100k tokens`                          |
| Limit parallelism                   | `... limit to 4 concurrent agents`                                          |
| Run detached                        | `... in the background`                                                     |
| Use a custom agent type             | `... use my security-reviewer`                                              |
| Read-only subagents                 | `... all subagents should be read-only`                                     |
| Resume a prior run                  | `... resume from the previous run`                                          |
| Compose saved workflows             | `... first run my review-sweep, then aggregate`                             |
| Set per-agent timeout               | `... give each subagent at most 2 minutes`                                  |
| Structured output from subagents    | `... each subagent should return JSON with {severity, summary}`             |

### Configuring agent types

Agent types are reusable subagent profiles — like preset characters with their own system prompt, default model, and tool set. Define them as markdown files:

**Location:** `~/.pi/agent/agents/*.md` (global) or `<project>/.pi/agents/*.md` (per-project; overrides global on name collision).

**Format:** YAML frontmatter for metadata; the body is the system prompt.

```markdown
---
name: security-reviewer
description: Reviews code for security issues with an adversarial mindset
tools: read, grep, find, ls
model: sonnet
---
You are a security reviewer. For every file you examine:
1. Identify all trust boundaries (user input, network, filesystem, DB).
2. Trace data flow across each boundary.
3. Flag any missing validation, sanitization, or authorization.
4. Suggest concrete fixes with code examples.

Be concise. Your final message should be a bulleted list of findings
with severity (critical/high/medium/low) and a one-line recommendation.
```

**Frontmatter fields:**

| Field         | Required | Description                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------- |
| `name`        | Yes      | Identifier used in `agentType` (kebab-case recommended)                      |
| `description` | Yes      | Shown in the `/workflow` brief so the LLM knows when to reach for it         |
| `tools`       | No       | Comma-separated tool list (e.g. `read, grep, find`). Omit to grant all tools |
| `model`       | No       | Model override for this agent type (e.g. `haiku`, `sonnet`)                  |

Once defined, the LLM can use them via `agent("...", { agentType: "security-reviewer" })`. Changing an agent type's `.md` file invalidates cached results for runs that used it — so resume will re-run those calls live.

### Creating saved workflows

If you find yourself repeating the same orchestration pattern, save it as a reusable script:

**Location:** `~/.pi/agent/workflows/*.js` (global) or `<project>/.pi/workflows/*.js` (per-project; overrides global on name collision).

**Format:** A `.js` file whose name is the workflow name. The first line, if a `//` comment, is its description (shown in the `/workflow` brief). The body is the same async JS you'd write inline — `agent()`, `parallel()`, `pipeline()`, `args`, etc. are all in scope.

```js
// Scan every file in a directory for a specific issue and report findings
const files = await agent(
  `List every .ts file under ${args.dir || "src/"}. Output one path per line.`,
  { label: "list-files", tools: ["find"], schema: { type: "array", items: { type: "string" } } }
);
if (!files || files.length === 0) return { findings: [], message: "No files found" };

const results = await parallel(
  files.map(f => () =>
    agent(`Scan ${f} for ${args.issue || "hardcoded secrets"}. Report findings concisely.`,
      { label: `scan-${f}`, phase: "scan", tools: ["read", "grep"] }
    )
  )
);

const findings = results.filter(Boolean);
return { count: findings.length, findings };
```

**Usage:** Reference it from a prompt (`/workflow run my scan-sweep on src/auth`) or compose it inline from another script (`workflow("scan-sweep", { dir: "src/auth", issue: "SQL injection" })`).

## Reference

### `/workflow` command

```
/workflow review the auth module for security issues across 3 lenses
```

This injects the authoring brief into the next turn. The LLM plans phases, calls the `workflow` tool with a `script` parameter, and the orchestration runs.

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
| `maxCost`         | `number?`   | Budget in USD; once spent, further `agent()` calls throw a `BudgetExceededError` (soft cap) |
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

### Saved workflows (technical)

Saved workflows are discovered from `~/.pi/agent/workflows/*.js` (user) and `<project>/.pi/workflows/*.js` (project; overrides user on name collision). The file name (minus `.js`) is the workflow name; a leading `//` comment is its description. Run them via the `workflowName` tool parameter or compose them from a script with `workflow(name, args)`. See [Creating saved workflows](#creating-saved-workflows) for a step-by-step example.

### Resume

Every run writes an append-only journal to `~/.pi/agent/pi-dynamic-workflow/runs/<runId>.jsonl`
(successful agent calls only, keyed by a hash of prompt + behavioral options — including
the resolved `agentType` definition, so editing an agent `.md` invalidates its cached
calls; the 50 newest runs are kept). Re-invoking the tool with `resumeFromRunId` replays
matching calls from cache — shown with a `↺` icon, free of budget — and only runs what
changed.

### Background runs

`background: true` makes the tool return immediately with the run id; the run continues
detached and injects a `workflow-complete` message (triggering a turn) when it finishes.
Stop one early with `/workflow-stop <runId>` (no argument lists active runs). Background
runs die with the pi process, but their journal makes them resumable.

### Design rules

These are the rules the LLM follows when authoring workflow scripts. They're also a good mental model for understanding how workflows behave.

1. **Pipeline by default.** Only add a barrier (sequential `parallel` batches) when a stage genuinely needs to see all items at once (e.g. cross-file dedup, global ranking). Independent per-item work should flow through `pipeline` so fast items don't wait for slow ones.
2. **Null-filter religiously.** `agent()`, `parallel()`, and `pipeline()` all yield `null` for failures. `.filter(Boolean)` before joining or aggregating.
3. **Keep prompts self-contained.** Subagents share nothing with you or each other. Include file paths, acceptance criteria, and output format in every prompt. Tell agents to be concise — their final message is the return value.
4. **Use `schema` when you need machine-readable output** (counts, verdicts, lists). Plain text is fine for prose to be aggregated by another agent.
5. **Scale to what the user asked for.** A two-step task needs two agents, not a judge panel. Reserve heavy patterns for tasks that demand rigor.
6. **Concurrency is capped** (default `max(2, min(8, cpus - 2))`); you may launch many agents and let the scheduler queue them. Set `maxConcurrency` lower for heavy tasks.
7. **Restrict tools** for read-only analysis agents (`tools: ["read","grep","find","ls"]`) so they cannot mutate the repo.
8. **Set `timeout` on agents that could wander** and `maxCost`/`maxTokens` on expensive fan-outs; a timed-out agent resolves to null like any other failure.
9. **Use `background: true` for long runs** the user shouldn't wait on; report the run id so it can be stopped (`/workflow-stop`) or resumed later.

### Quality patterns

Patterns the LLM can use when a task demands rigor. Name them in your prompt to steer the agent (see [Prompting the agent](#prompting-the-agent)).

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
