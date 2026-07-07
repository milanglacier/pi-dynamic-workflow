# pi-dynamic-workflow: Feature Gap Roadmap

## Context

The extension already covers the core of a Claude-Code-style dynamic workflow: LLM-authored script, `agent()` spawning isolated `pi --mode json -p --no-session` subprocesses, `parallel()`/`pipeline()`, structured output via a temp `emit_result` extension, concurrency semaphore, abort handling, and per-agent usage rendering. A gap analysis against Claude Code's Workflow tool found ten missing features; a feasibility pass against pi 0.80.3 docs (`~/.local/share/pi/docs/`), `pi --help`, and the official subagent example confirmed **all are implementable with the existing extension API + CLI flags — no pi-core changes needed**. User selected all four feature groups.

Key platform facts (verified):
- `pi` CLI has `--system-prompt` and `--append-system-prompt <text-or-file>` (repeatable) — no temp-extension trick needed for custom prompts.
- Agent-definition convention exists: `~/.pi/agent/agents/*.md` + `<project>/.pi/agents/*.md` with frontmatter (`name`, `description`, `tools`, `model`; body = system prompt), discovered via `getAgentDir()`/`CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` (see `~/.local/share/pi/examples/extensions/subagent/agents.ts:85-116`).
- `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "followUp" })` works outside a turn (pattern proven in `examples/extensions/file-trigger.ts`) — enables background-completion notification.
- `pi.appendEntry(customType, data)` persists extension state into the session JSONL without entering LLM context; `session_shutdown` event exists for cleanup.

**Safety constraint (CLAUDE.md):** keep the subprocess model (`pi -p` spawns), the argv[1] basename check, and the `PI_WORKFLOW_DEPTH` guard. When copying from the subagent example, copy only its *discovery* code, never `getPiInvocation`. All spawning tests go through `test/fake-pi.ts`; wrap test runs in the calibrated `ulimit -u` cap.

## Milestone 1 — Safety & quick wins (all S)

1. **Total agent-count cap**: in `src/tool.ts`, `MAX_AGENTS_PER_RUN = 200` (tool param may lower it); `runAgent` throws past the cap — existing catch path already aborts the controller and kills children.
2. **Per-agent timeout**: `AgentOptions.timeout` (ms). In `src/subagent.ts`, unref'd timer after spawn reusing the existing SIGTERM→5s→SIGKILL escalation (`killProc`); result becomes `status: "error"` → `null` (not `WorkflowAbortError`). Add a sleep mode to `test/fake-pi.ts`.
3. **Determinism guards**: in `src/sandbox.ts` context setup, make `Math.random`, `Date.now`, and zero-arg `new Date()` throw with a message pointing to `args` for timestamps (needed for Milestone 4's resume cache; no current sandbox usage exists). Document in `src/guide.ts`.
4. **Budget enforcement**: tool params `maxCost`/`maxTokens`; run-level `UsageStats` accumulated in the existing `onEvent` usage plumbing (`src/tool.ts:127-130`); expose `budget = { total, spent(), remaining() }` global; `runAgent` throws `BudgetExceededError` before acquiring a semaphore slot when exhausted. Soft cap (in-flight agents finish) — document. Show spend in `src/render.ts`.
5. **Custom system prompts / agent types**: `AgentOptions.systemPrompt` / `appendSystemPrompt` → CLI flags in `src/subagent.ts` arg construction (long prompts via temp file, as `subagent/index.ts:323-327` does). `AgentOptions.agentType` resolves against pi's agents convention via new `src/agents.ts` (~80 lines, adapted from the example's discovery code) — applies the definition's system prompt, tools, and model.

## Milestone 2 — Saved & nested workflows (S/M)

6. **Registry** (`src/registry.ts`): discover scripts from `~/.pi/agent/workflows/` and nearest `<project>/.pi/workflows/` (same walk-up + project-overrides-user shape as the subagent example). Tool params `workflowName` / `scriptPath` as alternatives to inline `script`. `/workflow` command brief lists available named workflows.
7. **Nested `workflow(nameOrPath, args)` script global**: loads via the registry and re-enters `runWorkflowScript` with the parent's hooks (semaphore, abort signal, agent counter are already closures — sharing is automatic). One nesting level; clear error at depth 2. Prefix nested `log()`/phase attribution with the child name. Comment that this is orthogonal to `PI_WORKFLOW_DEPTH` (no extra process).

## Milestone 3 — Resume & journaling (M)

8. **Journal** (`src/journal.ts`): per-run file at `~/.pi/agent/pi-dynamic-workflow/runs/<runId>.json`; one entry per completed `agent()` call keyed by hash of (prompt, canonicalized opts). Use `hash → queue-of-results` (multiset) rather than strict sequence so `parallel()` completion-order nondeterminism doesn't bust the cache. Never journal agents killed mid-flight. Also `pi.appendEntry("workflow-run", { runId, path })` so runs are discoverable from the session.
9. **Resume**: `resumeFromRunId` tool param; `runAgent` serves cached results (new `status: "cached"`, distinct icon in `src/render.ts`) while hashes match, runs live from first mismatch. Sound because of Milestone 1's determinism guards.

## Milestone 4 — Background execution (M)

10. **`background: true` tool param**: refactor the module-level `defineTool` in `src/tool.ts` into a factory `createWorkflowTool(pi)` (called from `src/index.ts`) so the tool holds a `pi` handle. Execute starts the run, detaches, returns immediately with `runId` + journal path (the existing `finished`-flag machinery already suppresses post-return `onUpdate`). On completion: `pi.sendMessage({ customType: "workflow-complete", content: summary, display: true }, { triggerTurn: true, deliverAs: "followUp" })`.
11. **Run control**: per-run abort-controller registry keyed by runId; `/workflow-stop <runId>` command; idempotent `session_shutdown` handler aborting in-flight background runs. Document that runs die with the pi process — resumable via Milestone 3.

## Deferred (not selected, note for later)

- **Worktree isolation per agent** (`isolation: "worktree"`): plain git plumbing (`worktree add --detach` → run → remove if `status --porcelain` clean), but has the most lifecycle edge cases (abort leaks, lockfiles, non-git cwd). Revisit after the above land.
- SDK `createAgentSession()` in-process subagents: deliberately rejected — the subprocess boundary is the fork-bomb containment story.

## Files

- Touch: `src/tool.ts`, `src/subagent.ts`, `src/sandbox.ts`, `src/types.ts`, `src/index.ts`, `src/render.ts`, `src/guide.ts` (+ mirror README.md per the guide's sync note)
- New: `src/agents.ts`, `src/registry.ts`, `src/journal.ts`
- Tests: extend `test/fake-pi.ts` (sleep mode, flag assertions for `--append-system-prompt`), new `test/registry.test.ts`, `test/journal.test.ts`; sandbox tests for determinism guards and `budget`.

## Verification

- `npm run typecheck` and `npm test` after each milestone (wrap in `bash -c 'ulimit -u 2000; npm test'` per CLAUDE.md).
- All spawning paths tested against `test/fake-pi.ts` only; assert new CLI flags appear in the stub's captured argv.
- End-to-end (only after stub tests pass): load the extension in a real pi session via `~/.pi/agent/settings.json` packages path; run a 2-agent workflow exercising agentType + budget + timeout; run a named workflow from `.pi/workflows/`; kill and resume a run via `resumeFromRunId`; run a `background: true` workflow and confirm the completion message triggers a turn. Real-binary runs use the cheap default model (minimax-m3).
