# pi Dynamic Workflow Extension

## Context

Build a pi extension (in this repo, `pi-dynamic-workflow`) that replicates Claude Code's "dynamic workflow" capability for pi: the LLM authors a JavaScript orchestration script on demand, and the extension executes it, fanning out isolated pi subagent sessions with deterministic control flow (`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`).

Two user-facing surfaces:
1. A **`workflow` custom tool** the LLM calls with `{ name, description, phases?, script, args? }` — the extension runs the script in a `node:vm` sandbox; each `agent()` call spawns `pi --mode json -p --no-session` as a subprocess (the pattern from pi's official `examples/extensions/subagent/index.ts`).
2. A **`/workflow <task>` command** that injects a workflow-authoring guide plus the user's task as a message and triggers a turn, so the LLM generates the script and invokes the tool.

**Opt-in tool registration:** the `workflow` tool is NOT registered at extension load. It is registered lazily, the first time the user runs `/workflow` (pi supports post-startup `pi.registerTool()` from command handlers — tools refresh immediately without `/reload`; see `docs/extensions.md` "registerTool works both during extension load and after startup" and the `dynamic-tools.ts` example). Sessions that never invoke `/workflow` never carry the tool in their system prompt.

Decisions confirmed with the user:
- Subagents run as **subprocesses** (`pi --mode json -p --no-session`), not in-process SDK sessions.
- Script format is a **plain async JS body**; metadata (`name`, `description`, `phases`) are separate tool parameters — no `export const meta` parsing.
- Scope is **core + schema**: `agent(prompt, {label, phase, model, tools, cwd, schema})` with structured output enforced via a temporary generated extension injected into the subagent with `-e`. No budget tracking, no resume, no nested `workflow()` in v1.
- Standard strict TypeScript project; pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `typebox`) as `peerDependencies` with `"*"` range (per `docs/packages.md` guidance), real types only, targeting latest (0.80.x), no backward compat.

Key references (read during exploration):
- `~/.local/share/pi/docs/extensions.md` — `ExtensionAPI`, `registerTool`, `registerCommand`, truncation utilities, rendering, mode behavior.
- `~/.local/share/pi/examples/extensions/subagent/index.ts` — subprocess spawn/JSON-event parsing, usage aggregation, abort handling, concurrency pool, TUI rendering. Reuse its patterns heavily.
- `~/.local/share/pi/examples/extensions/structured-output.ts` — terminating structured-output tool pattern (`terminate: true`).
- `~/.local/share/pi/docs/packages.md` — peer-dependency rule and `pi.extensions` manifest.

## Project Layout

```
pi-dynamic-workflow/
├── package.json
├── tsconfig.json
├── .gitignore            (exists)
├── refereces/            (exists, leave as is)
└── src/
    ├── index.ts          # extension entry: default factory → registers tool + command
    ├── guide.ts          # workflow-authoring guide (string constant) + tool description text
    ├── tool.ts           # `workflow` tool definition (params schema, execute orchestration)
    ├── sandbox.ts        # node:vm script evaluation with injected hooks
    ├── scheduler.ts      # semaphore pool, parallel(), pipeline()
    ├── subagent.ts       # spawn pi subprocess, parse JSON events, abort, usage stats
    ├── structured.ts     # temp-extension codegen for schema-enforced output
    ├── render.ts         # renderCall / renderResult TUI components
    └── types.ts          # WorkflowDetails, AgentRecord, ScriptHooks, etc.
```

## Implementation

### 1. `package.json` + `tsconfig.json`

- `package.json`: `"type": "module"`, `keywords: ["pi-package"]`, manifest `"pi": { "extensions": ["./src/index.ts"] }`.
  - `peerDependencies` (all `"*"`): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `typebox`.
  - `devDependencies`: `typescript`, `@types/node`. (npm ≥7 auto-installs peer deps, so real `.d.ts` types come from the actual packages — no stub typings anywhere.)
  - `scripts`: `"typecheck": "tsc --noEmit"`.
- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`, `module: "esnext"`, `moduleResolution: "bundler"`, `allowImportingTsExtensions: true` (pi loads extensions via jiti directly from source; there is no build step), `target: "es2023"`, `skipLibCheck: true`, `types: ["node"]`.

### 2. `src/subagent.ts` — one pi subagent run

Adapt `runSingleAgent` from the subagent example:
- `runSubagent({ prompt, model?, tools?, cwd, schema?, signal, onEvent }): Promise<SubagentResult>`.
- Spawn `pi --mode json -p --no-session [--model m] [--tools a,b] [-e <tempStructuredExt>] <prompt>` using the example's `getPiInvocation()` logic (resolve `process.argv[1]` / `process.execPath`, fall back to `pi` on PATH).
- Parse newline-delimited JSON from stdout: on `message_end` collect assistant messages, accumulate usage (`input/output/cacheRead/cacheWrite/cost/turns`), capture `stopReason`/`errorMessage`; on `tool_execution_start`-style events emit progress via `onEvent` so the parent tool can stream `onUpdate`.
- Abort: on `signal` abort, SIGTERM then SIGKILL after 5 s (copy the example's handling).
- Result: `{ ok, outputText, structured?, usage, model, stopReason, errorMessage, exitCode }` where `outputText` is the last assistant text and `structured` is the parsed `emit_result` tool-call arguments when a schema was supplied (scan assistant messages for the last `toolCall` content part named `emit_result`).

### 3. `src/structured.ts` — schema enforcement

- `createStructuredOutputExtension(schema: object): Promise<{ path, cleanup }>`:
  - Write a temp `.ts` file (in `os.tmpdir()`, mode 0600) that registers an `emit_result` tool whose `parameters` is `Type.Unsafe(<embedded schema JSON>)` and returns `terminate: true` (mirrors `structured-output.ts` example). Include `promptGuidelines` instructing the model to call `emit_result` exactly once with the final answer and stop.
  - pi's own tool-argument validation forces the subagent model to match the schema (it retries on validation errors), so the parent only needs to extract the arguments.
- If the subagent finished without calling `emit_result`, treat the run as failed (agent() → `null`, error recorded in details).

### 4. `src/scheduler.ts` — concurrency + combinators

- `Semaphore` capping concurrent subprocesses at `min(8, os.cpus().length - 2)` (floor 2). The cap lives inside `agent()` so direct calls, `parallel()`, and `pipeline()` all share it.
- `parallel(thunks)`: run all thunks; a thrown/rejected thunk resolves to `null` (never rejects the batch) — matches Claude Code semantics so scripts can `.filter(Boolean)`.
- `pipeline(items, ...stages)`: each item flows through all stages independently with no barrier; stage callbacks receive `(prevResult, originalItem, index)`; a throwing stage drops the item to `null` and skips its remaining stages.

### 5. `src/sandbox.ts` — script evaluation

- `runWorkflowScript(source, hooks): Promise<unknown>`:
  - `vm.createContext({ agent, parallel, pipeline, phase, log, args, console: sandboxConsole })` (fresh V8 context already provides `JSON`, `Math`, `Promise`, etc.).
  - Wrap the body: `new vm.Script("(async () => {\n" + source + "\n})()")` so top-level `await`/`return` work; await the resulting promise outside the vm.
  - Syntax errors and runtime throws are caught and surfaced as a tool error (throw from `execute` with the message + stack line).
  - `phase(title)` sets a mutable current-phase string used as the default group for subsequent `agent()` calls; `log(msg)` appends to the run's log list and triggers an `onUpdate`.

### 6. `src/tool.ts` — the `workflow` tool

- `pi.registerTool` with typebox parameters:
  - `name: Type.String()`, `description: Type.String()`, `phases: Type.Optional(Type.Array(Type.String()))`, `script: Type.String()` (plain async JS body), `args: Type.Optional(Type.Any())`, `maxConcurrency: Type.Optional(Type.Number())`.
- `description`/`promptSnippet`/`promptGuidelines`: condensed API reference for script authors (hook signatures, pipeline-by-default guidance, null-filtering). Full patterns live in the `/workflow` guide.
- `execute(toolCallId, params, signal, onUpdate, ctx)`:
  1. Build run state: `{ name, phases, agents: AgentRecord[], logs: string[], startedAt }` — `AgentRecord` tracks label, phase, status (`running/done/error/aborted`), output preview, usage, model.
  2. Construct hooks (`agent` closes over the semaphore, `ctx.cwd`, `signal`; every state change calls `onUpdate({ content, details })` for live TUI progress).
  3. Run the sandbox; on completion serialize the script's return value: `content` = pretty-printed JSON (or string as-is), truncated with `truncateHead` + `DEFAULT_MAX_BYTES` from `@earendil-works/pi-coding-agent`; `details` = full run state + return value (for rendering/state).
  4. On abort (`signal`), kill in-flight subprocesses, mark records aborted, return partial results with a clear "aborted" note; on script error, throw (pi sets `isError`).
- State: no cross-session persistence needed in v1 (each run is self-contained in the tool result `details`).

### 7. `src/render.ts` — TUI rendering

- `renderCall`: bold `workflow` + name + dim description (first line).
- `renderResult`: group `AgentRecord`s by phase; per-agent status icon (`✓/✗/⏳`), label, usage summary (reuse the `formatTokens`/`formatUsageStats` approach from the subagent example, simplified); log lines; aggregate usage + total cost footer; `expanded` shows full per-agent final outputs as `Markdown` components. Guard TUI-only code paths — rendering is only invoked in TUI mode anyway.

### 8. `src/guide.ts` + `src/index.ts` — the `/workflow` command

- `guide.ts`: a markdown authoring guide adapted from Claude Code's Workflow instructions to this tool's surface: hook reference, pipeline-vs-parallel (barrier only when cross-item context is needed), quality patterns (adversarial verify, loop-until-dry, judge panel, multi-modal sweep), null-filtering, concurrency cap note, schema usage, "scale to what the user asked for".
- `index.ts` default factory:
  - Does **not** register the `workflow` tool at load time — only the command and the message renderer.
  - `pi.registerCommand("workflow", { description, handler })`:
    1. If `args` empty → `ctx.ui.notify` usage hint and return.
    2. Lazily register the tool on first use: a module-level `registered` flag guards `pi.registerTool(workflowTool)`; after registering, ensure it is active via `pi.setActiveTools([...new Set([...pi.getActiveTools(), "workflow"])])`.
    3. `pi.sendMessage({ customType: "dynamic-workflow-brief", content: guide + "\n\n## Task\n" + args, display: true }, { triggerTurn: true })`.
  - Register a compact `registerMessageRenderer("dynamic-workflow-brief", ...)` so the injected guide renders as a one-line collapsed notice instead of a wall of text.
  - Because the tool may be absent when a session is resumed mid-conversation after containing prior `workflow` tool calls, the lazy registration is idempotent and also re-runs from a `session_start` handler **only if** the current branch already contains `workflow` tool results (scan `ctx.sessionManager.getBranch()`), so resumed sessions keep rendering/re-invoking correctly.

## Verification

1. `npm install` (pulls real peer deps for types) → `npm run typecheck` passes with zero errors under strict mode.
2. Sandbox/scheduler unit smoke: run a tiny node script via `npx tsx`/`node --experimental-strip-types` (or a scratch harness) exercising `parallel`/`pipeline` null-semantics and vm wrapping without spawning pi.
3. Subagent smoke (cheap, non-interactive): a scratch script calling `runSubagent` with a trivial prompt and a small model to confirm JSON-event parsing and, with a `schema`, that `emit_result` arguments round-trip.
4. End-to-end: `pi -e ./src/index.ts -p "/workflow use two parallel agents to count *.md files and *.ts files in this repo, then combine"` — confirm the LLM authors a script, the `workflow` tool executes, subagents spawn, and the final result summarizes both counts. Then an interactive TUI check of `renderResult` (collapsed + Ctrl+O expanded) and Esc abort mid-run.
