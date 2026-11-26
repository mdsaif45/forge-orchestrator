# Milestones & Implementation Tasks

**Status:** ACTIVE
**Authority:** Planning Truth
**Last Updated:** 2026-11-26
**Baseline:** `main` @ `34b85d9` (PR #503 merged) | Milestones M0–M16 100% COMPLETE; M17 Phases 1A–4 DONE, Phase 5 IN-PROGRESS
**Related Architecture:** [architecture-overview.md](../architecture/architecture-overview.md)
**Related Progress:** [current-state.md](../project/current-state.md)

---

## Status Legend
- **`DONE`**: Merged to `main` and verified with passing automated tests and physical evidence.
- **`IN-PROGRESS`**: Actively under development in an open PR branch.
- **`READY`**: Fully specified, all upstream dependencies satisfied, ready for implementation.
- **`BLOCKED`**: Waiting on an incomplete upstream dependency.
- **`DEFERRED`**: Formally postponed with documented technical rationale.

---

## M0: Foundation & Quality Gates (GitHub Milestone #1 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **M0-001** | — | P0 | **DONE** | — | Establish CI matrix, linting, formatting, and test runner baseline. | Baseline tests passing on Windows and Linux CI. | PR #186 |
| **M0-002** | #178 | P1 | **DONE** | — | Resolve intermittent Windows git EBUSY test failures during parallel runs. | Zero flakiness via `removeTempDir` polling. | PR #209 |
| **M0-003** | #64 | P3 | **DONE** | — | Formally close obsolete spike #64 with evidence. | Closed: superseded by ADR-001/ADR-003 and headless CLI test suites. | PR #209 |

---

## M1: Headless Forge Core (GitHub Milestone #2 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CORE-001** | #199 | P0 | **DONE** | M0-001 | Decouple domain and task orchestrator from Electron runtime. | `createForgeCore` in `packages/forge-core/src/core/forgeCore.ts`. | PR #198 (`26ac6e3`) |
| **CORE-002** | #199 | P0 | **DONE** | CORE-001 | Support arbitrary data directory via `--data-dir` flag. | `resolveDataDir` verified in `packages/forge-core/src/core/forgeCore.test.ts`. | PR #198 (`26ac6e3`) |
| **CORE-003** | — | P1 | **DONE** | CORE-001 | Headless configuration and environment loader (`.forgerc`). | `loadForgeConfig` in `packages/forge-core/src/config/forgeConfig.ts`. | PR #231 |

---

## M2: Native Forge Agent Core 1.0 (GitHub Milestone #3 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **AGENT-001** | #200 | P0 | **DONE** | CORE-001 | In-process native agent task loop and tool calling engine. | `executeDirectTask` in `packages/forge-core/src/core/taskRunner.ts`. | PR #198 (`26ac6e3`) |
| **AGENT-002** | — | P1 | **DONE** | AGENT-001 | Streaming artifact ingestion (`writeArtifactStream`) for large tool output. | `ArtifactService.writeArtifactStream()` in `artifactService.test.ts`. | PR #209 |
| **AGENT-003** | — | P1 | **DONE** | AGENT-001 | Eager concurrent read-only tool execution via `Promise.all`. | Concurrent read-only tool calls verified in `agentLoop.test.ts`. | PR #235 |
| **AGENT-004** | — | P1 | **DONE** | AGENT-001 | Local Ollama auto-discovery and capability probing. | `discoverOllamaModels` verified in `ollamaDiscovery.test.ts`. | PR #235 |

---

## M3: Forge CLI 1.0 (Headless & TUI) (GitHub Milestone #4 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CLI-001** | #201 | P0 | **DONE** | AGENT-001 | Standalone `bin/forge.ts` and `bin/forge.js` CLI entrypoints. | CLI runs tasks with zero Electron dependency (`packages/forge-cli`). | PR #198 (`26ac6e3`) |
| **CLI-002** | #201 | P1 | **DONE** | CLI-001 | Headless NDJSON event streaming mode (`--json`). | Emits parseable line-delimited events to stdout. | PR #198 (`26ac6e3`) |
| **CLI-003** | #201 | P1 | **DONE** | CLI-001 | Clean exit code contract (0=Success, 1=Fail, 2=Halt). | Verified in `packages/forge-cli/src/cli.test.ts`. | PR #198 (`26ac6e3`) |
| **CLI-004** | #438 | P1 | **DONE** | CLI-001 | Interactive terminal TUI for live CLI monitoring and diff rendering. | Live multi-pane TUI renderer (`forge tui`). | PR #477 (`5008599`) |
| **CLI-005** | #155 | P2 | **DONE** | CLI-001 | Live tool-call timeline rendering in terminal. | Tool invocation visual timeline. | PR #232 |
| **CLI-006** | — | P1 | **DONE** | CLI-001 | Headless CLI workflow inspection command (`forge workflows`). | Lists and inspects workflows headlessly in text/JSON. | PR #235 |

---

## M4: State, Events, Artifacts & Persistence (GitHub Milestone #5 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **STATE-001** | — | P0 | **DONE** | CORE-002 | Dual-tier SQLite store (`RunStore`, `EventStore`, `ArtifactStore`) + disk. | `<dataDir>/artifacts/<run-id>/` + SQLite tables. | PR #203 (`1dfb444`) |
| **ARTIFACT-001** | — | P1 | **DONE** | STATE-001 | Windowed byte-offset artifact reader for large terminal logs. | `ArtifactService.readWindow()` in `artifactService.test.ts`. | PR #203 (`1dfb444`) |
| **EVIDENCE-001** | #202 | P0 | **DONE** | CORE-001 | Authoritative evidence model & git diff reconciliation. | `ChangeSet` snapshotting in `taskRunner.ts`. | PR #198 (`26ac6e3`) |
| **IPC-001** | #153 | P2 | **DONE** | CORE-001 | Push runtime events over typed IPC channels to Renderer. | Real-time event streaming verified in `workflowService.test.ts`. | PR #231 |
| **EVENT-001** | #149 | P1 | **DONE** | CORE-001 | Live agent channel subscription and event log replay. | Deterministic replay from event log. | PR #231, PR #232 |

---

## M5: Independent Verification & Criteria Integrity (GitHub Milestone #6 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CRIT-001** | — | P0 | **DONE** | EVIDENCE-001 | Durable completion criteria evaluation & task loop integration. | Criterion evaluator engine, UNKNOWN!=PASS, policy-halt preservation. | PR #204 (`5987501`) |
| **VERIFY-001** | — | P0 | **DONE** | EVIDENCE-001 | Physical diff reconciliation enhancements (untracked & binary). | `--untracked-files=all` collection, nested & binary scope halts. | PR #206 (`92e4e95`) |
| **VERIFY-002** | — | P1 | **DONE** | EVIDENCE-001 | Independent test & build child process execution runner. | `packages/forge-core/src/evidence/verifier.ts` & `verifier.test.ts`. | PR #188 / baseline |
| **VERIFY-003** | — | P2 | **DONE** | VERIFY-001 | Adversarial edge-case verifier auditor for boundary regressions & deceptive evidence. | `packages/forge-core/src/evidence/adversarial.ts`, adversarial tests. | PR #208 (`391630e`) |

---

## M6: Generic Workflow Graph Engine (ADR-007 — Complete)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WORK-001** | — | P0 | **DONE** | CORE-001 | DAG execution engine (`GraphExecutor`) with branch worktrees and fan-in merging. | `graphExecutor.ts`, `worktreeService.ts`, `changeSetMerger.ts`. | PR #215, PR #216 |
| **WORK-002** | #164 | P1 | **DONE** | WORK-001 | Stage run, skip, and re-run interactive controls. | Selective node execution (`runNode`, `skipNode`, `rerunNode`). | PR #217, PR #233 |
| **WORK-003** | — | P1 | **DONE** | WORK-001 | Conditional branching, bounded loop edges, durable artifact lineage hydration. | Loop/retry integration tests & lineage hydration. | PRs #218–#221 |
| **WORK-004** | — | P0 | **DONE** | WORK-003 | Graph pause/recovery lifecycle stabilization & read-model contracts. | `graphLifecycle.test.ts` (28), `views.test.ts` (25). | PR #222, PR #223 |
| **WORK-005** | — | P0 | **DONE** | WORK-004 | Generic leaf runner implementation (`leafRunner.ts`). | `leafRunner.test.ts` fail-closed scope & verification mapping. | PR #224 (`a1964a1`) |
| **WORK-006A..E** | — | P0 | **DONE** | WORK-005 | Production graph factory, role preflight, gate auth, reviewer routing & cutover. | `WorkflowService -> GraphExecutor` production cutover & parity suite. | PRs #225–#230 |

---

## M7–M11: Human Control, Providers, Warm Sessions & Real CLI Hosting (GitHub Milestones #8–#12 — All Closed)

| Milestone | Key Items / Issues | Status | Target Evidence | Implementation PRs |
| :--- | :--- | :--- | :--- | :--- |
| **M7 Human Control** (#8) | `HUMAN-001` (#163), `HUMAN-002` (#171), `HUMAN-003` (#160), `HUMAN-004` (#154), `HUMAN-005` (#117 / ADR-005) | **DONE** | Blocking human approval gate, live PTY steering/interjection, xterm process attachment, unified workflow UX | PR #230, PR #232, PR #234 |
| **M8 Provider Ecosystem** (#9) | `RUNTIME-001` (#174), `RUNTIME-002` (#168), `RUNTIME-003` (#180) | **DONE** | `CustomRuntimeStore`/`CustomCliRuntime`, hosted Antigravity PTY runtime, `claudeRateLimit.ts` quota detection | PR #231, PR #233, PR #234 |
| **M9 Warm Sessions** (#10) | `WARM-001` (#157), `WARM-002` (#158), `WARM-003` (#159) | **DONE** | `WarmSessionStore`, `--resume`/`--conversation` CLI session resume, stage latency spike | PR #232, PR #233 |
| **M10 Interactive Control** (#11) | #160–#164 | **DONE** | Blocking approval gate, stage skip/rerun, mid-run interjections with domain event attribution | PR #230, PR #233, PR #234 |
| **M11 Host the Real CLI** (#12) | #165–#180 | **DONE** | Interactive ConPTY sessions in `@forge/runtimes`, live xterm pane attachment, stdout scraper removal | PR #232, PR #234 |

---

## M12: Autonomous Multi-Agent Control Plane (GitHub Milestone #23 — Closed, 30 issues)

Hardened autonomous execution, state, evidence, workflow, config, and interactive CLI subsystems across `@forge/core`, `@forge/cli`, and `@forge/runtimes`:
- **Agent & Context (`AGENT-005..032`):** Token accounting, prefix cache optimizer, cross-run solution memory (`AGENT-007`), fallback circuit breaker, tool rate limiter, idempotency cache, parameter coercer, output limiter, prompt compactor, stream multiplexer, context budgeter, conversation compressor, coalescer, retry supervisor, prefetch scheduler, goal decomposer, scratchpad buffer, subgoal checkpointer, speculative caches, streaming chunk pipeline (`#428` / PR #468).
- **Workflows (`WORK-007..040`):** Headless workflow CLI, static DAG validator & planner, latency profiler, custom YAML templates, parallel wave planning, snapshotter, DLQ retry policy, timeout supervisor, safe AST condition evaluator, checkpoint restore, DAG simulator, subgraph extractor, preflight preconditions, fork-join, barrier synchronization, speculative execution/fencing/two-phase commit/fan-in aggregator/pruner (`#429` / PR #469), and transactional savepoint & rewind arbiter (`#434` / PR #473).
- **Evidence & State (`EVIDENCE-002..028`, `DIFF-001..004`, `STATE-002..030`):** Diff security/secret scanner, LCOV coverage delta gate, Merkle lineage, reproducible manifests, export surface auditor, AST dependency cycle detector, diagnostic extractor, reverse patch synthesizer (`#430` / PR #470), binary diff hunk compressor & digest signer (`#435` / PR #474), SQLite WAL journal hash-chaining, FTS5 search, point-in-time recovery, query planner hint injector (`#431` / PR #471), zero-copy mmap page reader (`#436` / PR #475).
- **Config & TUI (`CONFIG-002..031`, `CLI-004`):** Encrypted AES-GCM secret vault, hierarchical policy engine, env interpolator/sync, dependency audit gate, emergency capability killswitch (`#432` / PR #472), dynamic sandbox & audit replay daemon (`#437` / PR #476), interactive terminal TUI `CLI-004` (`#438` / PR #477).

---

## M13: Empirical Benchmarking and Hardening (GitHub Milestone #24 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **BENCH-001** | #442 | P0 | **DONE** | M12 | Empirical multi-agent reproducible benchmark harness (`forge benchmark run`). | `packages/forge-core/src/benchmark/benchmarkHarness.ts` + tests. | PR #478 (`8712068`) |
| **BENCH-002** | #443 | P1 | **DONE** | BENCH-001 | Stage wall-clock latency profiler and comparative performance auditor (`forge benchmark latency`). | `packages/forge-core/src/benchmark/latencyProfiler.ts` + tests. | PR #479 (`766d544`) |
| **BENCH-003** | #444 | P1 | **DONE** | BENCH-001 | High-concurrency multi-agent stress testing & endurance suite (`forge benchmark stress`). | `packages/forge-core/src/benchmark/stressSuite.ts` + tests. | PR #480 (`9d94096`) |

---

## M14: Workspace Isolation and Concurrency (GitHub Milestone #25 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **PAR-001** | #445 | P0 | **DONE** | M13 | Policy-governed concurrency controller and resource budget limiter (`forge concurrency status`). | `packages/forge-core/src/workspace/concurrencyController.ts` + tests. | PR #481 (`4cc7bdf`) |
| **PAR-002** | #446 | P0 | **DONE** | PAR-001 | Multi-agent git worktree isolation manager and temp directory sandboxing (`forge worktree list`). | `packages/forge-core/src/workspace/worktreeIsolationManager.ts` + tests. | PR #482 (`3613e31`) |
| **AGENT-033** | #433 | P1 | **DONE** | PAR-001 | Subagent capability quarantine and lease renewal coordinator (`forge context quarantine-eval`). | `packages/forge-core/src/core/subagentQuarantine.ts` + tests. | PR #483 (`d11a9c1`) |
| **POLISH-001** | #440 | P1 | **DONE** | PAR-002 | Multi-repository workspace management and cross-repo coordination (`forge projects multi-repo`). | `packages/forge-core/src/workspace/multiRepoManager.ts` + IPC/UI wiring. | PR #484 (`706d78b`) |

---

## M15: Workflow DSL and Distributed Cloud Replication (GitHub Milestone #26 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **COMP-001** | #447 | P0 | **DONE** | M14 | Human-editable declarative YAML workflow DSL schema parser & validator (`forge workflows parse-dsl`). | `packages/forge-core/src/workflows/workflowDslParser.ts` + tests. | PR #485 (`8b249b6`) |
| **COMP-002** | #448 | P1 | **DONE** | COMP-001 | Parameterized reusable sub-workflow DAG template compiler (`forge workflows compile-nested`). | `packages/forge-core/src/workflows/subworkflowCompiler.ts` + tests. | PR #486 (`92c08c2`) |
| **UI-001** | #439 | P1 | **DONE** | COMP-001 | Visual drag-and-drop workflow graph composition canvas in desktop UI. | `packages/forge-desktop/src/renderer/src/app/workflow/WorkflowCanvas.tsx`. | PR #487 (`25bc88c`) |
| **POLISH-002** | #441 | P1 | **DONE** | M14 | Cloud synchronization and team state replication backplanes (`forge sync reconcile`). | `packages/forge-core/src/sync/cloudReplicationBackplane.ts` + tests. | PR #488 (`cfb0f4c`) |

---

## M16: Modular Monorepo Workspace Refactoring (GitHub Milestone #27 — Closed)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ARCH-001** | #449, #450 | P0 | **DONE** | ADR-008 | Configure root npm/pnpm workspace infrastructure and `@forge/*` path aliases. | Root `package.json` workspaces & `tsconfig.*`. | PR #456 (`7328df8`) |
| **ARCH-002** | #451 | P0 | **DONE** | ARCH-001 | Extract pure domain, views, and typed IPC into `@forge/shared`. | `packages/forge-shared/` (zero Node/Electron imports). | PR #457 (`51edde2`) |
| **ARCH-003** | #452 | P0 | **DONE** | ARCH-002 | Extract agent runtime contracts and PTY process hosting into `@forge/runtimes`. | `packages/forge-runtimes/`. | PR #458 (`a017e5c`) |
| **ARCH-004 / 007** | #453, #462 | P0 | **DONE** | ARCH-003 | Physically migrate headless core subsystems into `@forge/core`. | `packages/forge-core/`. | PR #459, PR #465 |
| **ARCH-005 / 008** | #454, #463 | P0 | **DONE** | ARCH-004 | Physically migrate standalone CLI executable & subcommands into `@forge/cli`. | `packages/forge-cli/`. | PR #460, PR #466 |
| **ARCH-006 / 009** | #455, #464 | P0 | **DONE** | ARCH-005 | Physically migrate Electron main, preload bridge & React 19 UI into `@forge/desktop` and retire `src/`. | `packages/forge-desktop/` (`src/` retired). | PR #461, PR #467 (`5ebeaf0`) |

---

## M17: Centralized Design System and Thread-Native Orchestration UI (GitHub Milestone #28 — Active)

| ID | Issue | Priority | Status | Depends On | Description | Target Evidence | Implementation PR |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **M17-P1A** | #491 | P0 | **DONE** | ADR-008 | Extract centralized `@forge/ui` package, semantic tokens (`tokens.css`), CSS layers, spacing/typography scale, and semantic `lucide-react` icon registry. | `packages/forge-ui/src/` + tests. | PR #498 (`c157b58`) |
| **M17-P1B** | #492 | P0 | **DONE** | M17-P1A | Build accessible `@base-ui/react` headless primitives library (`Button`, `IconButton`, `DropdownMenu`, `ContextMenu`, `Collapsible`, `List`, `Tabs`, `Panel`, `Toolbar`, `Dialog`, `Drawer`, `Toast`). | `packages/forge-ui/src/primitives/` + `primitives.test.tsx`. | PR #499 (`512600a`) |
| **M17-P2** | #493 | P1 | **DONE** | M17-P1B | Unify topbar Project Switcher (`+ New project` + `Project settings`) inside `StatusStrip` and remove standalone `Questions` & `Decisions` links from `Sidebar`. | `StatusStrip.tsx`, `Sidebar.tsx`, `routes.ts` + tests. | PR #500 (`0599101`) |
| **M17-P3A** | #494 | P0 | **DONE** | M17-P2 | Build continuous chronological thread timeline uniting planning, tool calls, reasoning blocks, and live execution streams inside `WorkflowPage`. | `packages/forge-desktop/src/renderer/src/app/workflow/thread/` + `threadProjection.test.ts`. | PR #501 (`8d58a13`) |
| **M17-P3B** | #495 | P0 | **DONE** | M17-P3A | Embed interactive Q&A cards (`AWAITING_USER`), architectural decision lock cards (`Axiom A4`), and plan approval gates inline within the thread. | `ThreadContainer.tsx`, `ThreadContainer.test.tsx`. | PR #502 (`23f5fbd`) |
| **M17-P4** | #496 | P0 | **DONE** | M17-P3B | Promote global top-right execution drawer (`RightOverviewPanel`, `DrawerPlanView` for `planning.md`, `DrawerGitView` + `git:stage`/`unstage`/`commit`). | `Shell.tsx`, `DrawerPlanView.tsx`, `DrawerGitView.tsx`, `RightOverviewPanel.test.tsx`. | PR #503 (`34b85d9`) |
| **M17-P5** | #497 | P1 | **IN-PROGRESS** | M17-P4 | Complete desktop page/viewer migration onto `@forge/ui`, extend `check:ui`, expand Playwright E2E (`e2e/app.spec.ts`), and synchronize docs & `ADR-009`. | `Overview.tsx`, `ChangesPage.tsx`, `scripts/ui-check.cjs`, `e2e/app.spec.ts`, `ADR-009`. | Branch `feat/m17-phase-5-migration-verification-docs` |
