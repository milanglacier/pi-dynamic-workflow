# pi-dynamic-workflow

Pi extension: the LLM authors a JS orchestration script; `agent()` in the script spawns isolated `pi --mode json -p --no-session` subprocesses. Entry point: `src/index.ts`. Verify changes with `npm run typecheck` and `npm test`.

Tests use `node --test` (zero deps, native TS type stripping). All spawning tests go through the fake `pi` stub in `test/fake-pi.ts` — never the real binary.

## Subprocess safety (learned from a real incident)

This repo once fork-bombed the machine. A smoke test called `runSubagent` directly, and `getPiInvocation` (copied from pi's official subagent example) re-invoked `process.argv[1]` — which was the test harness itself, not pi — causing unbounded recursive self-spawning until memory exhaustion.

Rules:

- **Never blindly re-invoke `process.argv[1]`.** `src/subagent.ts` only reuses it when its basename matches pi's CLI entry (`pi`, `cli.js`); otherwise it falls back to `pi` on PATH. Do not "simplify" this back to the upstream example's logic.
- **Keep the recursion guard.** Every spawn increments `PI_WORKFLOW_DEPTH` in the child env; `runSubagent` refuses to spawn at depth >= 3. Do not remove it.
- **Never run untested subprocess-spawning code against reality.** Verify spawning logic first with a fake `pi` stub on PATH (a shell script emitting a canned JSON event stream), and only then with the real binary.
- **Wrap spawning smoke tests and the test suite in a process cap.** `ulimit -u` (RLIMIT_NPROC) counts ALL of the user's processes AND threads system-wide, not just descendants of the capped shell — so the cap must sit above the desktop-session baseline or legitimate spawns fail with `pthread_create: Resource temporarily unavailable`. Calibrate: `baseline=$(ps -eL --no-headers -u $USER | wc -l)`, then cap at roughly baseline + 500 (e.g. `bash -c 'ulimit -u $((baseline + 500)); npm test'`; ~2000 on this machine, where the baseline is ~600). That headroom is far below the thousands of tasks a fork bomb needs to exhaust RAM. If a runaway happens anyway, kill the whole tree at once (`pkill -f <name>`) — killing single processes lets the chain regrow.
- **When copying patterns from pi's example extensions, check their context assumptions.** The subagent example's invocation logic is only safe when the calling process IS pi; plans or examples that lift such code out of context can carry latent hazards.
