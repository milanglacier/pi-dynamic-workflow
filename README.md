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

| Parameter        | Type             | Description                                                                |
| ---------------- | ---------------- | -------------------------------------------------------------------------- |
| `name`           | `string`         | Short kebab-case workflow name                                             |
| `description`    | `string`         | One-sentence description                                                   |
| `phases`         | `string[]?`      | Optional ordered phase titles (documentation of the plan)                  |
| `script`         | `string`         | Plain async JS body (top-level `await` / `return` allowed)                 |
| `args`           | `any?`           | JSON value exposed to the script as `args`                                 |
| `maxConcurrency` | `number?`        | Cap on concurrent subagents (default `max(2, min(8, cpus - 2))`)           |

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
// cwd (working dir relative to the session), schema (JSON Schema).

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
return { summary: inputs.length };        // return value becomes the tool result
```

## Design rules

1. **Pipeline by default.** Only add a barrier (sequential `parallel` batches) when a stage genuinely needs to see all items at once (e.g. cross-file dedup, global ranking). Independent per-item work should flow through `pipeline` so fast items don't wait for slow ones.
2. **Null-filter religiously.** `agent()`, `parallel()`, and `pipeline()` all yield `null` for failures. `.filter(Boolean)` before joining or aggregating.
3. **Keep prompts self-contained.** Subagents share nothing with you or each other. Include file paths, acceptance criteria, and output format in every prompt. Tell agents to be concise — their final message is the return value.
4. **Use `schema` when you need machine-readable output** (counts, verdicts, lists). Plain text is fine for prose to be aggregated by another agent.
5. **Scale to what the user asked for.** A two-step task needs two agents, not a judge panel. Reserve heavy patterns for tasks that demand rigor.
6. **Concurrency is capped** (default `max(2, min(8, cpus - 2))`); you may launch many agents and let the scheduler queue them. Set `maxConcurrency` lower for heavy tasks.
7. **Restrict tools** for read-only analysis agents (`tools: ["read","grep","find","ls"]`) so they cannot mutate the repo.

### Quality patterns (use when rigor matters)

- **Adversarial verify:** producer agent creates, verifier agent (different prompt, fresh context) checks against explicit criteria; loop or fix on failure.
- **Loop until clean:** `while` a checker agent reports issues (bounded iterations, e.g. 3), run a fixer agent on the report.
- **Judge panel:** N agents answer independently, one judge agent compares and synthesizes — good for ambiguous questions.
- **Multi-angle sweep:** fan out agents with different lenses (correctness, security, performance) over the same target, then merge.

## Safety

The script is the session LLM's, not untrusted user input. The `node:vm` sandbox provides isolation hygiene, not a security boundary — treat it as an execution context for code the same model wrote, not a jail.

To prevent the obvious failure mode (a script that spawns subagents that spawn workflows that spawn…), nested subagent depth is capped at 3.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test "test/*.test.ts"
```

Tests use zero deps — `node --test` with native TypeScript type stripping, and route all subprocess spawning through a fake `pi` stub so they never invoke the real binary.

## License

[MIT](LICENSE).
