# Current State & Capability Verification

**Status:** IMPLEMENTED
**Authority:** Implementation truth (see [documentation-policy.md](../meta/documentation-policy.md))
**Last Updated:** 2026-09-22
**Baseline:** `main` @ `1dfb444` (PR #203 merged)
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
`vitest run --reporter=json` at the baseline commit.

### 2.1 Headless core & CLI

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Engine boots without Electron | Headless daemon capability | IMPLEMENTED | VERIFIED | Core kernel boots and creates services without GUI | `src/main/core/forgeCore.ts` | `src/main/core/forgeCore.test.ts` (4) | CORE-001 |
| Custom data directory (`--data-dir`) | Relocatable storage root | IMPLEMENTED | VERIFIED | Data directory resolved and isolated | `src/main/core/forgeCore.ts` | `src/main/core/forgeCore.test.ts` (4) | CORE-001 |
| Native in-process agent task loop | Autonomous execution turn loop | IMPLEMENTED | VERIFIED | Executes tool turns, tracks diffs, and returns authoritative evidence | `src/main/core/taskRunner.ts` | `src/main/core/taskRunner.test.ts` (3) | AGENT-001 |
| Standalone CLI entrypoint | Headless binary interface | IMPLEMENTED | VERIFIED | `run`, `status`, and `models` commands execute cleanly | `bin/forge.ts`, `src/main/cli.ts` | `src/main/cli.test.ts` (5) | CLI-001 |
| NDJSON event stream (`--json`) | Machine-readable streaming output | IMPLEMENTED | VERIFIED | Emits parseable NDJSON lines for CI / automated consumers | `src/main/cli.ts` | `src/main/cli.test.ts` (5) | CLI-001 |
| Process-tree termination & orphan tracking | Clean child process lifecycle | IMPLEMENTED | VERIFIED | Process trees killed recursively; orphans reaped across restarts | `src/main/process/processManager.ts`, `orphans.ts` | `src/main/process/process.test.ts` (40) | CORE-001 |
| Secret redaction in captured output | No credentials leaked in logs/prompts | IMPLEMENTED | VERIFIED | Sensitive tokens and keys replaced with redacted markers | `src/main/process/redact.ts` | `src/main/process/process.test.ts` (40) | CORE-001 |

### 2.2 State, storage & events

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| SQLite run & step records | Durable relational run metadata | IMPLEMENTED | VERIFIED | Runs and steps inserted, updated, and queried in SQLite | `src/main/db/runStore.ts` | `src/main/db/runStore.test.ts` (3) | STATE-001 |
| Append-only run event ledger | Immutable sequential audit log | IMPLEMENTED | VERIFIED | Monotonic sequence-numbered events stored per run | `src/main/db/eventStore.ts`, `runStore.ts` | `src/main/db/eventStore.test.ts` (24) | STATE-001 |
| Artifact metadata index | Relational index of disk blobs | IMPLEMENTED | VERIFIED | Artifact metadata queried by runId and stepId | `src/main/db/artifactStore.ts` | `src/main/db/artifactStore.test.ts` (3) | STATE-001 |
| Filesystem artifact blobs + SHA-256 | Dual-tier filesystem storage | IMPLEMENTED | VERIFIED | Content written under `<dataDir>/artifacts/<runId>/` with SHA-256 integrity | `src/main/artifacts/artifactService.ts` | `src/main/artifacts/artifactService.test.ts` (7) | STATE-001 |
| Path-traversal containment on artifacts | Sandboxed file containment | IMPLEMENTED | VERIFIED | Directory traversal attempts (`../`) throw containment error | `src/main/artifacts/artifactService.ts` | `src/main/artifacts/artifactService.test.ts` (7) | STATE-001 |
| Windowed byte-offset artifact reads | OOM-safe log stream chunk reader | IMPLEMENTED | VERIFIED | Byte slices read positional from disk without full-file buffering | `src/main/artifacts/artifactService.ts` | `src/main/artifacts/artifactService.test.ts` (7) | ARTIFACT-001 |
| Schema migrations | Versioned schema evolution | IMPLEMENTED | VERIFIED | Drizzle-managed migrations run on startup before DB use | `src/main/db/migrate.ts`, `schema.ts` | `src/main/db/db.test.ts` (4) | STATE-001 |

> `readWindow()` is present and tested on `main`. An earlier revision of this document
> attributed it to the unmerged PR #204; that was wrong and is corrected here.

### 2.3 Evidence & verification

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Physical git diff vs. agent claims | Ground-truth diff reconciliation | IMPLEMENTED | VERIFIED | Discrepancies logged when physical git diff differs from report | `src/shared/domain/reconcile.ts` | `src/main/evidence/reconciliation.integration.test.ts` (11) | EVIDENCE-001 |
| Out-of-scope / untracked file detection | Path boundary enforcement | IMPLEMENTED | VERIFIED | Untracked and out-of-scope modifications halt or flag discrepancy | `src/shared/domain/reconcile.ts` | `src/main/evidence/reconciliation.integration.test.ts` (11) | EVIDENCE-001 |
| Independent build & test command runner | Objective command verification | IMPLEMENTED | VERIFIED | Commands executed via child processes; exit codes and outputs captured | `src/main/evidence/verifier.ts` | `src/main/evidence/verifier.test.ts` (14) | VERIFY-002 |
| Test-output parsing into structured results | Structured test counts | IMPLEMENTED | VERIFIED | Vitest, Jest, and Pytest outputs parsed into passed/failed numbers | `src/main/evidence/testParsers.ts` | `src/main/evidence/testParsers.test.ts` (12) | VERIFY-002 |
| Completion-criteria evaluation | Objective completion assessment | IMPLEMENTED | VERIFIED | 7 criterion kinds evaluated with fail-outranks-unknown precedence | `src/shared/domain/completion.ts` | `src/shared/domain/completion.test.ts` (25) | EVIDENCE-001 |
| ChangeSet snapshotting | Physical diff record per step | IMPLEMENTED | VERIFIED | Baseline and head diff snapshots stored in `change_sets` table | `src/main/changesets/changeSetService.ts` | `src/main/db/changeSetStore.test.ts` (3) | EVIDENCE-001 |

> Criteria evaluation lives in `src/shared/domain/completion.ts`. There is no
> `src/shared/domain/criteria.ts`; an earlier revision of this document named that
> non-existent path.

### 2.4 Workflow & orchestration

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Linear workflow state machine with guards | Validated state transitions | IMPLEMENTED | VERIFIED | State machine enforces legal moves, bounds, and terminal rules | `src/main/runtimes/orchestrator.ts` | `src/main/runtimes/orchestrator.test.ts` (31) | CORE-002 |
| Transition table & generated state diagram | Verified state graph docs | IMPLEMENTED | VERIFIED | `npm run check:docs` CI gate ensures `DOMAIN.md` matches code | `src/shared/domain/transitions.ts` | `npm run check:docs` gate | CORE-002 |
| Decision-lock gate before implementation | Human decision approval | IMPLEMENTED | VERIFIED | Transition to implementation blocked if zero locked decisions | `src/main/runtimes/orchestrator.ts` | `src/main/runtimes/orchestrator.test.ts` (31) | CORE-002 |
| `AWAITING_USER` pause for human answers | Human-in-the-loop interjection | IMPLEMENTED | VERIFIED | Workflow pauses on open questions and resumes when answered | `src/main/runtimes/orchestrator.ts` | `src/main/runtimes/orchestrator.test.ts` (31) | CORE-002 |
| Role-capability binding checks | Capability validation | IMPLEMENTED | VERIFIED | Binding rejected if runtime lacks required role capabilities | `src/shared/domain/runtime.ts` | `src/main/runtimes/guards.integration.test.ts` (18) | CORE-002 |
| Multi-agent closed-loop acceptance | Multi-role autonomous execution | IMPLEMENTED | VERIFIED | Complete plan -> implement -> verify -> review loop verified | `src/main/workflows/workflowService.ts` | `src/main/acceptance/mvpAcceptance.test.ts` (3) | MVP-001 |
| Generic DAG graph execution engine | Arbitrary Lego-piece DAG workflow | PARTIAL | VERIFIED | Graph cycle validation and topological sort tested; core execution in progress | `src/shared/domain/workflowGraph.ts`, `src/main/workflows/dagExecutor.ts` | `src/shared/domain/workflowGraph.test.ts` (6) | WORK-001 |

### 2.5 Agent runtimes

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `IAgentRuntime` abstraction | Provider-agnostic agent interface | IMPLEMENTED | VERIFIED | Canonical start/send/events/status/cancel/dispose interface | `src/shared/domain/runtime.ts` | `src/main/runtimes/runtimes.test.ts` (15) | CORE-001 |
| Native agent runtime | In-process LLM agent execution | IMPLEMENTED | VERIFIED | Tool loop and streaming execution with Ollama/OpenAI models | `src/main/runtimes/nativeAgentRuntime.ts` | `src/main/runtimes/nativeAgentRuntime.test.ts` (12) | AGENT-001 |
| Claude CLI adapter | Spawned Claude Code CLI hosting | IMPLEMENTED | VERIFIED | Spawns Claude Code CLI in PTY with automated prompt delivery | `src/main/runtimes/claudeCliRuntime.ts` | `src/main/runtimes/claudeCliRuntime.test.ts` (16) | CORE-001 |
| Antigravity CLI adapter | Spawned Antigravity CLI hosting | IMPLEMENTED | VERIFIED | Spawns Antigravity CLI in ConPTY session with stream observation | `src/main/runtimes/antigravityCliRuntime.ts` | `src/main/runtimes/antigravityCliRuntime.test.ts` (14) | CORE-001 |
| Generic CLI adapter | User-configurable external CLI runner | IMPLEMENTED | VERIFIED | Spawns arbitrary agent CLI with parameterized templates | `src/main/runtimes/genericCliRuntime.ts` | `src/main/runtimes/genericCliRuntime.test.ts` (10) | CORE-001 |
| Pre-launch folder-trust automation | Bypass interactive CLI trust prompts | IMPLEMENTED | VERIFIED | Pre-populates Claude trust database before process spawn | `src/main/runtimes/claudeTrust.ts` | `src/main/runtimes/claudeTrust.test.ts` (8) | CORE-001 |
| PTY process hosting (ConPTY / node-pty) | Full interactive terminal emulation | IMPLEMENTED | VERIFIED | Spawns child processes in Windows ConPTY or Linux pseudo-terminal | `src/main/runtimes/ptyProcessRunner.ts` | `src/main/runtimes/ptyProcessRunner.test.ts` (12) | CORE-001 |
| Terminal session registry | Multi-session terminal multiplexer | IMPLEMENTED | VERIFIED | Named terminal sessions registered, attached, and multiplexed | `src/main/terminal/sessionRegistry.ts` | `src/main/terminal/sessionRegistry.test.ts` (8) | CORE-001 |
| Account isolation per runtime | Multi-account isolation | IMPLEMENTED | VERIFIED | Separate user profiles / credentials isolated per session | `src/main/accounts/` | `src/main/runtimes/accountSwitch.integration.test.ts` (6) | CORE-001 |

> The runtime module is `src/main/runtimes/claudeTrust.ts`, and PTY hosting lives in
> `ptyProcessRunner.ts` with session state in `src/main/terminal/`. There is no
> `claudeTrustStore.ts` and no `src/main/runtimes/terminalSession.ts`.

### 2.6 Desktop shell

| Capability | Desired State | Implementation State | Verification State | Evidence | Source | Tests | Related Roadmap Item |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Typed IPC contract & router parity | Zero unchecked IPC channels | IMPLEMENTED | VERIFIED | All 70 IPC channels declared with Zod request/response contracts | `src/shared/ipc.ts`, `src/main/ipc/` | `npm run check:router` gate | CORE-002 |
| Context-isolated preload bridge | Secure Electron process boundary | IMPLEMENTED | VERIFIED | Preload bridge exposes only typed API methods; contextIsolation enabled | `src/preload/` | `npm run smoke` gate | CORE-002 |
| React renderer & design system | Desktop engineering control plane UI | IMPLEMENTED | VERIFIED | React UI builds, renders views, and passes UI check | `src/renderer/` | `npm run check:ui`, `npm run test:e2e` | CORE-002 |
| Terminal TUI for the CLI | Interactive multi-pane terminal TUI | PLANNED | NOT APPLICABLE | No implementation on `main`; planned for future release | None | None | CLI-004 |

> No terminal TUI exists on `main`: there is no `src/main/tui/` directory and no Ink
> dependency in `package.json`. An earlier revision claimed both.

---

## 3. Work in flight (planning truth, not implementation truth)

| PR | Branch | State | Scope |
| :--- | :--- | :--- | :--- |
| [#204](https://github.com/mdsaif45/forge-orchestrator/pull/204) | `feat/slice-2-observability-criteria` | OPEN | Observability & criteria integrity slice |
| [#205](https://github.com/mdsaif45/forge-orchestrator/pull/205) | `docs/restructure-architecture` | OPEN | This documentation restructure |
| [#197](https://github.com/mdsaif45/forge-orchestrator/pull/197) | `fix/user-message-padding` | OPEN | Ask-mode bubble padding fix |

Nothing on these branches is counted as implemented in §2.

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
