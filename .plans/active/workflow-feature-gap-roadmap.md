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

---

## Code review — 2026-07-07 (branch `workflow-feature-gap` / commit `f290ed9`, reviewed against this plan)

Note: the reviewed diff is `f290ed9` itself (the roadmap implementation, ~1,716 insertions across 18 files) against its parent.

### Verification

- `npm run typecheck`: clean.
- `npm test` under the calibrated `ulimit -u` cap: **59/59 pass** (~2.3s). All spawning tests go through `test/fake-pi.ts`; journal/registry/tool tests redirect the agent dir via `PI_CODING_AGENT_DIR`, so nothing touches `~/.pi/agent`.

### Overview

The commit lands all four milestones: agent options (`timeout`, `systemPrompt`, `appendSystemPrompt`, `agentType`), `maxAgents` cap, sandbox determinism guards, `maxCost`/`maxTokens` budget with a `budget` script global, saved workflows (`src/registry.ts`) + nested `workflow()`, run journaling/resume (`src/journal.ts`), and background execution via the `createWorkflowTool(host)` factory with `/workflow-stop` and `session_shutdown` cleanup. Overall quality is high: the design decisions the plan called out (multiset resume cache, soft budget cap, budget-free cached replays, timeout as non-abort failure) are implemented and individually tested.

**CLAUDE.md safety compliance: good.** `getPiInvocation`'s argv[1] basename check and the `PI_WORKFLOW_DEPTH` guard are untouched; `src/agents.ts` copies only the subagent example's *discovery* code and says so in its header; the subprocess model is preserved (nested `workflow()` correctly shares the parent's process-free hooks and documents its orthogonality to the depth guard).

### Findings

**F1 (medium, bug) — concurrent sibling `workflow()` calls are spuriously rejected.** `src/tool.ts:357-364`: `nestingDepth` is a single shared counter incremented for the duration of each nested run. `parallel([() => workflow("a"), () => workflow("b")])` at *top level* is not nesting, but the second call observes `nestingDepth === 1` and throws "workflow() nesting is limited to one level". The guard conflates depth with concurrency. Fix: carry depth per invocation chain — e.g. `runNestedWorkflow(depth)` returning a closure, and give the child's hooks `workflow: makeNested(depth + 1)` instead of sharing the counter. (The `currentPhase = prevPhase` restore in the same `finally` is also racy under sibling concurrency, but that's moot until F1 is fixed and is cosmetic anyway.)

**F2 (medium, resume soundness) — `agentCallHash` hashes the `agentType` *name*, not its resolved definition.** `src/journal.ts:68-81`. The definition file (`.pi/agents/*.md`) supplies system prompt, tools, and model — all behavioral — but only the name string enters the hash. Edit the definition between runs and a resume silently replays results produced under the old prompt/tools/model. Since the type is already resolved before the cache lookup (`src/tool.ts:231`), the fix is cheap: feed the resolved `{systemPrompt, tools, model}` into the hash instead of (or alongside) the name.

**F3 (minor, perf) — `JournalWriter` rewrites the entire journal synchronously on every `record()`.** `src/journal.ts:149-160`. With `maxAgents` up to 200 and full subagent output text per entry, that's O(n²) synchronous I/O on the extension-host thread, stalling the TUI late in large runs. Consider JSONL append (`fs.appendFileSync` of one entry per line) — it would also make `loadJournal` tolerant of a truncated final line after a crash, which is exactly the resume scenario.

**F4 (minor, plan deviation) — plan item 8's `pi.appendEntry("workflow-run", { runId, path })` was not implemented** (no `appendEntry` call in the codebase). Runs are only discoverable from the tool-result header text; a session resumed after a crash has no structured record of the runId it would want to pass to `resumeFromRunId`. Either implement it (the factory already holds the `pi` handle) or amend this plan to record the descope.

**F5 (minor, plan deviation) — nested `log()`/phase prefixing (plan item 7) is partial.** Only a `── workflow <name>` boundary marker is logged; the child's own `log()` lines and phases are indistinguishable from the parent's in the TUI.

**F6 (minor, plan deviation) — no typed `BudgetExceededError`.** The plan named a distinct error type; the implementation throws a generic `Error` (`src/tool.ts:265`). Scripts (and tests) can only distinguish budget exhaustion by message-matching. A named error class surfaced to the sandbox would let scripts `catch` it deliberately (e.g. to return partial results).

**F7 (minor, pre-existing) — a child killed by an external signal reads as success.** `src/subagent.ts:239-242`: `proc.on("close", (code) => resolve(code ?? 0))` maps signal-death (`code === null`) to exit 0. Self-initiated kills are covered by the `aborted`/`timedOut` flags, but an OOM-killed or externally SIGKILLed child returns `ok: true` with partial output in text mode. Suggest resolving `code ?? (aborted || timedOut ? 0 : 1)` or inspecting the `signal` argument of `close`.

**Nits (no action required):**
- `activeBackgroundRuns` is module-level while the tool is now a per-instance factory (`src/tool.ts:96`) — fine for one extension per process, but the asymmetry is worth a comment.
- `stopWorkflowRun` leaves the run in `listActiveWorkflowRuns()` until the completion notify fires, so `/workflow-stop` with no args can list a run that is already stopping.
- `pruneOldRuns` runs before the new journal is written, transiently allowing `MAX_KEPT_RUNS + 1` files.
- `loadWorkflowSource` calls `discoverWorkflows` twice on the unknown-name error path (`src/registry.ts:94-97`).
- `opts.timeout: 0` and `maxConcurrency <= 0` pass through unvalidated (`timeout: 0` silently disables via falsiness; a non-positive semaphore size would wedge).
- `scriptPath` / `workflow(path)` can read any file relative to cwd — same LLM-author trust model as the sandbox's documented non-boundary, but worth one sentence in the guide.

