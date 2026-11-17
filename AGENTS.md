# Themelios Guide

This file applies to the entire repository. When modifying content in one part of it, follow the `AGENTS.md` of the corresponding directory; rules belong in the file that loads where the work happens.

No Agent may modify, move, or delete `AGENTS.md` or another file that governs Agents, such as the (*) documents listed in [docs/AGENTS.md](docs/AGENTS.md), unless the developer has explicitly permitted and requested it. When a requested change requires such a modification and that permission is absent, deliver it as `<TOPIC>.proposal.patch` in the repository root, remind the developer to review it, and keep working on unrelated parts. The patch is not repository content: Git ignores it, and you delete it once it has been applied.

Proactively use applicable Skills. Apply their methods within the user's instructions and repository rules; when a Skill conflicts with either, follow the applicable higher-priority instruction.

## AntiRLHF Rules

> Especially for GPT models.

Read the [CONSTITUTION](docs/agents/antirlhf/CONSTITUTION.zh-CN.md) before acting; if its complete text has already been supplied in the session/context, use that copy. The [AntiRLHF Charter](docs/agents/antirlhf/CHARTER.md) explains its background and intent; read it when writing or assessing governance text or when a requirement's intent is unclear.

## Project Overview

Themelios is an independently developed and distributed foundation platform, usable by applications through its public interfaces.

`legacy/` is retired research material and does not participate in running; when a capability in it is needed, migrate/adapt it in according to the current contract, and do not restore the entire old runtime stack.

Read the relevant entries according to the task. There is no need to read all of the designs and historical discussions all the way through.

`docs/design/` defines the current contract, `docs/plans/` arranges the dependencies and delivery of specific work, and `docs/sources/` retains the original discussions. Proposals in the original discussions cannot be taken directly as approved decisions. When code and design are inconsistent, judge, in conjunction with the current requirements, which side should be modified, and do not take the old implementation or old tests as the final standard.

## Engineering Choices & Principles

- The project is a prototype with no external consumers; keep `v0.1.0`. Replace unsuitable internal structures directly, migrate their producers, consumers, configuration, tests, and documents, and remove the replaced implementation and its support. Do not add incrementing internal version identifiers such as `v1`/`v2`, version chains, compatibility branches, or dual paths. Do not retain or back up old formats of internal structures being eliminated. Preserve user manuscript revisions and precise historical citations according to the product contract.
- Use the formal capabilities of the project's mature dependencies for protocol clients, media parsing, and databases; do not duplicate them or add forwarding layers to preserve an unsuitable structure. Do not mechanically create a service, repository, or manager for every concept.
- Remain vendor-neutral. LLM services are accessed through a unified gateway. "New API" is one usable gateway. Production code does not add special business behavior for a particular external platform. Configure the work according to explicit protocol, capability, and task, and do not guess capabilities from model names.
- Follow the [LLM usage and prompt guide](docs/agents/llm-use.md) when designing or assessing model calls. Provide the context needed for the task and assess outputs using the information actually available to the model.

## Code Review

Review the scope the user requests. For work in progress, inspect the relevant staged, unstaged, and new files; use the user request and available design when there is no separate specification or issue.

## Verification

TDD and red-green cycles are not recommended. Do not add shallow tests, field-existence tests, or repeated verification of behavior that a dependency already owns. Prefer the real user entry point for complete-path verification; use focused tests for key contracts, security details, and independently failing behavior with protective value. Testing invalid input or failures does not constitute a red-green cycle.

Choose verification that can expose problems in the change, including relevant success and failure behavior. Report what was actually run, distinguish simulation from real external services, and state unverified scope. Do not substitute test counts or an all-green run for observed results and product judgment. DO NOT treat a development report or remote CI as evidence.

When an old test only protects an old implementation, delete it together with the old implementation. Migrate usage situations that still have value to the new entry point. Do not, for tests, add a dedicated export point or a parallel implementation to production code, or set up an extra test framework.

Tests are located in `tests`; scaffolding, probes and experimental scripts go in `temp/` under the Temporary Data rules.

## Document Maintenance

When design, a public contract, or responsibilities change, update the responsible topic and affected indexes in place, and remove statements that no longer hold. Define each rule in one responsible place; other places cite it.

For important classes and methods, use comments to state responsibilities, state boundaries, or non-obvious invariants, and do not restate the implementation line by line. For the details, see [docstring standard](docs/agents/docstring-std.md).

