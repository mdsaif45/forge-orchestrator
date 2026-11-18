# Current State & Capability Verification

**Status:** IMPLEMENTED
**Authority:** Implementation truth (see [documentation-policy.md](../meta/documentation-policy.md))
**Last Updated:** 2026-11-18
**Baseline:** `main` @ `b606e8a` (PR #259 merged)
**Verification Baseline:** [verification-baseline.md](verification-baseline.md)
**Related Roadmap:** [roadmap.md](../roadmap/roadmap.md)

This document answers one question: **what does Forge actually do today?**

It is implementation truth, not planning truth. It cannot override an accepted
architecture or a frozen contract — where they disagree, the discrepancy is a defect
to be recorded, not a silent edit. Every row below cites the code path and the test
file that demonstrates it.

---

## 1. Status vocabulary

| Status | Meaning |
| :--- | :--- |
| `VERIFIED` | Implemented on `main` and demonstrated by a passing automated test named in the Evidence column. |
| `IMPLEMENTED` | Code exists on `main`, but no automated test pins the specific behaviour claimed. |
| `PARTIAL` | Some part exists on `main`; the rest is open. The gap is stated explicitly. |
| `PLANNED` | No implementation on `main`. Types or scaffolding may exist. |
| `DEFERRED` | Intentionally postponed — see [deferred.md](../roadmap/deferred.md). |
| `SUPERSEDED` | Replaced by a different approach; kept for traceability. |

Work living only on an unmerged branch is **not** counted as implemented here. Branch
state is planning truth and belongs in the roadmap, not in this document.

---

## 2. Evidence-based capability matrix

All test counts are per-file assertion counts measured with
`vitest run` at the baseline commit (`7b91d67` + branch `feat/verify-003-adversarial-verifier`).

### 2.1 Headless core & CLI

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Engine boots without Electron | Headless daemon capability | IMPLEMENTED | VERIFIED | Core kernel boots and creates services without GUI | `src/main/core/forgeCore.ts` | `src/main/core/forgeCore.test.ts` (4) | CORE-001 |
| Custom data directory (`--data-dir`) | Relocatable storage root | IMPLEMENTED | VERIFIED | Data directory resolved and isolated | `src/main/core/forgeCore.ts` | `src/main/core/forgeCore.test.ts` (4) | CORE-001 |
| Native in-process agent task loop | Autonomous execution turn loop | IMPLEMENTED | VERIFIED | Executes tool turns, tracks diffs, evaluates criteria, and persists evidence | `src/main/core/taskRunner.ts` | `src/main/core/taskRunner.test.ts` (8) | AGENT-001, CRIT-001 |
| Standalone CLI entrypoint | Headless binary interface | IMPLEMENTED | VERIFIED | `run`, `status`, `models`, `runs`, and `artifacts` commands execute cleanly | `bin/forge.ts`, `src/main/cli.ts` | `src/main/cli.test.ts` (8) | CLI-001 |
| Project-scoped run listing | Filtered historical execution query | IMPLEMENTED | VERIFIED | `forge runs` scopes to repository by default, supports `--status`, `--limit`, and `--all` | `src/main/cli.ts` | `src/main/cli.test.ts` (8) | CLI-001 |
| Windowed artifact CLI inspection | Streaming chunk inspector | IMPLEMENTED | VERIFIED | `forge artifacts` slices byte windows from disk with binary hex / UTF-8 fallback | `src/main/cli.ts` | `src/main/cli.test.ts` (8) | ARTIFACT-001 |
| NDJSON event stream (`--json`) | Machine-readable streaming output | IMPLEMENTED | VERIFIED | Emits parseable NDJSON lines for CI / automated consumers | `src/main/cli.ts` | `src/main/cli.test.ts` (8) | CLI-001 |
| Process-tree termination & orphan tracking | Clean child process lifecycle | IMPLEMENTED | VERIFIED | Process trees killed recursively; orphans reaped across restarts | `src/main/process/processManager.ts`, `orphans.ts` | `src/main/process/process.test.ts` (40) | CORE-001 |
| Secret redaction in captured output | No credentials leaked in logs/prompts | IMPLEMENTED | VERIFIED | Sensitive tokens and keys replaced with redacted markers | `src/main/process/redact.ts` | `src/main/process/process.test.ts` (40) | CORE-001 |
| Local Ollama discovery & auto-selection | Auto-configure coding model | IMPLEMENTED | VERIFIED | `forge models auto` selects best tool-capable coding model; `models list` reports local Ollama daemon state | `src/main/cli.ts` | `src/main/cli.test.ts` (11) | MODEL-001 |
| Rich Ollama scan IPC response | Structured capability discovery | IMPLEMENTED | VERIFIED | `provider:scanModels` returns parameter size, quantization, family, and tool capabilities | `src/main/ipc/handlers.ts`, `src/shared/ipc.ts` | `scripts/router-check.mjs` (7) | MODEL-002 |
| Streaming artifact ingestion | Zero in-memory buffer spike for runs | IMPLEMENTED | VERIFIED | Streams raw agent response chunks via `writeArtifactStream` concurrently with execution | `src/main/core/taskRunner.ts` | `src/main/core/taskRunner.test.ts` (11) | AGENT-002 |
| Security sandboxing & timeout budget | Enforce workspace boundary & duration | IMPLEMENTED | VERIFIED | Aborts runs exceeding `maxExecutionTimeMs` (A5) and blocks out-of-workspace execution (A7) | `src/main/core/taskRunner.ts` | `src/main/core/taskRunner.test.ts` (11) | CORE-004 |
| Headless workflow control CLI | Terminal execution steering | IMPLEMENTED | VERIFIED | `forge workflows run`, `resume`, `cancel`, and `approve` drive execution directly | `src/main/cli.ts` | `src/main/cli.test.ts` (16) | WORK-007 |
| Headless workflow initialization CLI | CLI workflow instance generation | IMPLEMENTED | VERIFIED | `forge workflows init` creates workflow instances directly from templates with CLI arguments | `src/main/cli.ts` | `src/main/cli.test.ts` (16) | WORK-008 |
| Artifact content grep CLI | Search inside run artifacts | IMPLEMENTED | VERIFIED | `forge artifacts grep <runId> <pattern>` performs bounded regex and case-insensitive searches | `src/main/cli.ts` | `src/main/cli.test.ts` (16) | ARTIFACT-002 |
| Runtime health & version probing | Diagnostic runtime discovery | IMPLEMENTED | VERIFIED | `runtime:list` IPC and `forge runtimes list` report binary resolution, version, and health | `src/main/runtimes/probe.ts`, `src/main/cli.ts`, `src/main/ipc/handlers.ts` | `src/main/runtimes/probe.test.ts` (4), `src/main/cli.test.ts` (16) | RUNTIME-001 |
| Configuration inspection & management | Command-line .forgerc configuration | IMPLEMENTED | VERIFIED | `forge config [list|get|set]` inspects and modifies configuration keys safely | `src/main/config/forgeConfig.ts`, `src/main/cli.ts` | `src/main/config/forgeConfig.test.ts` (11), `src/main/cli.test.ts` (19) | CONFIG-002 |
| Database maintenance & compaction | SQLite storage compaction & stats | IMPLEMENTED | VERIFIED | `forge db [stats|vacuum]` reports table statistics and executes SQLite VACUUM and optimize | `src/main/db/maintenance.ts`, `src/main/cli.ts` | `src/main/db/maintenance.test.ts` (2), `src/main/cli.test.ts` (19) | STATE-002 |
| Static DAG validation & dry-run | Offline graph topology inspection | IMPLEMENTED | VERIFIED | `forge workflows validate` checks acyclicity, reachability, terminal sinks, and loop bounds | `src/main/workflows/validation.ts`, `src/main/cli.ts` | `src/main/workflows/validation.test.ts` (4), `src/main/cli.test.ts` (19) | WORK-009 |
| Prompt context packet inspection | Inspect compiled step prompt artifacts | IMPLEMENTED | VERIFIED | `forge context inspect <runId> [stepId]` extracts and formats prompt-packet artifacts | `src/main/cli.ts` | `src/main/cli.test.ts` (19) | PROMPT-002 |
| Bounded process log rotation | Prevent disk exhaustion from agent logs | IMPLEMENTED | VERIFIED | `ProcessManager` rotates logs to `.log.1` when `maxLogBytes` ceiling is exceeded (A5) | `src/main/process/processManager.ts` | `src/main/process/process.test.ts` (42) | LOG-002 |
| Runtime execution benchmark probe | End-to-end execution test for runtimes | IMPLEMENTED | VERIFIED | `forge runtimes test <runtimeId>` validates execution responsiveness and measures roundtrip latency | `src/main/runtimes/probe.ts`, `src/main/cli.ts` | `src/main/runtimes/probe.test.ts` (8), `src/main/cli.test.ts` (19) | RUNTIME-002 |
| Extended declarative criteria evaluators | Custom guardrail completion rules | IMPLEMENTED | VERIFIED | Evaluates `file-forbidden` (A7), `max-diff-lines` (A5), and `artifact-regex` rules against physical evidence | `src/shared/domain/completion.ts` | `src/shared/domain/completion.test.ts` (33) | CRIT-002 |
| Workflow DAG execution planning & ASCII visualization | Static topological stage planning & diagram generation | IMPLEMENTED | VERIFIED | `forge workflows plan` calculates topological stages, role ceilings, feedback edges, and ASCII flow diagrams | `src/main/workflows/planner.ts`, `src/main/cli.ts` | `src/main/workflows/planner.test.ts` (4), `src/main/cli.test.ts` (24) | WORK-010 |
| Physical changeset diff inspection | Structured git diff metrics & scope auditing | IMPLEMENTED | VERIFIED | `forge diff` parses unified git diff patches, line additions/deletions, binary detection, and path scope bounds (A7) | `src/main/evidence/diffInspector.ts`, `src/main/cli.ts` | `src/main/evidence/diffInspector.test.ts` (3), `src/main/cli.test.ts` (24) | DIFF-001 |
| Cryptographic artifact checksum audit | Physical disk integrity & tamper detection | IMPLEMENTED | VERIFIED | `forge artifacts verify` audits physical SHA-256 disk bytes and size against SQLite artifact records (A3) | `src/main/evidence/checksumAudit.ts`, `src/main/cli.ts` | `src/main/evidence/checksumAudit.test.ts` (4), `src/main/cli.test.ts` (24) | VERIFY-004 |
| Process watchdog & execution metrics | Child process heartbeat watchdog & resource metrics | IMPLEMENTED | VERIFIED | `ProcessManager` tracks activity heartbeats (`heartbeatTimeoutMs`), runtime durations, and buffers process metrics via `forge processes list` | `src/main/process/processManager.ts`, `src/main/cli.ts` | `src/main/process/processWatchdog.test.ts` (2), `src/main/cli.test.ts` (24) | PROCESS-003 |
| Multi-environment configuration profiles | Profile management & switching | IMPLEMENTED | VERIFIED | `forge config profile [list|use|show]` configures and switches environment-specific profiles in .forgerc | `src/main/config/forgeConfig.ts`, `src/main/cli.ts` | `src/main/config/forgeConfigProfile.test.ts` (7), `src/main/cli.test.ts` (24) | CONFIG-002 |
| Workflow execution profiling & bottleneck detection | Latency profiling and critical path analysis | IMPLEMENTED | VERIFIED | `forge workflows profile <runId>` computes step durations, bottleneck nodes, and iteration cycles | `src/main/workflows/profiler.ts`, `src/main/cli.ts` | `src/main/workflows/profiler.test.ts` (3), `src/main/cli.test.ts` (29) | WORK-011 |
| Multi-stage verification pipeline runner | Sequential verification pipeline with short-circuiting | IMPLEMENTED | VERIFIED | `forge verify pipeline <config>` executes verification stages and fails closed on first error (A2) | `src/main/evidence/verificationPipeline.ts`, `src/main/cli.ts` | `src/main/evidence/verificationPipeline.test.ts` (4), `src/main/cli.test.ts` (29) | VERIFY-005 |
| Changeset reverse patch rollback | Safe atomic patch reversal | IMPLEMENTED | VERIFIED | `forge diff revert <runId>` generates reverse patch, validates via `git apply --check`, and restores files | `src/main/evidence/patchRollback.ts`, `src/main/cli.ts` | `src/main/evidence/patchRollback.test.ts` (4), `src/main/cli.test.ts` (29) | DIFF-002 |
| Self-contained execution archive exporter | Audit-proof execution bundle export | IMPLEMENTED | VERIFIED | `forge artifacts export <runId>` creates JSON/directory archive with cryptographic SHA-256 manifest | `src/main/artifacts/artifactExporter.ts`, `src/main/cli.ts` | `src/main/artifacts/artifactExporter.test.ts` (3), `src/main/cli.test.ts` (29) | ARTIFACT-003 |
| Environment health & diagnostic doctor | Environment, SQLite, and config auditor | IMPLEMENTED | VERIFIED | `forge config doctor` verifies .forgerc, SQLite integrity_check/foreign_key_check, git, and provider reachability | `src/main/config/configDoctor.ts`, `src/main/cli.ts` | `src/main/config/configDoctor.test.ts` (2), `src/main/cli.test.ts` (29) | CONFIG-003 |

### 2.2 State, storage & events

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| SQLite run & step records | Durable relational run metadata | IMPLEMENTED | VERIFIED | Runs and steps inserted, updated, and queried in SQLite | `src/main/db/runStore.ts` | `src/main/db/runStore.test.ts` (4) | STATE-001 |
| Append-only run event ledger | Immutable sequential audit log | IMPLEMENTED | VERIFIED | Monotonic sequence-numbered events stored per run | `src/main/db/eventStore.ts`, `runStore.ts` | `src/main/db/eventStore.test.ts` (24) | STATE-001 |
| Artifact metadata index | Relational index of disk blobs | IMPLEMENTED | VERIFIED | Artifact metadata queried by runId and stepId | `src/main/db/artifactStore.ts` | `src/main/db/artifactStore.test.ts` (1) | STATE-001 |
| Filesystem artifact blobs + SHA-256 | Dual-tier filesystem storage | IMPLEMENTED | VERIFIED | Content written under `<dataDir>/artifacts/<runId>/` with SHA-256 integrity | `src/main/artifacts/artifactService.ts` | `src/main/artifacts/artifactService.test.ts` (8) | STATE-001 |
| Path-traversal containment on artifacts | Sandboxed file containment | IMPLEMENTED | VERIFIED | Directory traversal attempts (`../`) throw containment error | `src/main/artifacts/artifactService.ts` | `src/main/artifacts/artifactService.test.ts` (8) | STATE-001 |
| Windowed byte-offset artifact reads | OOM-safe log stream chunk reader | IMPLEMENTED | VERIFIED | Byte slices read positional from disk without full-file buffering | `src/main/artifacts/artifactService.ts` | `src/main/artifacts/artifactService.test.ts` (8) | ARTIFACT-001 |
| Schema migrations | Versioned schema evolution | IMPLEMENTED | VERIFIED | Drizzle-managed migrations run on startup before DB use | `src/main/db/migrate.ts`, `schema.ts` | `src/main/db/db.test.ts` (16) | STATE-001 |
| Physical git diff vs. agent claims | Ground-truth diff reconciliation | IMPLEMENTED | VERIFIED | Discrepancies logged when physical git diff differs from report | `src/shared/domain/reconcile.ts` | `src/main/evidence/reconciliation.integration.test.ts` (12) | EVIDENCE-001, VERIFY-001 |
| Out-of-scope / untracked file detection | Path boundary enforcement | IMPLEMENTED | VERIFIED | Untracked and out-of-scope modifications halt with `halted` status (exit 2) and record policy error | `src/shared/domain/reconcile.ts`, `src/main/git/gitService.ts`, `src/main/core/taskRunner.ts` | `src/main/evidence/reconciliation.integration.test.ts` (12), `src/main/core/taskRunner.test.ts` (8), `src/main/git/gitService.test.ts` (47) | EVIDENCE-001, VERIFY-001 |
| Independent build & test command runner | Objective command verification | IMPLEMENTED | VERIFIED | Commands executed via child processes; exit codes and outputs captured | `src/main/evidence/verifier.ts` | `src/main/evidence/verifier.test.ts` (14) | VERIFY-002 |
| Test-output parsing into structured results | Structured test counts | IMPLEMENTED | VERIFIED | Vitest, Jest, and Pytest outputs parsed into passed/failed numbers | `src/main/evidence/testParsers.ts` | `src/main/evidence/testParsers.test.ts` (13) | VERIFY-002 |
| Completion-criteria evaluation engine | Objective completion assessment | IMPLEMENTED | VERIFIED | 7 criterion kinds evaluated with fail-outranks-unknown precedence; persisted to SQLite | `src/shared/domain/criterion.ts`, `src/shared/domain/completion.ts`, `src/main/core/taskRunner.ts` | `src/shared/domain/completion.test.ts` (25), `src/main/core/taskRunner.test.ts` (8) | CRIT-001 |
| ChangeSet snapshotting | Physical diff record per step | IMPLEMENTED | VERIFIED | Baseline and head diff snapshots stored in `change_sets` table | `src/main/changesets/changeSetService.ts` | `src/main/db/changeSetStore.test.ts` (3) | EVIDENCE-001 |

> Criteria evaluation engine schemas and evaluation functions live in `src/shared/domain/criterion.ts` and `src/shared/domain/completion.ts`, integrated directly into `src/main/core/taskRunner.ts`.

### 2.4 Workflow & orchestration

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Linear workflow state machine with guards | Validated state transitions | IMPLEMENTED | VERIFIED | State machine enforces legal moves, bounds, and terminal rules | `src/main/runtimes/orchestrator.ts` | `src/main/runtimes/orchestrator.test.ts` (31) | CORE-002 |
| Transition table & generated state diagram | Verified state graph docs | IMPLEMENTED | VERIFIED | `npm run check:docs` CI gate ensures `DOMAIN.md` matches code | `src/shared/domain/transitions.ts` | `npm run check:docs` gate | CORE-002 |
| Decision-lock gate before implementation | Human decision approval | IMPLEMENTED | VERIFIED | Transition to implementation blocked if zero locked decisions | `src/main/runtimes/orchestrator.ts` | `src/main/runtimes/orchestrator.test.ts` (31) | CORE-002 |
| `AWAITING_USER` pause for human answers | Human-in-the-loop interjection | IMPLEMENTED | VERIFIED | Workflow pauses on open questions and resumes when answered | `src/main/runtimes/orchestrator.ts` | `src/main/runtimes/orchestrator.test.ts` (31) | CORE-002 |
| Role-capability binding checks | Capability validation | IMPLEMENTED | VERIFIED | Binding rejected if runtime lacks required role capabilities | `src/shared/domain/runtime.ts` | `src/main/runtimes/guards.integration.test.ts` (4) | CORE-002 |
| Multi-agent closed-loop acceptance | Multi-role autonomous execution | IMPLEMENTED | VERIFIED | Complete plan -> implement -> verify -> review loop verified | `src/main/workflows/workflowService.ts` | `src/main/acceptance/mvpAcceptance.test.ts` (3) | MVP-001 |
| Generic DAG graph execution engine | Arbitrary directed workflow graph with branch isolation, routing, and loops | IMPLEMENTED | VERIFIED | GraphExecutor executes DAGs with isolated git worktrees (Q-WF-01), fan-in ChangeSet merging, stage controls (run/skip/rerun), bounded loop iterations (A5), durable artifact lineage hydration, pause/recovery stabilization (Batch 1), generic leaf runner (Batch 2), production graph composition factory (Slice 5B-1A), binding role resolution & capability preflight (Slice 5B-1B), gate-scoped human decision authorization (Slice 5B-1C Slice A), and authoritative reviewer routing & crash recovery (Slice 5B-1C Slice B, PR #228). Production execution has been cut over from legacy Orchestrator to WorkflowService → GraphExecutor via createGraphExecutorWithLeafRunner (WORK-006E). | `src/main/workflows/graphExecutor.ts`, `src/main/git/worktreeService.ts`, `src/main/evidence/changeSetMerger.ts`, `src/main/workflows/leafRunner.ts`, `src/main/workflows/graphFactory.ts`, `src/main/workflows/workflowService.ts` | `src/main/workflows/graphExecutor.test.ts` (116), `graphLifecycle.test.ts` (28), `leafRunner.test.ts` (15), `graphFactory.test.ts` (18), `roleResolution.test.ts` (14), `reviewerRouting.test.ts` (43), `workflowService.test.ts` (6) | WORK-001..006 |

### 2.5 Agent runtimes

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `IAgentRuntime` abstraction | Provider-agnostic agent interface | IMPLEMENTED | VERIFIED | Canonical start/send/events/status/cancel/dispose interface | `src/shared/domain/runtime.ts` | `src/main/runtimes/runtimes.test.ts` (30) | CORE-001 |
| Native agent runtime | In-process LLM agent execution | IMPLEMENTED | VERIFIED | Tool loop and streaming execution with Ollama/OpenAI models | `src/main/runtimes/nativeAgentRuntime.ts` | `src/main/runtimes/nativeAgentRuntime.test.ts` (7) | AGENT-001 |
| Claude CLI adapter | Spawned Claude Code CLI hosting | IMPLEMENTED | VERIFIED | Spawns Claude Code CLI in PTY with automated prompt delivery | `src/main/runtimes/claudeCliRuntime.ts` | `src/main/runtimes/claudeCliRuntime.test.ts` (17) | CORE-001 |
| Antigravity CLI adapter | Spawned Antigravity CLI hosting | IMPLEMENTED | VERIFIED | Spawns Antigravity CLI in ConPTY session with stream observation | `src/main/runtimes/antigravityCliRuntime.ts` | `src/main/runtimes/antigravityCliRuntime.test.ts` (11) | CORE-001 |
| Generic CLI adapter | User-configurable external CLI runner | IMPLEMENTED | VERIFIED | Spawns arbitrary agent CLI with parameterized templates | `src/main/runtimes/genericCliRuntime.ts` | `src/main/runtimes/genericCliRuntime.test.ts` (3) | CORE-001 |
| Pre-launch folder-trust automation | Bypass interactive CLI trust prompts | IMPLEMENTED | VERIFIED | Pre-populates Claude trust database before process spawn | `src/main/runtimes/claudeTrust.ts` | `src/main/runtimes/claudeTrust.test.ts` (8) | CORE-001 |
| PTY process hosting (ConPTY / node-pty) | Full interactive terminal emulation | IMPLEMENTED | VERIFIED | Spawns child processes in Windows ConPTY or Linux pseudo-terminal | `src/main/runtimes/ptyProcessRunner.ts` | `src/main/runtimes/ptyProcessRunner.test.ts` (12) | CORE-001 |
| Terminal session registry | Multi-session terminal multiplexer | IMPLEMENTED | VERIFIED | Named terminal sessions registered, attached, and multiplexed | `src/main/terminal/sessionRegistry.ts` | `src/main/terminal/sessionRegistry.test.ts` (10) | CORE-001 |
| Account isolation per runtime | Multi-account isolation | IMPLEMENTED | VERIFIED | Separate user profiles / credentials isolated per session | `src/main/accounts/` | `src/main/runtimes/accountSwitch.integration.test.ts` (1) | CORE-001 |

> The runtime module is `src/main/runtimes/claudeTrust.ts`, and PTY hosting lives in
> `ptyProcessRunner.ts` with session state in `src/main/terminal/`. There is no
> `claudeTrustStore.ts` and no `src/main/runtimes/terminalSession.ts`.

### 2.6 Desktop shell

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Typed IPC contract & router parity | Zero unchecked IPC channels | IMPLEMENTED | VERIFIED | All 70 IPC channels declared with Zod request/response contracts | `src/shared/ipc.ts`, `src/main/ipc/` | `npm run check:router` gate | CORE-002 |
| Windowed artifact IPC streaming | Binary-safe base64 offset reader | IMPLEMENTED | VERIFIED | `getArtifactWindow` transports base64 encoded byte slices over IPC | `src/main/ipc/handlers.ts`, `src/preload/index.ts` | `npm run check:router` gate | ARTIFACT-001 |
| Context-isolated preload bridge | Secure Electron process boundary | IMPLEMENTED | VERIFIED | Preload bridge exposes only typed API methods; contextIsolation enabled | `src/preload/` | `npm run smoke` gate | CORE-002 |
| React renderer & design system | Desktop engineering control plane UI | IMPLEMENTED | VERIFIED | React UI builds, renders views, and passes UI check | `src/renderer/` | `npm run check:ui`, `npm run test:e2e` | CORE-002 |
| Terminal TUI for the CLI | Interactive multi-pane terminal TUI | PLANNED | NOT APPLICABLE | No implementation on `main`; planned for future release | None | None | CLI-004 |

> No terminal TUI exists on `main`: there is no `src/main/tui/` directory and no Ink
> dependency in `package.json`.

---

## 3. Work in flight (planning truth, not implementation truth)

| PR | Branch | State | Scope |
| :--- | :--- | :--- | :--- |
| — | `feat/verify-003-adversarial-verifier` | IN PROGRESS | VERIFY-003 adversarial evidence verifier & artifact integrity hardening |

Nothing on unmerged branches is counted as implemented in §2.

---

## 4. Known open issues

Issue numbers below are carried over from planning documents absorbed into this
restructure. They have **not** been re-verified against the GitHub issue tracker as
part of this documentation pass, and are listed as pointers rather than as confirmed
state — see [Open questions](#5-open-questions).

- `#178` — intermittent Windows git `EBUSY` when concurrent suites create and delete
  temporary git repositories.
- `#183` — stale runtime bindings in the UI can fall back silently instead of
  surfacing an error.
- `#180` — hosted sessions cannot always distinguish provider token exhaustion from a
  hung process.

---

## 5. Open questions

- **Q-CS-01:** The three issue numbers in §4 were inherited from prior planning
  documents. Their current open/closed state is unconfirmed. Resolve by checking the
  tracker and either citing state with a date or removing them.
- **Q-CS-02:** Several subsystems on `main` (`src/main/context/`, `src/main/health/`,
  `src/main/templates/`, `src/main/audit/`) are not yet represented in the capability
  matrix. They are implemented but undocumented at the architecture level.
