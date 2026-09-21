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

| Capability | Status | Evidence (test file · count) | Implementation |
| :--- | :--- | :--- | :--- |
| Engine boots without Electron | VERIFIED | `src/main/core/forgeCore.test.ts` (4) | `src/main/core/forgeCore.ts` |
| Custom data directory (`--data-dir`) | VERIFIED | `src/main/core/forgeCore.test.ts` (4) | `src/main/core/forgeCore.ts` |
| Native in-process agent task loop | VERIFIED | `src/main/core/taskRunner.test.ts` (3) | `src/main/core/taskRunner.ts` |
| Standalone CLI entrypoint | VERIFIED | `src/main/cli.test.ts` (5) | `bin/forge.ts`, `src/main/cli.ts` |
| NDJSON event stream (`--json`) | VERIFIED | `src/main/cli.test.ts` (5) | `src/main/cli.ts` |
| Process-tree termination & orphan tracking | VERIFIED | `src/main/process/process.test.ts` (40) | `src/main/process/processManager.ts`, `orphans.ts` |
| Secret redaction in captured output | VERIFIED | `src/main/process/process.test.ts` (40) | `src/main/process/redact.ts` |

### 2.2 State, storage & events

| Capability | Status | Evidence (test file · count) | Implementation |
| :--- | :--- | :--- | :--- |
| SQLite run & step records | VERIFIED | `src/main/db/runStore.test.ts` (3) | `src/main/db/runStore.ts` |
| Append-only run event ledger | VERIFIED | `src/main/db/eventStore.test.ts` (24) | `src/main/db/eventStore.ts` |
| Artifact metadata index | VERIFIED | `src/main/db/artifactStore.test.ts` | `src/main/db/artifactStore.ts` |
| Filesystem artifact blobs + SHA-256 | VERIFIED | `src/main/artifacts/artifactService.test.ts` (7) | `src/main/artifacts/artifactService.ts` |
| Path-traversal containment on artifacts | VERIFIED | `src/main/artifacts/artifactService.test.ts` (7) | `src/main/artifacts/artifactService.ts` |
| Windowed byte-offset artifact reads | VERIFIED | `src/main/artifacts/artifactService.test.ts` (7) | `ArtifactService.readWindow()` |
| Schema migrations | VERIFIED | `src/main/db/db.test.ts` | `src/main/db/migrate.ts`, `schema.ts` |

> `readWindow()` is present and tested on `main`. An earlier revision of this document
> attributed it to the unmerged PR #204; that was wrong and is corrected here.

### 2.3 Evidence & verification

| Capability | Status | Evidence (test file · count) | Implementation |
| :--- | :--- | :--- | :--- |
| Physical git diff vs. agent claims | VERIFIED | `src/main/evidence/reconciliation.integration.test.ts` (11) | `src/shared/domain/reconcile.ts` |
| Out-of-scope / untracked file detection | VERIFIED | `src/main/evidence/reconciliation.integration.test.ts` (11) | `src/shared/domain/reconcile.ts` |
| Independent build & test command runner | VERIFIED | `src/main/evidence/verifier.test.ts` (14) | `src/main/evidence/verifier.ts` |
| Test-output parsing into structured results | VERIFIED | `src/main/evidence/testParsers.test.ts` | `src/main/evidence/testParsers.ts` |
| Completion-criteria evaluation | VERIFIED | `src/shared/domain/completion.test.ts` (25) | `src/shared/domain/completion.ts` |
| ChangeSet snapshotting | VERIFIED | `src/main/db/changeSetStore.test.ts` | `src/main/changesets/changeSetService.ts` |

> Criteria evaluation lives in `src/shared/domain/completion.ts`. There is no
> `src/shared/domain/criteria.ts`; an earlier revision of this document named that
> non-existent path.

### 2.4 Workflow & orchestration

| Capability | Status | Evidence (test file · count) | Implementation |
| :--- | :--- | :--- | :--- |
| Linear workflow state machine with guards | VERIFIED | `src/main/runtimes/orchestrator.test.ts` (31) | `src/main/runtimes/orchestrator.ts` |
| Transition table & generated state diagram | VERIFIED | `npm run check:docs` gate | `src/shared/domain/transitions.ts` |
| Decision-lock gate before implementation | VERIFIED | `src/main/runtimes/orchestrator.test.ts` (31) | `src/main/runtimes/orchestrator.ts` |
| `AWAITING_USER` pause for human answers | VERIFIED | `src/main/runtimes/orchestrator.test.ts` (31) | `src/main/runtimes/orchestrator.ts` |
| Role-capability binding checks | VERIFIED | `src/main/runtimes/guards.integration.test.ts` | `src/shared/domain/runtime.ts` |
| Multi-agent closed-loop acceptance | VERIFIED | `src/main/acceptance/mvpAcceptance.test.ts` (3) | see [mvp-acceptance.md](mvp-acceptance.md) |
| Generic DAG graph execution engine | PLANNED | none — types only | `src/shared/domain/workflowGraph.ts` (6 type tests) |

### 2.5 Agent runtimes

| Capability | Status | Evidence (test file · count) | Implementation |
| :--- | :--- | :--- | :--- |
| `IAgentRuntime` abstraction | VERIFIED | `src/main/runtimes/runtimes.test.ts` | `src/shared/domain/runtime.ts` |
| Native agent runtime | VERIFIED | `src/main/runtimes/nativeAgentRuntime.test.ts` | `src/main/runtimes/nativeAgentRuntime.ts` |
| Claude CLI adapter | VERIFIED | `src/main/runtimes/claudeCliRuntime.test.ts` | `src/main/runtimes/claudeCliRuntime.ts` |
| Antigravity CLI adapter | VERIFIED | `src/main/runtimes/antigravityCliRuntime.test.ts` | `src/main/runtimes/antigravityCliRuntime.ts` |
| Generic CLI adapter | VERIFIED | `src/main/runtimes/genericCliRuntime.test.ts` | `src/main/runtimes/genericCliRuntime.ts` |
| Pre-launch folder-trust automation | VERIFIED | `src/main/runtimes/claudeTrust.test.ts` (8) | `src/main/runtimes/claudeTrust.ts` |
| PTY process hosting (ConPTY / node-pty) | VERIFIED | `src/main/runtimes/ptyProcessRunner.test.ts` | `src/main/runtimes/ptyProcessRunner.ts` |
| Terminal session registry | VERIFIED | `src/main/terminal/sessionRegistry.test.ts` | `src/main/terminal/sessionRegistry.ts` |
| Account isolation per runtime | VERIFIED | `src/main/runtimes/accountSwitch.integration.test.ts` | `src/main/accounts/` |

> The runtime module is `src/main/runtimes/claudeTrust.ts`, and PTY hosting lives in
> `ptyProcessRunner.ts` with session state in `src/main/terminal/`. There is no
> `claudeTrustStore.ts` and no `src/main/runtimes/terminalSession.ts`.

### 2.6 Desktop shell

| Capability | Status | Evidence | Implementation |
| :--- | :--- | :--- | :--- |
| Typed IPC contract & router parity | VERIFIED | `npm run check:router` gate | `src/shared/ipc.ts`, `src/main/ipc/` |
| Context-isolated preload bridge | VERIFIED | `npm run smoke` gate | `src/preload/` |
| React renderer & design system | VERIFIED | `npm run check:ui`, `npm run test:e2e` | `src/renderer/` |
| Terminal TUI for the CLI | PLANNED | none on `main` | — |

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