`CURRENT.md` records current capabilities, decisions in effect, and remaining work. DO NOT write it as an operations log or changelog. DO NOT write each correction up as a permanent prohibition, and DO NOT leave retired schemes, the implementation process, or self-review explanations in product documents, code comments, or the UI.

## Development Environment and Commands

Use the installed Fallow Skill and Fallow analysis by default for TypeScript and JavaScript changes. Use its type-aware analysis for symbol relationships and its configured commit gate. Run `bun run lint:agent` on affected TypeScript and JavaScript files, and run the length check for affected source files. Use the Bun agent test output when running relevant tests.

Use CodeGraph for indexed code structure, Zvec-grep for semantic and lexical discovery, and ast-grep for syntax-aware searches or rules. Consult Context7 or the relevant official documentation for dependency APIs when current documentation is needed. Use the Fallow MCP tools for project-wide code analysis.



## Fallow checks

Use fallow for code-quality, cleanup, and setup tasks in this repository. Fallow checks the changed code before each `git commit` and `git push`. In Claude Code and Codex, a PreToolUse hook from `fallow agent install` runs this check and blocks the command when the verdict is `fail`. Other agents run the check themselves: `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before you try again. A JSON runtime error such as `{ "error": true, ... }` does not block.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to... | Run |
|---|---|
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| prove a TypeScript symbol's exact consumers before refactoring | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>` |
| find how one module reaches another | `fallow trace --path <from> <to>` (Reports `reachable: false` instead of failing when no import path exists; type-only hops are reported, not skipped.) |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| migrate a dependency | `fallow trace --dependency <name> --sites` (Counts each imported name, follows one hop through project wrappers, and counts each use that it cannot resolve.) |
| commit or open a PR | `fallow audit --base <ref>` |
| read a diff before approving it | `fallow review --base <ref> --brief` (orientation, never gates: deterministic and always exit 0, unlike the audit row) |
| prioritize refactoring | `fallow health --hotspots --targets` |
| ask who owns code | `fallow health --ownership` |
| check untested-but-reachable code | `fallow health --coverage-gaps` |
| improve or check the tests of a change | `fallow mutation --plan --base <ref>` (The plan runs no code. Without `--plan`, the command runs the project tests against each mutant, so ask the user first.) |
| consolidate duplication | `fallow dupes --trace dup:<fingerprint>` |
| find feature flags | `fallow flags` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| check import cycles, boundaries and policy rules after changing code | `fallow architecture` |
| surface security candidates | `fallow security` |
| understand a finding | `fallow explain <issue-type>` |
| scope a monorepo | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |



Use Bun 1.4.x, TypeScript 7 and Zod 4.6.x. When running or building the project, first set up the development environment in the repository root so the virtual environment, downloads, and caches are located in `temp/`.

Linux / macOS:

```bash
source ./dev.sh
```

Windows PowerShell:

```powershell
. ./dev.ps1
```

Choose checks appropriate for the change; the available development checks are described in [scripts/check/README.md](scripts/check/README.md).

When a change affects product behavior, check the relevant operation through a real action on the instance.

This project is cross-platform. Except where the requirement itself involves platform adaptation, do not write the development machine's absolute paths or its particular settings into project documents or Git, and do not create long-term autostart or background services.

## Temporary Data

Put temporary generated products, reference repositories, worktrees, downloads, installations, and experimental scripts in `temp/`. Keep requested deliverables and generated project files at their required destinations. Do not scatter temporary project content into the user directory or other locations; existing external development tools may continue to be used.

Use the [temp management tool](scripts/temp/README.md) to create directories, view status, and clean up. Recursive shell deletion commands are prohibited and usually blocked. For authorized temporary cleanup, use the temp tool to preview and select the specific paths, then apply the intended cleanup.

## Codebase Mapping and Reference Retrieval

When present, `INDEX.md` owns the file, symbol and owner map; the `AGENTS.md` files state the constraints at each insertion point. When a `.codegraph/` index exists, use CodeGraph for symbols and code relationships; otherwise skip it. Use Zvec-grep for semantic and lexical discovery when available. See the [retrieval handbook](docs/agents/retrieval.md) for tool usage and reference projects.

```sh
codegraph explore "<symbols or questions>"
```

Refresh an existing index when needed. Initialize retrieval tools through `. ./dev.ps1 init` or `source ./dev.sh init` when the user requests setup; initialization installs tools, creates indexes and updates Codex MCP configuration. Read the responsible module and actual callers along the results; use exact text search to check important relationships. Do not decide the modification only on the basis of a search summary.
