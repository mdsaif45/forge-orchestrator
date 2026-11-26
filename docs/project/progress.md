# Forge Development Progress

```
Project:            Forge — AI Engineering Control Plane
Current milestone:  Milestones M0 through M16 100% COMPLETE
Overall status:     All 17 GitHub milestones (M0–M16, IDs #1–#12 and #23–#27) formally closed with zero open issues on main @ cfb0f4c (PR #488 merged).
Last updated:       2026-11-26
Evidence baseline:  main @ cfb0f4c (PR #488 merged)
Active branch:      docs/sync-m12-m16-progress-and-monorepo-truth
```

---

## 1. Progress Line

```
M0  Foundation & Quality Gates         ██████████  DONE        PR #186, PR #209
        ↓
M1  Headless Core                      ██████████  DONE        PR #198, PR #231
        ↓
M2  Native Agent Core                  ██████████  DONE        PR #198, PR #235
        ↓
M3  Forge CLI 1.0 (+ Interactive TUI)  ██████████  DONE        PR #198, PR #232, PR #235, PR #477
        ↓
M4  State, Events & Persistence        ██████████  DONE        PR #203, PR #231
        ↓
M5  Verification & Criteria            ██████████  DONE        PR #204, PR #206, PR #208
        ↓
M6  Generic Workflow Graph             ██████████  DONE        PRs #214–#230 (WORK-006E cutover)
        ↓
M7  Human Control & Steering           ██████████  DONE        PR #230, PR #232, PR #234
        ↓
M8  Extensible Provider Ecosystem      ██████████  DONE        PR #231, PR #233, PR #234
        ↓
M9  Warm Sessions & Speed              ██████████  DONE        PR #232, PR #233
        ↓
M10 Interactive Control Plane          ██████████  DONE        PR #230, PR #233, PR #234
        ↓
M11 Host the Real CLI                  ██████████  DONE        PR #232, PR #234
        ↓
M12 Autonomous Control Plane Hardening ██████████  DONE        PRs #236–#477 (30 issues closed)
        ↓
M13 Empirical Benchmarking & Stress    ██████████  DONE        PR #478 (#442), PR #479 (#443), PR #480 (#444)
        ↓
M14 Workspace Isolation & Concurrency  ██████████  DONE        PR #481 (#445), PR #482 (#446), PR #483 (#433), PR #484 (#440)
        ↓
M15 Workflow DSL, Canvas & Cloud Sync  ██████████  DONE        PR #485 (#447), PR #486 (#448), PR #487 (#439), PR #488 (#441)
        ↓
M16 Modular Monorepo Refactoring       ██████████  DONE        PRs #456–#467 (#449–#464)
```

---

## 2. Milestone Status Summary

