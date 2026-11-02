# Changelog

## [Unreleased]

### Fixed

- A structured result that Pi rejected for not matching the schema is reported as a failure, and accepted results carry Pi's type conversions, such as `"5"` to `5`.

## [0.3.0] - 2026-10-06

### Breaking Changes

- Requires Pi 1.0.4 or newer.

### Added

- `agent()` and agent profiles accept `excludeTools` and `noMcp`.

## [0.2.2] - 2026-10-01

### Changed

- Supports Pi 1.x.

## [0.2.0] - 2026-09-21

### Breaking Changes

- Requires Pi 0.86 or newer.

## [0.1.0] - 2026-07-17

### Added

- Initial release. The `workflow` tool runs an LLM-written JavaScript script whose `agent()` calls start isolated pi subagents, with concurrency limits, structured output, timeouts, agent types, cost and token budgets, saved and nested workflows, resume, and background runs.
