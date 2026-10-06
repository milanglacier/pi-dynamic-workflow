# Pi 1.0.4 subagent tool controls

Status: Completed. Verification and review passed.

## Goal

Respect Pi 1.0.4 tool selection and expose selective exclusions and built-in MCP disablement without changing default access.

## Findings

- `src/subagent.ts` already forwards `tools` to `--tools`, including wildcard patterns. Pi preserves MCP tools unless an allowlist entry starts with `mcp__`.
- MCP registration and model declaration are separate. Restricted authoring examples must include `codemode` for configured MCP access. The runtime forwards caller-provided allowlists unchanged; it does not automatically add helper tools or MCP entries.
- Child processes load their own Pi configuration; parent-session CLI restrictions are not forwarded.
- `mcp__*` does not match MCP resource helpers. Use `--no-mcp` to disable built-in MCP completely. It does not disable replacement MCP extensions.

## Proposed behavior

Add these optional controls to `agent()` and named-agent profiles:

- `excludeTools?: string[]`: forward names or patterns to `--exclude-tools`.
- `noMcp?: boolean`: pass `--no-mcp` when true.

Omission preserves Pi defaults. Explicit call options override profile defaults, consistent with `tools` and `model`; `[]` clears profile exclusions and `false` clears profile MCP disablement. Exclusions take precedence over tool selection. Keep existing `tools: []` behavior unchanged.

Read-only tasks do not imply MCP disablement. Keep `noMcp` opt-in and omit it from read-only examples and profiles unless MCP disablement is explicitly requested. Include `codemode` in those allowlists so configured MCP tools remain callable. MCP capabilities still follow their configuration; a read-only built-in selection is not an MCP permission boundary.

## Implementation

1. Extend `src/types.ts`, `src/agents.ts`, `src/tool.ts`, and `src/subagent.ts`. Parse profile exclusions as a comma-separated list and MCP disablement as a boolean. Validate the new options at runtime; scripts are plain JavaScript.
2. Preserve the existing structured-output allowlist merge. When `schema` is supplied, reject exclusions matching `emit_result` before spawning, with a clear error.
3. Include both controls and their resolved profile values in `src/journal.ts` cache hashes so changes invalidate cached calls.
4. Update `README.md` and `src/guide.ts` together. Document MCP preservation, patterns, and the two controls. Correct the claim that omitting `tools` grants all tools: it uses Pi's configured defaults. Keep MCP configuration independent of read-only tool selection; do not add `noMcp: true` to read-only examples or profiles by default. Include `codemode` in restricted examples and read-only profile allowlists for MCP access.
5. Raise the minimum supported Pi version to `1.0.4` in `package.json` and update the lockfile.

### Prompt and description constraint

Keep model-facing descriptions and authoring prompts concise. Add the option names and only the necessary mechanisms: exclusions apply after selection; `noMcp` disables built-in MCP; a tool allowlist may retain MCP. Avoid long explanations, repeated examples, and implementation details. Put fuller reference material in the README.

## Verification

Test new observable behavior or guard against regressions in behavior supported by a previous version. Do not add tests merely to confirm internal development iterations, whether they involve implementation, documentation, prompts, or examples.

- Fake-Pi argument tests: default behavior, wildcard pass-through, exclusions, and MCP disablement. These verify CLI wiring, not actual MCP execution.
- Profile tests: parsing, inheritance, explicit `false`/`[]` overrides, and invalid values.
- Structured-output tests: required tool remains selected; conflicting exclusions fail before spawning.
- Resume tests: changes to either control or profile defaults invalidate cached calls.
- Run `npm run typecheck` and `npm test` from this repo. Cap the test shell's process limit at the current user task baseline plus approximately 500. Never spawn real Pi or MCP servers in tests; preserve invocation and recursion guards.

## Results

- Added both controls to script options, named profiles, subprocess arguments, and resume hashes, with shared runtime validation.
- Kept MCP defaults and subprocess safeguards intact. Structured-output exclusions fail before spawning.
- Updated documentation with concise model-facing additions and raised the Pi minimum to `1.0.4`. Read-only examples and profiles include `codemode` for configured MCP access; disablement remains opt-in.
- `npm run typecheck`, all 87 process-capped tests, and `git diff --check` passed. Package dry-run includes the shared module.
- Removed the redundant read-only argument test and prompt-content assertion. Recorded behavioral testing guidance in `AGENTS.md`.
- Final code review found no issues; see `review.md`.

## Confirmed decisions

1. Configure children independently for this patch. Do not inherit parent-session MCP disablement or tool exclusions; document this behavior.
2. Require Pi `>=1.0.4 <2.0.0`, replacing the `0.86.0` minimum.
3. Do not set `noMcp: true` merely because a subagent is read-only. Disable MCP only when explicitly requested.
4. Include `codemode` in read-only example and profile allowlists so preserved MCP tools can be called. Do not automatically widen runtime allowlists.