| Milestone | Status | Completed Work | In Progress Work | Next Up |
| :--- | :--- | :--- | :--- | :--- |
| **M0 Baseline** | **DONE** | CI matrix, vitest suites, lint/formatting, smoke checks, Windows git EBUSY fix (M0-002), spike #64 closure (M0-003). | — | — |
| **M1 Headless Core** | **DONE** | `createForgeCore` decoupled from Electron; `--data-dir` support; `.forgerc` loader (`CORE-003`). | — | — |
| **M2 Native Agent** | **DONE** | Native tool loop (`taskRunner.ts`, `agentLoop.ts`), six built-in tools, streaming artifacts, concurrent read-only tools, Ollama probing. | — | — |
| **M3 Forge CLI** | **DONE** | Standalone `bin/forge.ts`, NDJSON stream, exit codes 0/1/2, live tool timeline (`CLI-005`), headless workflows (`CLI-006`), interactive terminal TUI (`CLI-004`, PR #477). | — | — |
| **M4 State & Storage** | **DONE** | SQLite `RunStore`/`EventStore`/`ArtifactStore`, `ArtifactService` (`readWindow()`), typed IPC streaming, event replay. | — | — |
| **M5 Verification** | **DONE** | Physical diff reconciliation, `ChangeSet` snapshotting, completion-criteria evaluation, independent verifier, adversarial auditing (`VERIFY-003`). | — | — |
| **M6 Workflow Graph** | **DONE** | Generic Workflow Graph engine (`GraphExecutor`), branch worktrees, fan-in merge, stage controls, bounded loops, artifact lineage, `WorkflowService` cutover. | — | — |
| **M7 Human Control** | **DONE** | Real human approval gate (`HUMAN-001`), live PTY interjection (`HUMAN-002`), UI xterm attachment (`HUMAN-004`), ADR-005 (`HUMAN-005`). | — | — |
| **M8 Provider Ecosystem** | **DONE** | Custom CLI adapter config (`RUNTIME-001`), Antigravity PTY session (`RUNTIME-002`), provider quota detection (`RUNTIME-003`). | — | — |
| **M9 Warm Sessions** | **DONE** | Resumable sessions (`WARM-001`), Claude & Antigravity session resume (`WARM-002`), stage benchmark (`WARM-003`). | — | — |
| **M10 Interactive Control** | **DONE** | Blocking human approval gate (#163), stage rerun & skip controls (#164), mid-run user interjections (#161, #171). | — | — |
| **M11 Host the Real CLI** | **DONE** | Real CLI hosting in ConPTY sessions (#167, #168), terminal pane attachment (#170), legacy stdout parser removal (#172). | — | — |
| **M12 Autonomous Control Plane** | **DONE** | 30 reliability/security/DB/workflow/evidence hardening features across `@forge/core`, `@forge/cli`, `@forge/runtimes` plus interactive TUI (`CLI-004`, PR #477). | — | — |
| **M13 Empirical Benchmarking** | **DONE** | Empirical benchmark harness (`BENCH-001`, PR #478), latency profiler (`BENCH-002`, PR #479), concurrency endurance suite (`BENCH-003`, PR #480). | — | — |
| **M14 Workspace Isolation & Concurrency** | **DONE** | Policy concurrency controller (`PAR-001`, PR #481), multi-agent worktree isolation (`PAR-002`, PR #482), subagent quarantine (`AGENT-033`, PR #483), multi-repo management (`POLISH-001`, PR #484). | — | — |
| **M15 Workflow DSL & Cloud Sync** | **DONE** | YAML workflow DSL parser (`COMP-001`, PR #485), sub-workflow compiler (`COMP-002`, PR #486), drag-and-drop canvas (`UI-001`, PR #487), cloud replication backplane (`POLISH-002`, PR #488). | — | — |
| **M16 Modular Monorepo Refactoring** | **DONE** | Full migration out of `src/` into `@forge/shared`, `@forge/core`, `@forge/runtimes`, `@forge/cli`, `@forge/desktop` per ADR-008 (`ARCH-001..009`, PRs #456–#467). | — | — |

---

## 3. Major Slice History & Merged PRs (Reverse Chronological)

### 2026-11-26: M15 Completed — DSL, Canvas & Cloud Sync (#447, #448, #439, #441)
- **PR #488 (`cfb0f4c`):** `POLISH-002` — Cloud synchronization and team state replication backplanes (`#441`).
- **PR #487 (`25bc88c`):** `UI-001` — Visual drag-and-drop workflow graph composition canvas (`#439`).
- **PR #486 (`92c08c2`):** `COMP-002` — Parameterized reusable sub-workflow DAG template compiler (`#448`).
- **PR #485 (`8b249b6`):** `COMP-001` — Human-editable declarative workflow graph schema parser and validator (`#447`).

### 2026-11-25 – 2026-11-26: M14 Completed — Workspace Isolation, Quarantine & Multi-Repo (#445, #446, #433, #440)
- **PR #484 (`706d78b`):** `POLISH-001` — Multi-repository workspace management and cross-repo coordination (`#440`).
- **PR #483 (`d11a9c1`):** `AGENT-033` — Subagent capability quarantine and lease renewal coordinator (`#433`).
- **PR #482 (`3613e31`):** `PAR-002` — Multi-agent git worktree isolation manager and temp directory sandboxing (`#446`).
- **PR #481 (`4cc7bdf`):** `PAR-001` — Policy-governed concurrency controller and resource budget limiter (`#445`).

### 2026-11-25: M13 Completed — Empirical Benchmarking & Endurance Hardening (#442, #443, #444)
- **PR #480 (`9d94096`):** `BENCH-003` — High-concurrency multi-agent stress testing and endurance verification suite (`#444`).
- **PR #479 (`766d544`):** `BENCH-002` — Stage wall-clock latency profiler and comparative performance auditor (`#443`).
- **PR #478 (`8712068`):** `BENCH-001` — Empirical multi-agent reproducible benchmark harness (`#442`).

### 2026-11-24 – 2026-11-25: M12 Final Hardening & CLI-004 TUI (#428–#438)
- **PR #477 (`5008599`):** `CLI-004` — Interactive terminal TUI for live CLI monitoring and diff rendering (`#438`).
- **PRs #468–#476 (`893dd23`..`17f56e1`):** `AGENT-032`, `WORK-039`, `EVIDENCE-027`, `STATE-029`, `CONFIG-030`, `WORK-040`, `EVIDENCE-028`, `STATE-030`, `CONFIG-031`.

### 2026-11-23 – 2026-11-24: M16 Completed — Modular Monorepo Refactoring (#449–#464)
- **PRs #456–#461 & #465–#467 (`7328df8`..`5ebeaf0`):** Migrated legacy `src/` into `@forge/shared`, `@forge/runtimes`, `@forge/core`, `@forge/cli`, and `@forge/desktop`, then retired `src/`.

### 2026-11-21: M12 Earlier Clusters (`#368–#372` and prior PRs #236–#427)
- **Branch:** `feat/m1-m6-scratchpad-barrier-symbol-savepoint-rotation`
- **Delivered:**
  - `AGENT-022`: Agent scratchpad working memory buffer and LRU eviction pruner with `forge context scratchpad`.
  - `WORK-029`: Workflow step dependency barrier and fan-in synchronization gate with `forge workflows barrier-check`.
  - `EVIDENCE-017`: Changeset AST-aware critical symbol dependency trace auditor with `forge diff symbols`.
  - `STATE-019`: SQLite transaction savepoint stack and nested rollback manager with `forge db savepoint-stack`.
  - `CONFIG-020`: Dynamic secret rotation and vault key lifetime supervisor with `forge config secret-audit`.
  - Addresses GitHub issues #368, #369, #370, #371, #372.

### 2026-11-21: PR #367 merged (`74bccbd`) — M1/M2/M4/M5/M6 Goal Decomposition, Retry Escalation Router, Semantic Diff Chunker, Shard Partition Router, and Config Hot-Reload Watcher
- **Title:** `feat(core,workflows,evidence,db,config,cli): goal decomposition planner, retry escalation router, semantic diff chunker, shard router, and config reload watcher (#362, #363, #364, #365, #366)`
- **Delivered:**
  - `AGENT-021`: Agent goal decomposition planner and subtask prerequisite DAG synthesizer with `forge context decompose`.
  - `WORK-028`: Workflow step retry backoff scheduler and dead-letter escalation router with `forge workflows retry-schedule`.
  - `EVIDENCE-016`: Changeset semantic chunking and ast-aware diff summary extractor with `forge diff semantic`.
  - `STATE-018`: SQLite multi-tenant database partitioning and shard router with `forge db shard`.
  - `CONFIG-019`: Dynamic configuration hot-reload watcher and drift notifier with `forge config reload-check`.
  - Closed GitHub issues #362, #363, #364, #365, #366.

### 2026-11-21: PR #361 merged (`8290a72`) — M1/M2/M4/M5/M6 Tool Prefetch, Fork-Join, Impact Selector, Journal Diff Auditor, and Deprecation Transformer
- **Title:** `feat(core,workflows,evidence,db,config,cli): tool prefetch scheduler, fork-join orchestrator, change impact selector, journal diff auditor, and deprecation transformer (#356, #357, #358, #359, #360)`
- **Delivered:**
  - `AGENT-020`: Tool invocation speculative prefetch and execution pipeline scheduler with `forge context prefetch`.
  - `WORK-027`: Workflow dynamic fork-join fan-out subflow orchestrator with `forge workflows fork-join`.
  - `EVIDENCE-015`: Source code change impact and affected test suite selector with `forge verify impact`.
  - `STATE-017`: SQLite point-in-time transaction journal differential auditor with `forge db journal-diff`.
  - `CONFIG-018`: Configuration schema deprecation transformer and dynamic rule migrator with `forge config deprecations`.

### 2026-11-21: PR #355 merged (`173ad83`) — M1/M2/M4/M5/M6 Tool Retry, Step SLA, Provenance Attestation, Query Analyzer, and Config Inheritance
- **Title:** `feat(core,workflows,evidence,db,config,cli): tool retry supervisor, step sla monitor, provenance attestation, query analyzer, and config inheritance (#350, #351, #352, #353, #354)`
- **Delivered:**
  - `AGENT-019`: Exponential backoff tool execution retry supervisor with `forge context retry-tool`.
  - `WORK-026`: Workflow step SLA latency monitor and degradation detector with `forge workflows sla`.
  - `EVIDENCE-014`: Cryptographic provenance attestation generator and integrity verifier with `forge verify attestation`.
  - `STATE-016`: SQLite AST query analyzer and missing index advisor with `forge db explain`.
  - `CONFIG-017`: Hierarchical configuration inheritance resolver with `forge config resolve`.
  - Closed GitHub issues #350, #351, #352, #353, #354.

### 2026-11-21: PR #349 merged (`ba73735`) — M1/M2/M4/M5/M6 Tool Coalescer, Wave Planner, Unified Test Parser, DB Query Sandbox, and Tool Policy Guard
- **Title:** `feat(core,workflows,evidence,db,config,cli): tool coalescer, wave planner, test report parser, db query sandbox, and tool policy guard (#344, #345, #346, #347, #348)`
- **Delivered:**
  - `AGENT-018`: Multi-turn tool call result coalescer and duplicate observation deduplication supervisor with `forge context coalesce`.
  - `WORK-025`: Workflow step dependency topological levelizer and execution wave planner with `forge workflows waves`.
  - `EVIDENCE-013`: JUnit XML and TAP test results structured parser and assertion matrix generator with `forge verify test-report`.
  - `STATE-015`: SQLite read-only query sandbox and safe analytical statement validator with `forge db query`.
  - `CONFIG-016`: Workspace tool execution sandbox policy auditor and permission validator with `forge config policy-tool`.
  - Closed GitHub issues #344, #345, #346, #347, #348.

### 2026-11-21: PR #343 merged (`b86c86c`) — M1/M2/M4/M5/M6 Conversation Compressor, Step Preconditions, Log Sanitizer, Schema Migrations, and Sensitive Data Redactor
- **Title:** `feat(core,workflows,evidence,db,config,cli): conversation compressor, preflight preconditions, log sanitizer, schema migrations, and sensitive redactor (#338, #339, #340, #341, #342)`
- **Delivered:**
  - `AGENT-017`: Long-horizon conversation turn compressor and semantic anchor preservation with `forge context compress`.
  - `WORK-024`: Workflow step preflight condition evaluator and environment gate with `forge workflows preflight`.
  - `EVIDENCE-012`: Execution log ANSI stripper and structured compiler/linter diagnostic failure extractor with `forge verify diagnostics`.
  - `STATE-014`: Declarative SQLite schema migration runner and hash ledger with `forge db migrate [status|validate|apply]`.
  - `CONFIG-015`: Recursive sensitive token scanner and credential redactor with `forge config sanitize`.
  - Closed GitHub issues #338, #339, #340, #341, #342.

### 2026-11-21: PR #337 merged (`087c102`) — M1/M2/M4/M5/M6 Context Budget, Step Semaphore, Cycle Auditor, DB Search, and Boundary Guard
- **Title:** `feat(core,workflows,evidence,db,config,cli): context budget, step semaphore, cycle auditor, db search, and boundary guard (#332, #333, #334, #335, #336)`
- **Delivered:**
  - `AGENT-016`: Prompt context window budgeting, output headroom reservation, and priority section pruning with `forge context budget`.
  - `WORK-023`: Workflow step execution token-bucket semaphore and concurrency regulator with `forge workflows semaphore`.
  - `EVIDENCE-011`: Changeset AST import/export static parser and circular dependency cycle detector with `forge diff cycles`.
  - `STATE-013`: SQLite schema-adaptive event query engine with snippet excerpt generation with `forge db search`.
  - `CONFIG-014`: Workspace security sandboxing policy validator and path boundary guard with `forge config boundary`.
  - Closed GitHub issues #332, #333, #334, #335, #336.

### 2026-11-19: PR #307 merged (`8748f6e`) — M1/M2/M4/M5/M6 Tool Coercer, Condition Evaluator, Merkle Lineage, Journal Exporter, and Feature Flags
- **Title:** `feat(core,workflows,evidence,db,config,cli): tool parameter coercer, condition evaluator, merkle lineage, event journal exporter, and feature flags (#302, #303, #304, #305, #306)`
- **Delivered:**
  - `AGENT-011`: Deterministic parameter validation and type coercion engine with toxic key prototype pollution stripping (`coerceToolParameters`) and `forge runtimes coerce <tool> <args> [--schema <schema>]`.
  - `WORK-018`: Safe AST-based boolean expression evaluator with sandboxed syntax parsing and zero eval/Function calls (`evaluateConditionExpression`) and `forge workflows eval "<expr>" [--context <ctx>]`.
  - `EVIDENCE-006`: Balanced binary Merkle tree generator with deterministic leaf hashing and cryptographic inclusion proof paths (`generateArtifactMerkleTree`, `verifyMerkleProof`) and `forge artifacts merkle <runId>`.
  - `STATE-008`: Tamper-evident sequential audit journal exporter and monotonic hash-chain verifier (`exportEventJournal`, `verifyEventJournalHashChain`) and `forge db journal <runId> [--verify]`.
  - `CONFIG-009`: Declarative workspace feature flags and runtime capability evaluator with administrative policy lock enforcement (`resolveFeatureFlags`) and `forge config features`.
  - Closed GitHub issues #302, #303, #304, #305, #306.

### 2026-11-19: PR #301 merged (`aaa7522`) — M1/M2/M4/M5/M6 Tool Idempotency Cache, Workflow Cost Estimator, Commit Validator, WAL Checkpoint Supervisor, and Config Masker
- **Title:** `feat(core,workflows,evidence,db,config,cli): tool idempotency cache, workflow cost estimator, commit validator, wal checkpoint supervisor, and config masker (#296, #297, #298, #299, #300)`
- **Delivered:**
  - `AGENT-010`: In-memory tool execution idempotency cache with TTL, LRU eviction, and mutation invalidation (`ToolIdempotencyCache`) and `forge runtimes cache [stats|clear]`.
  - `WORK-017`: Static offline workflow execution cost and token estimation modeling iteration loops and model costs (`estimateWorkflowCost`) and `forge workflows estimate <templateId>`.
  - `EVIDENCE-005`: Conventional Commits 1.0.0 specification, breaking change detection, and header length validator (`validateConventionalCommit`) and `forge verify commit "<msg>"`.
  - `STATE-007`: SQLite WAL checkpoint supervisor with TRUNCATE mode and total data directory storage quota auditor (`executeWalCheckpoint`, `auditDatabaseStorageQuota`) and `forge db checkpoint` / `forge db quota`.
  - `CONFIG-008`: Recursive sensitive configuration redaction and safe diagnostic sanitizer (`maskSensitiveConfig`) and `forge config export [--safe]`.
  - Closed GitHub issues #296, #297, #298, #299, #300.

### 2026-11-19: PR #295 merged (`c3fd9df`) — M1/M2/M4/M5/M6 Tool Rate Limiter, Timeout Supervisor, Secret Scanner, DB Integrity Auditor, and Env Interpolator
- **Title:** `feat(core,workflows,evidence,db,config,cli): tool rate limiter, timeout supervisor, secret leak scanner, db integrity auditor, and env interpolator (#290, #291, #292, #293, #294)`
- **Delivered:**
  - `AGENT-009`: In-memory token bucket rate limiting and concurrency throttling (`ToolRateLimiter`) and `forge runtimes rate-limit`.
  - `WORK-016`: Execution lease tracking and deterministic step timeout supervisor (`StepTimeoutSupervisor`) and `forge workflows timeout`.
  - `EVIDENCE-004`: Shannon entropy detection and regex rule leak scanner for git changesets (`SecretLeakScanner`) and `forge diff secrets <runId>`.
  - `STATE-006`: SQLite structural integrity checker and orphan record auditor/pruner (`auditDatabaseIntegrity`) and `forge db audit [--fix]`.
  - `CONFIG-007`: Recursive environment variable interpolation with fallback defaults (`interpolateEnvString`) and `forge config interpolate <template>`.
  - Closed GitHub issues #290, #291, #292, #293, #294.

### 2026-11-19: PR #289 merged (`22ef6ac`) — M1/M2/M4/M5/M6 Fallback Router, DLQ Engine, Coverage Auditor, Project Registry, and Policy Lock
- **Title:** `feat(core,workflows,evidence,db,config,cli): model fallback router, dlq engine, coverage auditor, project registry, and policy engine (#284, #285, #286, #287, #288)`
- **Delivered:**
  - `AGENT-008`: Dynamic multi-model fallback routing with circuit breaker cooldown and `forge models fallback` / `circuit`.
  - `WORK-015`: Workflow dead-letter queue (DLQ) with bounded exponential backoff and `forge workflows dlq [list|purge]`.
  - `EVIDENCE-003`: Test coverage regression delta auditor correlating diff lines with LCOV data and `forge verify coverage`.
  - `STATE-005`: Multi-project workspace registry, health auditor, and missing repo pruner `forge projects [list|prune]`.
  - `CONFIG-006`: Hierarchical configuration inheritance with administrative policy lock enforcement and `forge config policy`.
  - Closed GitHub issues #284, #285, #286, #287, #288.

### 2026-11-19: PR #283 merged (`ca56c9a`) — M2/M6 Cross-Run Memory, Snapshots, Conflict Detection, Quota Limiter, and Bootstrapper
- **Title:** `feat(core,workflows,evidence,runtimes,config,cli): cross-run solution memory, snapshots, conflict detection, quota limiter, and config bootstrapper (#278, #279, #280, #281, #282)`
- **Delivered:**
  - `AGENT-007`: Cross-run solution pattern recall and semantic memory indexing with `forge memory [search|index|stats]`.
  - `WORK-014`: Workflow state checkpoint snapshots with SHA-256 integrity and `forge workflows snapshot [create|list]`.
  - `DIFF-004`: Line-level hunk collision detector and three-way changeset merger with `forge diff merge <runIdA> <runIdB>`.
  - `RUNTIME-005`: Process RSS memory quota and duration enforcement with `forge runtimes quota`.
  - `CONFIG-005`: Workspace configuration bootstrapper and setup wizard with `forge config init [--force]`.
  - Closed GitHub issues #278, #279, #280, #281, #282.

### 2026-11-19: PR #277 merged (`954f4c2`) — M2/M4/M6 Prompt Cache Optimization, Sibling DAG Concurrency, Semantic Commit Synthesis, Secret Vault, and History Compaction
- **Title:** `feat(core,workflows,evidence,config,db,cli): prompt cache optimization, parallel execution planning, commit synthesis, secret vault, and event compaction (#272, #273, #274, #275, #276)`
- **Delivered:**
  - `AGENT-006`: Added prompt packet static prefix vs. dynamic turns caching optimizer and `forge context optimize <runId>`.
  - `WORK-013`: Added DAG sibling concurrency detection, execution wave batcher, and `forge workflows parallel <template>`.
  - `DIFF-003`: Added deterministic changeset conventional commit synthesizer and `forge diff commit <runId>`.
  - `CONFIG-004`: Added AES-256-GCM encrypted secret vault with PBKDF2 and `forge config vault [list|set|get]`.
  - `STATE-004`: Added event ledger history compactor and `forge db compact --before <date>`.
  - Closed GitHub issues #272, #273, #274, #275, #276.

### 2026-11-18: PR #271 merged (`5fa1ad0`) — M3/M5/M6 Custom Workflow Templates, Runtime Environment Sanitization, Token Accounting, Changeset Security Audit, and DB Snapshot Backup
- **Title:** `feat(templates,runtimes,core,evidence,db,cli): custom templates, environment sanitizer, token accounting, diff security, and db backup (#266, #267, #268, #269, #270)`
- **Delivered:**
  - `WORK-012`: Custom workflow template discovery, schema validation, and `forge workflows templates`.
  - `RUNTIME-004`: Process environment secret sanitizer and `forge runtimes env`.
  - `AGENT-005`: Token accounting engine and cost estimator `forge runs cost <runId>`.
  - `EVIDENCE-002`: Changeset security audit and leak detection `forge diff security <runId>`.
  - `STATE-003`: Online SQLite backup and atomic restore `forge db [backup|restore]`.
  - Closed GitHub issues #266, #267, #268, #269, #270.

### 2026-11-18: PR #253 merged (`ad67cd8`) — M3/M4/M5 Extended Declarative Criteria, Prompt Inspection, Vacuum, DAG Validation, and Benchmark Probes
- **Title:** `feat(criteria,cli,db,workflows,runtimes): extended declarative criteria, prompt inspection, vacuum, dag validation, and benchmark probes (#248, #249, #250, #251, #252)`
- **Delivered:**
  - `CRIT-002`: Added extended declarative completion criteria evaluators (`file-forbidden`, `max-diff-lines`, `artifact-regex`) with fail-closed physical evidence evaluation (A3, A5, A7).
  - `PROMPT-002`: Implemented `forge context inspect <runId> [stepId]` for CLI inspection of compiled prompt context packets.
  - `STATE-002`: Implemented SQLite maintenance utilities (`inspectDbStats`, `vacuumAndOptimizeDatabase`) and CLI command `forge db [stats|vacuum]`.
  - `WORK-009`: Built static offline workflow DAG validator (`validateWorkflowDag`) and CLI command `forge workflows validate <path>`.
  - `RUNTIME-002`: Added end-to-end runtime responsiveness and roundtrip latency benchmark probing (`testRuntimeResponsiveness`) and CLI command `forge runtimes test <runtimeId>`.
  - Closed GitHub issues #248, #249, #250, #251, #252.

### 2026-11-18: PR #234 merged (`0fe8d03`) — M10/M11 Interactive Terminal, Hosted Antigravity Runtime, and Stream Parser Decommission
- **Title:** `feat(m10,m11): interactive terminal, hosted antigravity runtime, and stream parser decommission (#117, #161, #162, #168, #171, #172)`
- **Delivered:**
  - Decommissioned and completely deleted `claudeStream.ts` and `antigravityStream.ts` along with test suites (#172).
  - Preserved provider limit overage handling via `claudeRateLimit.ts` (#180) and preflight refusal detection via `antigravityPreflight.ts` (#168).
  - Implemented `HostedAntigravityRuntime` with Go flag compliance and interactive hosted PTY session (#168).
  - Spike Claude Interjection documented in `docs/spikes/claude-interjection-spike.md` (#162).
  - Real interactive PTY prompt delivery and mid-run user interjections: added `step.interjected` domain event (A1), `WorkflowService.interject()` with user attribution, and `workflow:interject` IPC channel (#161, #171).
  - Recorded ADR-005 Task Domain Boundary establishing tasks as internal execution records bound to workflows (#117).

### 2026-11-18: PR #233 merged (`709de0d`) — M9/M10/M11 Interactive Control, Identity, Custom Runtimes, and Benchmark Harness
- **Title:** `feat(m9,m10,m11): interactive control, identity, custom runtimes, and benchmark harness (#138, #159, #164, #174, #180)`
- **Delivered:**
  - Runtime identity display and disambiguation (#138).
  - Stage rerun and skip controls in DAG workflow templates (#164).
  - Provider overage and quota detection rule without failing steps (#180).
  - Benchmark measurement harness recording stage wall-clock time in `docs/spikes/session-resume-benchmark.md` (#159).

### 2026-11-18: PR #232 merged (`a6c6e7f`) — M8/M9 Live Channel UI and Warm Session Resumption
- **Title:** `feat(m8,m9): live channel UI and warm session resumption (#153, #154, #155, #157, #158)`
- **Delivered:**
  - Live tool-call timeline per step (#155).
  - Bound workflow terminal pane directly to running step child process (#154).
  - Warm session persistence across workflow stages (`WarmSessionStore`) (#157).
  - Resumed CLI sessions in Claude (`--resume`) and Antigravity (`--conversation`) adapters (#158).

### 2026-11-18: PR #231 merged (`0bb80b0`) — M7/M8 Live Channel, Custom Runtime Config, and Typed IPC
- **Title:** `feat(m7,m8): live channel, custom runtime config, and typed IPC (#149, #153, #174)`
- **Delivered:**
  - Typed IPC streaming for runtime events (`workflow:runtime-event`) (#153).
  - Data-driven custom CLI runtime configuration via `.forgerc` and `CustomRuntimeStore` (#174, CORE-003).
  - Live agent channel subscription and event log replay (#149).

### 2026-11-17: Milestone M6 Cutover & Hardening (WORK-006E, HUMAN-001 #163, #183, #178, #64)
- **Title:** `feat(workflows): cut over WorkflowService to GraphExecutor and complete Milestone M6`
- **Delivered:** Final production cutover of the Generic Workflow Graph Engine, human decision gates, and audit trails:
  - Cut over `WorkflowService.executeWorkflow` from legacy `Orchestrator` to `createGraphExecutorWithLeafRunner` / `GraphExecutor.run(...)`.
  - Compiled linear templates (`FEATURE_IMPLEMENTATION`, `BUG_FIX`) to `WorkflowTemplateV2` DAGs.
  - Injected `ArtifactService` and wired step execution lifecycle, logging, and FSM transition sync.
  - Implemented real human approval gate (`HUMAN-001`, Issue #163) with `approveAndStartImplementation` recording locked gate decisions and `rejectImplementation` handling cancellation.
  - Implemented stale runtime binding fallback event (`workflow.binding_substituted`) and audit trail (Issue #183).
  - Formally closed GitHub Issues #178 and #64.
  - Marked Milestone M6 as **100% COMPLETE**.

### 2026-11-17: PR #229 merged
- **Title:** `docs(project): reconcile progress tracker, milestones, and truth baselines`
- **Delivered:** Alignment of project documentation, baseline tracking, and roadmap states with repository truth.

### 2026-10-20: PR #228 (Slice 5B-1C Slice B) merged
- **Title:** `feat(workflows): implement authoritative reviewer routing and crash recovery (Slice 5B-1C Slice B)`
- **Branch:** `feat/m6-phase5-batch3-slice5b1c-reviewer-routing`
- **Status:** MERGED
- **Delivered:** Authoritative reviewer routing and crash-recovery verification:
  - Hardened `assessReview` runtime validation and fail-closed verdict (`unknown`, `overridden: true`) on empty or malformed criteria.
  - Exported and enforced `reviewOutcomeSchema` and `authoritativeReviewVerdictSchema` requiring explicit `changeSetId`, `evidenceId`, `stepId`, `iteration`, `verdict`, `overridden`, `reason`, and `rejectingFindings`.
  - Compiled conditional feedback edge on canonical linear templates (`FEATURE_IMPLEMENTATION`, `BUG_FIX`).
  - Implemented trusted reviewer execution in `LeafRunner` with authoritative verification evidence binding and genuine completed reviewer attempt identity.
  - Hardened recovery pending-feedback path in `GraphExecutor`: conditional evaluation of feedback edges, mandatory positive integer verification iteration metadata strictly matching `currentIteration`, changeset identity cross-validation, and idempotent replay of committed transitions.
  - Expanded `artifactKindSchema` and `artifactKindViewSchema` with compiled linear stage outputs (`stage_deliverable`).
- **CI & Tests:** CI Run [39438649157](https://github.com/mdsaif45/forge-orchestrator/actions/runs/39438649157) PASSED all 3 jobs (`App checks (Electron)`, `Format, lint, types, tests`, `App checks (Windows)`). 43 passing unit tests in `src/main/workflows/reviewerRouting.test.ts`.

### 2026-10-20: PR #227 (Slice 5B-1C Slice A) merged (`07d3c4b`)
- **Title:** `feat(workflows): implement gate-scoped human decision authorization (Slice 5B-1C Slice A)`
- **Delivered:** Gate-scoped human decision authorization in `GraphExecutor`:
  - Verified human gate authorization scoped strictly to current graph run and active node attempt.
  - Independent graph run project identity validation preventing cross-project approval leaks.
  - Fail-closed gate decision lookup and template resolution across full relationship chains.
  - Enforcement of read-only permission ceilings during gate execution.
- **CI & Tests:** CI Run [39358018332](https://github.com/mdsaif45/forge-orchestrator/actions/runs/39358018332) PASSED; 1,667 unit tests passing locally across 115 test files (3 skipped).

### 2026-10-19: PR #226 (Slice 5B-1B) merged (`57cc1a2`)
- **Title:** `feat(workflows): implement binding role resolution and capability preflight (Slice 5B-1B)`
- **Delivered:** Role resolution and capability preflight in `roleResolution.ts` and `leafRunner.ts`:
  - Enforced role permission ceilings (`read_only`, `workspace_write`, `unrestricted`) across stores, resolution, and execution.
  - Closed authorization bypasses for explicit `providerId` and default runtime.
  - Hardened read-only worktree enforcement across session disposal errors and all exit paths.
- **Tests:** 14 tests in `roleResolution.test.ts`.

### 2026-10-18: PR #225 (Slice 5B-1A) merged (`ba77460`)
- **Title:** `feat(workflows): add production graph composition factory (M6 Slice 5B-1A)`
- **Delivered:** `ProductionGraphFactory` (`src/main/workflows/graphFactory.ts`) for deterministic production graph executor construction, wiring SQLite stores, `ArtifactService`, `WorktreeService`, `LeafRunner`, and policy checks.
- **Tests:** 11 tests in `graphFactory.test.ts`.

### 2026-10-18: PR #224 (WORK-005) merged (`a1964a1`)
- **Title:** `feat(workflows): implement generic leaf runner for graph execution (WORK-005)`
- **Delivered:** Single-responsibility leaf runner (`src/main/workflows/leafRunner.ts`) coordinating discrete primitives (`exchange`, `buildChangeSet`, `verifyStep`, `compileContext`) with fail-closed change-scope enforcement and verification evidence mapping.
- **Tests:** 15 tests in `leafRunner.test.ts`.

### 2026-10-17: PR #223 merged (`e434c1e`)
- **Title:** `test(workflows): cover multi-iteration pause recovery`
- **Delivered:** Comprehensive test coverage for multi-iteration pause/recovery lifecycles in `src/main/workflows/graphLifecycle.test.ts`.

### 2026-10-17: PR #222 (WORK-004) merged (`bcecb65`)
- **Title:** `fix(workflows): M6 Phase 5 Batch 1 — Foundation Stabilization & Read Models`
- **Delivered:** Graph pause/recovery lifecycle stabilization and Slice 5A-1 graph read-model contracts (`src/shared/views/`):
  - Validated current pause evidence during recovery.
  - Fail-closed on pre-attempt and inter-node process crashes.
  - Graph read-model projections (`WorkflowDetailView`, `WorkflowNodeView`, `WorkflowEdgeView`).
- **Tests:** 28 lifecycle tests in `graphLifecycle.test.ts`, 25 read-model tests in `views.test.ts`.

### 2026-10-15: PR #221 (WORK-003 Slice 2C-1) merged (`6f7df99`)
- **Title:** `feat(workflows): implement durable artifact lineage hydration on crash recovery (WORK-003 Slice 2C-1)`
- **Delivered:** Durable artifact lineage hydration during `GraphExecutor` crash recovery, fail-closed handling of ambiguous target slots, output substitution prevention, and separation of required artifact completeness from persistence durability.
- **Tests:** 42 lineage recovery scenario tests in `graphExecutor.test.ts`.

### 2026-10-13: PR #220 (WORK-003 Slice 2B) merged (`4a9e594`)
- **Title:** `feat(workflow): implement WORK-003 Slice 2B feedback loops, iteration advancement, and worktree patching`
- **Delivered:** Feedback loop iteration advancement, loop fingerprint tracking (`loopFingerprint.ts`), bounded iterations (Axiom A5), and worktree patch transfer across iterations.

### 2026-10-05: PR #219 (WORK-003 Slice 2A) merged (`0144cbe`)
- **Title:** `feat(workflow): WORK-003 Slice 2A — router nodes, conditions, and branch pruning`
- **Delivered:** Conditional branch evaluation, router nodes, dynamic branch pruning, and dead-path elimination in `GraphExecutor`.

### 2026-10-04: PR #218 (WORK-003 Slice 1) merged (`cc3da3d`)
- **Title:** `feat(workflow): WORK-003 Slice 1 — loop persistence and transition invariants`
- **Delivered:** SQLite schema support for loop iterations, durable iteration counters, and state transition invariants.

### 2026-10-01: PR #217 (WORK-002) merged (`8a5d899`)
- **Title:** `feat(workflow): implement WORK-002 stage controls, skip, and rerun`
- **Delivered:** Engine-level selective node execution (`runNode`, `skipNode`, `rerunNode`) in `GraphExecutor`. Partially satisfies Issue #164 requirements at engine level.

### 2026-09-30: PR #216 (WORK-001) merged (`748334a`)
- **Title:** `feat(workflow): implement WORK-001 GraphExecutor and fan-in patch materialization`
- **Delivered:** In-memory and persisted DAG execution engine (`GraphExecutor`), parallel branch scheduling, and fan-in git patch materialization via `changeSetMerger.ts`.

### 2026-09-30: PR #215 (WORK-001) merged (`07e7fd0`)
- **Title:** `feat(workflow): implement WORK-001 branch worktree isolation and changeSetMerger`
- **Delivered:** Isolated git worktree allocation per graph branch (`WorktreeService.prepareWorktree`) preventing concurrency collisions (Q-WF-01), and three-way changeset merging.

### 2026-09-30: PR #214 merged (`e9990ef`)
- **Title:** `feat(workflow): implement M6 Phase 1 graph schemas, template compiler, and persistence`
- **Delivered:** `WorkflowTemplateV2` schemas, canonical linear template compilation (`templateCompiler.ts`), and SQLite persistence schema for workflow graphs.

### 2026-09-30: PR #213 merged (`50ea514`)
- **Title:** `docs(arch): accept ADR-007 generic workflow graph architecture and execution model`
- **Delivered:** Architectural specification establishing the Generic Workflow Graph Engine program (ADR-007).

### 2026-09-29: PR #212 merged (`383c62c`)
- **Title:** `feat(arch): implement ADR-004 architectural layering and boundary enforcement`
- **Delivered:** Dependency-cruiser architectural boundaries, cycle detection scripts, and strict subsystem layering.

### 2026-09-28: PR #211 merged (`c981988`)
- **Title:** `feat(architecture): establish artifact service authority and remove legacy artifact store (ADR-006)`
- **Delivered:** Elevated `ArtifactService` as sole authority for artifact storage and streaming; removed legacy SQLite blob storage.

### 2026-09-28: PR #210 merged (`ee0ef71`)
- **Title:** `feat(architecture): separate application read models from ipc transport (ADR-005)`
- **Delivered:** Decoupled `@shared/views` projection types from IPC transport schemas.

### 2026-09-28: PR #209 merged (`022a504`)
- **Title:** `feat: complete pre-M6 small milestones (M0-002, M0-003, AGENT-002)`
- **Delivered:** Windows git EBUSY flakiness resolution (`removeTempDir`), spike #64 formal documentation closure, and high-throughput streaming artifact ingestion.

### 2026-09-28: PR #208 (VERIFY-003) merged (`391630e`)
- **Title:** `feat(verification): add adversarial verifier (VERIFY-003)`
- **Delivered:** Independent adversarial evidence auditor (`adversarial.ts`), verifier integration (`verifier.ts`), cryptographic artifact integrity verification, and exit code 2 halt on policy violations.

### 2026-09-25: PR #207 merged (`7b91d67`)
- **Title:** `docs(project): record CRIT-001 completion after PR #204 merge`
- **Delivered:** Forensic documentation stabilization and truth baseline unification.

### 2026-09-25: PR #204 (CRIT-001) merged (`5987501`)
- **Title:** `feat(criteria, cli): implement CRIT-001 criteria evaluation & runs/artifacts inspection CLI`
- **Delivered:** CRIT-001 criteria evaluator engine, task loop integration, and `forge runs` / `forge artifacts` CLI.

### 2026-09-12: PR #203 (STATE-001) merged (`1dfb444`)
- **Title:** `feat(state): implement STATE-001 durable run, step, artifact, and event store`
- **Delivered:** SQLite schema migrations via Drizzle ORM, `RunStore`, `EventStore`, `ArtifactStore`, and filesystem `ArtifactService`.

### 2026-09-12: PR #198 (Vertical Slice #1) merged (`26ac6e3`)
- **Title:** `feat(core): Vertical Slice #1 — Headless Forge Core, Native Agent Runtime & CLI (CORE-001, AGENT-001, CLI-001, EVIDENCE-001)`
- **Delivered:** Decoupled `createForgeCore`, standalone `bin/forge.ts` CLI, native agent task loop in `taskRunner.ts`, physical git diff reconciliation.

### 2026-09-09: PR #188 & #189 merged
- **Delivered:** External CLI agent provider catalog and ConPTY terminal session hosting foundation.

---

## 4. Production Execution Reality: Generic Graph Engine Active

The production execution cutover from the legacy linear `Orchestrator` to the **generic workflow graph engine** is complete (Milestone M6 / WORK-006E):

1. **Active Production Path:**
   - Production runtime entrypoint is `WorkflowService` (`packages/forge-core/src/workflows/workflowService.ts`).
   - `WorkflowService` compiles canonical workflow templates (`FEATURE_IMPLEMENTATION`, `BUG_FIX`) and YAML workflows to directed acyclic graphs (`WorkflowTemplateV2`) via `compileLinearTemplateToGraph`.
   - `WorkflowService` creates and runs `createGraphExecutorWithLeafRunner` (`packages/forge-core/src/workflows/graphFactory.ts`), dispatching leaf nodes (`agent`, `verification`, `user_gate`) through `LeafRunner`.
   - Production execution path is strictly: `WorkflowService → GraphExecutor` (with `LeafRunner`).
   - The legacy `Orchestrator` execution path has been superseded.
   - Encapsulation is preserved: no IPC handler exposes `GraphExecutor` directly, and `createForgeCore` initializes `WorkflowService` with clean dependency injection.

2. **Generic Graph Engine Status: 100% COMPLETE**
   - Resides in `packages/forge-core/src/workflows/` (`GraphExecutor`, `LeafRunner`, `ProductionGraphFactory`, `roleResolution.ts`, `reviewerRouting.ts`, `workflowDslParser.ts`, `subworkflowCompiler.ts`).
   - Slices 5B-1A..5B-1C, `WorkflowService` cutover, declarative YAML DSL authoring, nested reusable templates, and visual drag-and-drop canvas composition (`packages/forge-desktop/src/renderer/src/app/workflow/WorkflowCanvas.tsx`) are merged and verified.

3. **Human Gate & Safety Invariants:**
   - Human approval gate (`HUMAN-001`, Issue #163) blocks until an authoritative human gate decision is locked in SQLite (`approveAndStartImplementation` / `rejectImplementation`).
   - Bounded loops (Axiom A5), physical evidence over claims (Axiom A3), and strict role permission ceilings (Axiom A7) are verified across all execution paths.

---

## 5. Milestone Taxonomy & GitHub Tracking Reconciliation

All 17 GitHub milestones (**M0–M16**) are **closed** (`0` open issues across the repository):

| Milestone # | Title on GitHub | State | Closed Issues | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **#1** | `M0 - Foundation` | Closed | 13 | Foundation, CI matrix, Windows git `EBUSY` fix |
| **#2** | `M1 - State Core` | Closed | 10 | State & Headless Core (`createForgeCore`) |
| **#3** | `M2 - Runtime Adapters` | Closed | 12 | Native agent & CLI adapters |
| **#4** | `M3 - Workflow Engine` | Closed | 7 | Linear workflow engine |
| **#5** | `M4 - Evidence and Review` | Closed | 6 | State, persistence & diff reconciliation |
| **#6** | `M5 - Human Control Plane` | Closed | 7 | Verification & completion criteria |
| **#7** | `M6 - Polish and Scale` | Closed | 6 | Early v0.1.0-alpha release milestone |
| **#8** | `M7 - Usability and Real Agent Wiring` | Closed | 22 | Post-alpha usability & ADR-005 wiring |
| **#9** | `M8 - Live Agent Channel` | Closed | 7 | Streaming runtime events & tool timeline |
| **#10** | `M9 - Warm Sessions and Speed` | Closed | 4 | Resumable sessions (`WARM-001..003`) |
| **#11** | `M10 - Interactive Control` | Closed | 5 | Approval gate, stage controls, interjections |
| **#12** | `M11 - Host the Real CLI` | Closed | 17 | ConPTY hosting & CLI hooks |
| **#23** | `M12 - Autonomous Multi-Agent Control Plane` | Closed | 30 | Hardening clusters & `CLI-004` TUI |
| **#24** | `M13 - Empirical Benchmarking and Hardening` | Closed | 6 | `BENCH-001..003` |
| **#25** | `M14 - Workspace Isolation and Concurrency` | Closed | 8 | `PAR-001`, `PAR-002`, `AGENT-033`, `POLISH-001` |
| **#26** | `M15 - Workflow DSL and Distributed Cloud Replication` | Closed | 8 | `COMP-001`, `COMP-002`, `UI-001`, `POLISH-002` |
| **#27** | `M16 - Modular Monorepo Workspace Refactoring` | Closed | 19 | `ARCH-001..009` (`@forge/*` monorepo packages) |

---

## 6. Active Work, Dependencies, and Next Action

- **Current Baseline:** `main` @ `cfb0f4c` (PR #488 merged).
- **Milestones Status:** Milestones **M0–M16** are 100% completed and closed on GitHub with zero open issues.
- **Next Action:** Land documentation progress & monorepo path sync PR, then create the centralized UI library and conversation-native execution milestone plan.