### Test coverage

Strong overall: resume replay + changed-call fallthrough, budget-free cached replays, unknown-runId fallback, nested accounting + depth refusal, saved-workflow discovery/override, `--append-system-prompt` temp-file content (snapshotted inside the stub — nice), timeout masquerade, background lifecycle including abort-signal independence. Gaps:
- No test for **concurrent sibling `workflow()`** (would have caught F1).
- No test for **resume after an agent-definition edit** (F2).
- `maxTokens` budget path untested (only `maxCost`); `background: true` + `resumeFromRunId` combination untested.

### Verdict

Ship-worthy after F1 (small, contained fix) and ideally F2 (cheap, protects resume soundness). F3–F7 can follow up. Plan deviations F4/F5/F6 should either be implemented or recorded above as deliberate descopes so the plan stays truthful.

---

## Review fixes — 2026-07-07 (resolves F1–F7 and all nits from the review above)

All findings resolved in the working tree; `npm run typecheck` clean, **67/67 tests pass** (59 prior + 8 new) under the calibrated `ulimit -u` cap, all via `test/fake-pi.ts`.

### Fixes

- **F1 — concurrent sibling `workflow()` calls** (`src/tool.ts`): removed the shared `nestingDepth` counter. The one-level limit is now enforced per invocation chain — the child's hooks get a `workflow` that always throws — so top-level siblings under `parallel()` run fine while a child calling `workflow()` is still refused. New test: "concurrent sibling workflow() calls are allowed" (registry.test.ts).
- **F2 — resume hash blind to agent-definition edits** (`src/journal.ts`, `src/tool.ts`): `agentCallHash` now takes the *resolved* agent-type config and hashes its `systemPrompt`/`tools`/`model` alongside the `agentType` name; `runAgent` passes the already-resolved definition. Editing a `.pi/agents/*.md` between runs now invalidates that call's cache. New tests: hash unit test + end-to-end "resume after an agent-definition edit runs live" (journal.test.ts).
- **F3 — O(n²) journal rewrites** (`src/journal.ts`): journal format changed from a single JSON document to append-only JSONL (`runs/<runId>.jsonl`): one meta line at creation, one `fs.appendFileSync` per recorded call. `loadJournal` reassembles the `RunJournal` and drops an unparsable (crash-truncated) tail line instead of discarding the whole journal. New test: "loadJournal tolerates a truncated final line".
- **F4 — missing `pi.appendEntry` (plan item 8)** (`src/tool.ts`): `WorkflowToolHost` widened to include `appendEntry`; every run appends a `workflow-run` entry (`{ runId, path }`) to the session JSONL right after the journal is created, so resumable runs are discoverable after a crash. `createWorkflowTool(pi)` in `src/index.ts` already passes the full API — no entry-point change needed. New test: "a run appends a workflow-run entry" (tool.test.ts).
- **F5 — nested log/phase attribution (plan item 7)** (`src/tool.ts`): the child's hooks now wrap `log` (`[child] message`) and `phase` (`child: title`), so nested output is attributed in the TUI; the `── workflow <name>` boundary marker is kept. Covered by the sibling-workflow test's log assertions.
- **F6 — typed budget error** (`src/tool.ts`): added exported `BudgetExceededError` (name `"BudgetExceededError"`), thrown by the budget gate. Scripts catch it by name (cross-realm `instanceof` doesn't hold in the vm sandbox); documented in `src/guide.ts` and README. New test: "budget: maxTokens stops further agent() calls with a named error" — which also closes the untested-`maxTokens` coverage gap.
- **F7 — external signal death read as success** (`src/subagent.ts`): `terminate()` sets a `killedByUs` flag; the `close` handler now maps `code === null` without that flag to exit 1 with `errorMessage: "pi killed by signal <sig>"`, so an OOM-killed/externally SIGKILLed child no longer masquerades as a successful run with partial output. Self-initiated kills still resolve through the existing `aborted`/`timedOut` paths. New fake-pi mode `selfkill` + test in subagent.test.ts.

### Nits also addressed

- `stopWorkflowRun` deregisters the run immediately, so a stopping run is no longer listed as active by `/workflow-stop`.
- `pruneOldRuns` now runs after the new journal is written (no transient `MAX_KEPT_RUNS + 1`; the new file has the newest mtime and survives the cut).
- `loadWorkflowSource` no longer runs discovery twice on the unknown-name path.
- `maxConcurrency` is clamped to ≥ 1 (a non-positive value would have wedged the semaphore).
- Module-level `activeBackgroundRuns` now carries a comment explaining why it isn't per-factory-instance.
- Remaining coverage gap from the review closed: "background run resumes from a prior journal" (journal.test.ts) exercises `background: true` + `resumeFromRunId` together.

### Docs

`src/guide.ts` (tool description + authoring brief) documents the `BudgetExceededError` name; README mirrors that, the `.jsonl` journal path, and the agent-definition cache-invalidation behavior. Not done (unchanged scope): worktree isolation remains deferred as recorded above.
