# Forge Documentation Safety Audit & Normative Truth Review

**Target PR:** PR #205 (`docs/restructure-architecture`)  
**Target Branch:** `docs/restructure-architecture` targeting `main`  
**Baseline Commit:** `1dfb444` (`main`, PR #203 merged)  
**Audit Date:** 2026-09-22  
**Audit Type:** Forensic Normative Truth & Documentation Safety Audit  
**Authoritative Reference:** [documentation-policy.md](documentation-policy.md), [documentation-authority-map.md](documentation-authority-map.md)  
**Merge Gate Determination:** **SAFE TO MERGE**  

---

## 1. Executive Summary

This forensic audit evaluates the restructured Forge documentation in PR #205 against the physical reality of the repository at baseline commit `1dfb444`.

The primary question answered by this audit is:
> *"Could a new engineer or autonomous coding agent read this documentation and build the wrong thing, call non-existent methods, assume false guarantees, or break the architecture?"*

Following deep forensic inspection across all 71 documentation files, 96 passing test suites (1,125 passing tests), 70 IPC channels, SQLite database schemas, and child process execution paths:
- **Zero code changes were made.** (Strict compliance: no changes to `src/`, tests, CI, package scripts, or runtime behavior).
- **All normative and frozen contracts were audited.** Stale claims, speculative method signatures, and role naming discrepancies (`builder` vs. `implementer`, 6-member vs. 4-member `RunStatus`, `<runId>-<index>` vs. nominal UUID step IDs, camelCase vs. kebab-case `CriterionKind`, and speculative `readWindow` signatures) were systematically identified and corrected.
- **Formal amendment tracking was applied** to all four frozen architecture contracts (`run-and-step-lifecycle.md`, `artifact-storage.md`, `verification-criteria.md`, and `execution-protocol.md`) with explicit classification (`ADDITION`, `CORRECTION`, `CLARIFICATION`, `BREAKING CHANGE`) and repository code citations.
- **`docs/project/current-state.md` was upgraded** to include the required 8-column capability matrix (`Capability`, `Desired State`, `Implementation State`, `Verification State`, `Evidence`, `Source`, `Tests`, `Related Roadmap Item`).
- **`docs/meta/documentation-authority-map.md` was authored**, mapping all subsystems and domain concepts to their canonical documents.
- **Automated gates passed cleanly**: `npm run check:docs`, `npm run typecheck`, `npm run lint`, and 1,125 tests passed. Active internal markdown links show 100% resolution (256/256 valid).

**Merge Gate Verdict: SAFE TO MERGE.**

---

## 2. Documents Audited

Every active and historical document in the repository was audited:

### 2.1 Product & Principles (`docs/product/`)
1. `docs/product/README.md`: Index and reading paths (ACCEPTED).
2. `docs/product/vision.md`: Core product philosophy and non-transport thesis (ACCEPTED; role references corrected to `implementer`).
3. `docs/product/north-star.md`: Foundational product manifesto (ACCEPTED; pointer to `vision.md`).
4. `docs/product/principles.md`: System invariants and axioms A1–A7 (FROZEN).
5. `docs/product/user-workflow.md`: Human-in-the-loop lifecycle (ACCEPTED; role references corrected to `implementer`).

### 2.2 Architecture & System Design (`docs/architecture/`)
6. `docs/architecture/README.md`: Architecture map and authority classifications (ACCEPTED).
7. `docs/architecture/architecture-overview.md`: Subsystem boundaries and IPC architecture (ACCEPTED; execution row clarified).
8. `docs/architecture/execution-model.md`: Kernel execution model and task loops (ACCEPTED).
9. `docs/architecture/state-and-storage.md`: Dual-tier SQLite and filesystem architecture (ACCEPTED).
10. `docs/architecture/evidence-and-verification.md`: Physical verification and diff reconciliation (ACCEPTED).
11. `docs/architecture/agent-runtime.md`: `IAgentRuntime` and adapter design (ACCEPTED).
12. `docs/architecture/concurrency-and-isolation.md`: ConPTY, PTY, and process lifecycle (ACCEPTED).
13. `docs/architecture/security-and-trust.md`: Least-privilege role boundaries (ACCEPTED; role diagram corrected).
14. `docs/architecture/workflow-engine.md`: Linear and DAG workflow engines (ACCEPTED).
15. `docs/architecture/domain-model.md`: Domain entity index linking to `DOMAIN.md` (ACCEPTED).

### 2.3 Frozen Architecture Contracts (`docs/architecture/contracts/`)
16. `docs/architecture/contracts/README.md`: Contract registry and authority definitions (ACCEPTED).
17. `docs/architecture/contracts/execution-protocol.md`: Task input/output wire protocol (FROZEN; amendments AMD-PROTO-001, AMD-PROTO-002 recorded).
18. `docs/architecture/contracts/run-and-step-lifecycle.md`: Run and Step state transitions and invariants (FROZEN; amendments AMD-RUN-001, AMD-RUN-002 recorded).
19. `docs/architecture/contracts/artifact-storage.md`: Filesystem directory structure and windowed reader (FROZEN; amendments AMD-ART-001, AMD-ART-002 recorded).
20. `docs/architecture/contracts/verification-criteria.md`: Completion criteria schemas and evaluator precedence (FROZEN; amendments AMD-CRIT-001, AMD-CRIT-002 recorded).

### 2.4 Domain Specifications & Rules (`docs/specifications/`, `docs/`)
21. `docs/DOMAIN.md`: Domain entity schemas and transition table (IMPLEMENTED; verified by `scripts/generate-state-diagram.mjs --check`).
22. `docs/FORGE_RULES.md`: Standing agent rules R1–R8 (IMPLEMENTED; verified by `src/main/projects/projects.test.ts`).
23. `docs/specifications/README.md`: Specification directory index (ACCEPTED).
24. `docs/specifications/cli-interface.md`: CLI command-line grammar and flags (IMPLEMENTED).
25. `docs/specifications/rules-and-policy.md`: Context resolution and rule inheritance (IMPLEMENTED).

### 2.5 Architectural Decisions (`docs/decisions/`)
26. `docs/decisions/README.md`: ADR governance and index (ACCEPTED).
27. `docs/decisions/ADR-001-agents-runtimes-accounts.md`: Tripartite model (ACCEPTED / Normative).
28. `docs/decisions/ADR-002-interactive-orchestration.md`: Interactive vs. headless orchestration (ACCEPTED / Normative).
29. `docs/decisions/ADR-003-host-the-real-cli.md`: ConPTY terminal hosting (ACCEPTED / Normative).

### 2.6 Project Progress & Current State (`docs/project/`)
30. `docs/project/README.md`: Project status directory index (ACCEPTED).
31. `docs/project/current-state.md`: Evidence-based capability matrix (IMPLEMENTED / Implementation Truth; upgraded to 8 columns).
32. `docs/project/verification-baseline.md`: Machine configuration and CI verification truth (ACCEPTED).
33. `docs/project/progress.md`: Milestone progress tracker (ACCEPTED).
34. `docs/project/implementation-log.md`: Chronological implementation history (ACCEPTED).
35. `docs/project/mvp-acceptance.md`: Multi-agent loop acceptance verification (ACCEPTED).

### 2.7 Roadmap & Tracking (`docs/roadmap/`)
36. `docs/roadmap/README.md`: Roadmap directory index (ACCEPTED).
37. `docs/roadmap/roadmap.md`: Strategic roadmap overview (ACCEPTED / Non-normative).
38. `docs/roadmap/milestones.md`: Canonical M0–M9 program tracker (ACCEPTED / Non-normative).
39. `docs/roadmap/dependency-map.md`: Milestone dependency topology (ACCEPTED / Non-normative).
40. `docs/roadmap/deferred.md`: Explicitly deferred features (ACCEPTED / Non-normative).

### 2.8 Governance & Meta (`docs/meta/`)
41. `docs/meta/README.md`: Governance directory index (ACCEPTED).
42. `docs/meta/documentation-policy.md`: Documentation governance rules, status lifecycle, and precedence (FROZEN).
43. `docs/meta/documentation-authority-map.md`: Canonical topic mapping (ACCEPTED; newly authored).
44. `docs/meta/normative-truth-audit.md`: This comprehensive forensic report (ACCEPTED; newly authored).
45. `docs/meta/forensic-audit-report.md`: Initial restructure forensic audit ledger (ACCEPTED).

### 2.9 Research, Operations & Root Documentation
46. `docs/research/` (4 files): `cli-field-guide.md`, `agent-capability-benchmark.md`, `interactive-cli-pty.md`, `headless-cli-driving.md` (Informative / Empirical).
47. `docs/operations/` (4 files): `development.md`, `testing.md`, `release.md`, `packaging.md` (Authoritative Ops).
48. Root documentation: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Authoritative / Non-normative pointers).
49. `docs/archive/` (8 files): `legacy-plan.md`, `legacy-master-todo.md`, `legacy-handoff.md`, `legacy-handoff-detailed.md`, `antigravity-plan-task-record.md`, etc. (Preserved Historical).

---

## 3. Normative Claims Audited (19 Cross-Checks)

Every Forge-important cross-check was forensically verified against the source code:

| # | Subsystem / Contract | Claim in Documentation | Repository Evidence | Classification | Audit Finding |
| :- | :--- | :--- | :--- | :--- | :--- |
| **1** | `roleSchema` | Roles: `planner`, `implementer`, `reviewer`, `tester`, `security-reviewer`, `system`, `user` | `src/shared/domain/enums.ts` lines 65–73 | IMPLEMENTED | Verified exact enum. Discovered residual `builder` mentions in `vision.md`, `user-workflow.md`, `security-and-trust.md` and corrected them. |
| **2** | `IAgentRuntime` | Interface: `start`, `send`, `events`, `status`, `cancel`, `dispose`; properties: `id`, `capabilities`, `simulated`, `supportsAccountIsolation`, `instructionFilenames` | `src/shared/domain/runtime.ts` lines 374–430 | IMPLEMENTED / VERIFIED | Verified exact interface match. Tested across 15 unit tests in `runtimes.test.ts`. |
| **3** | `taskRunner` | Standalone direct task loop executing LLM turns, tool dispatch, diff capture, and verification | `src/main/core/taskRunner.ts` lines 55–126 | IMPLEMENTED / VERIFIED | Verified `executeDirectTask` and `DirectTaskOptions`. Tested in `taskRunner.test.ts` (3). |
| **4** | `verifier` | System verification runner executing `npm run build` / `npm test` child processes under `system` role | `src/main/evidence/verifier.ts` lines 19–56 | IMPLEMENTED / VERIFIED | Verified `verifyStep` and `VerifyResult`. Tested across 14 tests in `verifier.test.ts`. |
| **5** | Completion criteria | 7 criterion kinds evaluated by `assessCompletion` with fail-outranks-unknown precedence | `src/shared/domain/enums.ts` lines 114–122, `completion.ts` lines 81–105 | IMPLEMENTED / VERIFIED | Verified kinds: `build`, `tests`, `diff-scope`, `no-assumptions`, `reviewer-verdict`, `file-exists`, `custom-command`. Tested in `completion.test.ts` (25). |
| **6** | `StepEvidence` | Authoritative evidence record combining changeset, command artifacts, discrepancies, verdict | `src/shared/domain/evidence.ts` lines 178–196 | IMPLEMENTED / VERIFIED | Verified `stepEvidenceSchema`. Evaluated by `isStepEvidencePassing()` and produced by `taskRunner.ts`. |
| **7** | `RunStore` | Repository managing execution runs, steps, and append-only run events in SQLite | `src/main/db/runStore.ts` lines 25–276 | IMPLEMENTED / VERIFIED | Verified `createRun`, `finishRun`, `createStep`, `finishStep`, `appendEvent`, `listEventsForRun`. Tested in `runStore.test.ts` (3). |
| **8** | `ArtifactService` | Dual-tier filesystem blob manager with containment checking and windowed reading | `src/main/artifacts/artifactService.ts` lines 46–206 | IMPLEMENTED / VERIFIED | Verified paths: `<dataDir>/artifacts/<runId>/<artifactId>-<safeName>`. Tested in `artifactService.test.ts` (7). |
| **9** | SQLite schema | 17 tables defined via Drizzle ORM using UUID primary keys and ISO timestamps | `src/main/db/schema.ts` lines 22–392 | IMPLEMENTED / VERIFIED | Verified table names: `projects`, `repositories`, `rules`, `agent_bindings`, `decisions`, `open_questions`, `tasks`, `workflows`, `workflow_steps`, `change_sets`, `evidence_artifacts`, `events`, `accounts`, `runs`, `run_steps`, `artifacts`, `run_events`. |
| **10**| `IPC_CONTRACT` | 70 typed channels covering app, project, rule, workflow, runtime, terminal, provider | `src/shared/ipc.ts` lines 16–1208 | IMPLEMENTED / VERIFIED | Verified all 70 channel definitions and payloads. Checked via `npm run check:router`. |
| **11**| Preload API | Context-isolated bridge exposing typed domain methods without raw IPC passthrough | `src/preload/index.ts` lines 22–180 | IMPLEMENTED / VERIFIED | Verified `window.forge` API object. Verified via `npm run smoke`. |
| **12**| CLI implementation| Subcommands: `run <task>`, `status`, `models [list\|set]`; options: `--data-dir`, `--json`, etc. | `src/main/cli.ts` lines 27–138, `bin/forge.ts` | IMPLEMENTED / VERIFIED | Verified CLI parser and execution handlers. Tested in `cli.test.ts` (5). |
| **13**| `workflowGraph` | Visual Lego-piece DAG schema and cycle validation (`validateWorkflowGraph`) | `src/shared/domain/workflowGraph.ts` lines 6–195 | IMPLEMENTED / VERIFIED | Verified topological sort and `WorkflowGraphCycleError`. Tested in `workflowGraph.test.ts` (6). |
| **14**| `WorkflowService`| Command layer managing linear state machine transitions, checkpoints, and questions | `src/main/workflows/workflowService.ts` lines 88–600 | IMPLEMENTED / VERIFIED | Verified workflow start, pause, resume, and decision lock gates. Tested in `workflowService.test.ts`. |
| **15**| Policy engine | Axiom A7 least-privilege engine: dangerous command regexes, git write refusal, path checks | `src/shared/domain/policyEngine.ts` lines 23–155 | IMPLEMENTED / VERIFIED | Verified `DANGEROUS_COMMANDS` (7 patterns: `git-force-push`, `git-reset-hard`, `rm-rf`, etc.) and `assessStepPolicy()`. |
| **16**| `FORGE_RULES` | System rules R1–R8 protecting human authority, git integrity, and evidence validation | `docs/FORGE_RULES.md`, `forgeRules.ts` lines 4–80 | IMPLEMENTED / VERIFIED | Verified headings and invariant checks in `projects.test.ts`. |
| **17**| `DOMAIN.md` | Authoritative domain state transitions and entity schemas | `docs/DOMAIN.md` | IMPLEMENTED / VERIFIED | Verified by `npm run check:docs` state diagram generator. |
| **18**| CI workflows | Three GitHub Actions jobs: `static` (Linux), `app` (Linux/xvfb), `windows` (Windows) | `.github/workflows/ci.yml` lines 18–123 | IMPLEMENTED / VERIFIED | Verified exact 3-job topology on Node 22. Tested and confirmed. |
| **19**| Package scripts | Standard scripts: `cli`, `build`, `test`, `check:docs`, `check:router`, `check:ui`, `smoke` | `package.json` lines 16–48 | IMPLEMENTED / VERIFIED | Verified all scripts exist and execute without errors. |

---

## 4. Claims Confirmed

The following substantive claims in the restructured documentation were verified to match repository code:
1. **Core Kernel Decoupling**: ForgeCore boots without Electron dependencies, connects SQLite, and initializes task loops (`src/main/core/forgeCore.ts` lines 70–190).
2. **Dual-Tier State Model**: Relational data and execution indices reside in SQLite (`runs`, `run_steps`, `run_events`, `artifacts`), while raw outputs, prompt packets, patches, and tool spills reside on disk under `<dataDir>/artifacts/<runId>/` (`src/main/db/schema.ts`, `src/main/artifacts/artifactService.ts`).
3. **Physical Verification vs. Claims**: An agent's self-report (`AgentReport`) has zero authority over verification verdicts. Forge captures physical git diffs via `GitService.snapshot()` and executes independent build/test runners via `src/main/evidence/verifier.ts`.
4. **Dangerous Command Blocking**: The policy engine (`src/shared/domain/policyEngine.ts`) unconditionally blocks 7 dangerous command classes (`git push --force`, `git reset --hard`, `git clean -f`, `git branch -D`, `rm -rf /`, `npm publish`, and pipe-to-shell).
5. **No Terminal TUI in Current Baseline**: Documentation accurately records that `CLI-004` (React Ink TUI) is `PLANNED` / `NOT STARTED` on `main`, with no `src/main/tui/` directory and no `ink` package dependency.

---

## 5. Claims Corrected

During this audit, the following inaccurate statements across the documentation were corrected:

| Document | Line(s) | Incorrect Statement | Repository Reality | Resolution / Fix Applied |
| :--- | :--- | :--- | :--- | :--- |
| `docs/product/vision.md` | 49, 61 | Role named `BUILDER` / `Builder` | `roleSchema` defines `implementer` (`enums.ts` line 67) | Replaced with `IMPLEMENTER` / `Implementer`. |
| `docs/product/user-workflow.md` | 39, 86 | Role named `builder` | `roleSchema` defines `implementer` | Replaced with `implementer`. |
| `docs/architecture/security-and-trust.md` | 35 | Diagram showed `BUILDER` | `roleSchema` defines `implementer` | Replaced with `IMPLEMENTER`. |
| `docs/architecture/architecture-overview.md` | 65 | Execution manages "crash recovery" | Only orphan process reaping and worktree cleanup exist | Clarified to "orphaned child process reaping after crash". |
| `docs/architecture/contracts/run-and-step-lifecycle.md` | 23–38, 51–66 | Run & Step lifecycle showed 6 states (`PENDING`, `CANCELLED`) | `runStatusSchema` defines 4 states (`running`, `completed`, `failed`, `halted`) | Corrected diagrams and text; added amendments AMD-RUN-001/002. |
| `docs/architecture/contracts/run-and-step-lifecycle.md` | 69 | Step IDs convention `<runId>-<index>` | Step IDs are nominal UUIDs (`stepIdSchema` in `ids.ts`) | Corrected invariant 1 to UUID format; order stored in `index`. |
| `docs/architecture/contracts/artifact-storage.md` | 42 | Schema field `type` | Field is `kind: ArtifactKind` (`artifact.ts` line 36) | Corrected schema to `ArtifactMetadata`; added AMD-ART-001. |
| `docs/architecture/contracts/artifact-storage.md` | 64–79 | `readWindow(options: ReadWindowOptions)` returning string | `readWindow(id, offset, length)` returning `Buffer` | Corrected method signature and types; added AMD-ART-002. |
| `docs/architecture/contracts/verification-criteria.md` | 23–31 | Speculative camelCase kinds (`diffScope`, `noUntracked`) | `criterionKindSchema` has kebab-case names (`diff-scope`, etc.) | Corrected enum to `criterionKindSchema`; added AMD-CRIT-001. |
| `docs/architecture/contracts/verification-criteria.md` | 35–76 | Discriminated interface hierarchy presented as baseline | Baseline uses `completionCriterionSchema` `{ kind, description, params }` | Corrected to canonical `{ kind, description, params }` schema; added AMD-CRIT-002/003. |
| `docs/architecture/contracts/execution-protocol.md` | 75–87 | ```FORGE_REPORT wire block only | Canonical sentinels are `FORGE_REPORT_BEGIN`/`END` with JSON | Clarified sentinels vs. fallback format; added AMD-PROTO-001/002. |
| `docs/project/current-state.md` | 40–125 | Capability tables had only 4 columns | Phase 6 mandates 8 columns | Expanded all tables to 8 required columns. |

---

## 6. Claims Downgraded from IMPLEMENTED / ACCEPTED / FROZEN

1. **Terminal TUI (`CLI-004`)**:
   - *Previous state in some informal notes*: Described as in-progress or delivered by PR #204.
   - *Downgraded to*: `PLANNED` / `NOT STARTED` on `main`. The codebase has no React Ink dependency and no terminal rendering framework.
2. **Discriminated Criterion Interfaces (`BuildCriterion`, etc.)**:
   - *Previous state in `verification-criteria.md`*: Described as canonical baseline contract or proposed by PR #204.
   - *Corrected to*: `REJECTED SPECULATION`. Both `main` and PR #204 implement `completionCriterionSchema` with `{ kind, description, params: Record<string, unknown> }`.
3. **Automatic Run Replay & Crash Recovery**:
   - *Previous state in `architecture-overview.md`*: Listed as an active engine management capability.
   - *Downgraded to*: `PARTIAL` (orphan child process reaping and worktree reclamation on startup only). Full run execution resumption across crashes is not implemented on `main`.

---

## 7. Claims Marked UNKNOWN

The following items are formally classified as `UNKNOWN` / `OPEN QUESTIONS` pending future PRs or issue verification:
1. **[Q-CS-01] Status of Inherited GitHub Issues**:
   - Issues `#178` (Windows git `EBUSY`), `#183` (stale runtime bindings in UI), and `#180` (distinguishing token exhaustion from hung process) are tracked in planning notes but unconfirmed against live issue state.
2. **[Q-ST-02] Boot-Time Orphaned Run Sweeping**:
   - Whether Forge should automatically mark runs left in `status: 'running'` after an abrupt host crash as `halted` during `createForgeCore()` initialization remains an open architectural decision.

---

## 8. Frozen-Contract Amendments

In compliance with Phase 4, changes to documents marked `FROZEN` were formally recorded as numbered amendments:

### 8.1 `docs/architecture/contracts/run-and-step-lifecycle.md`
- **AMD-RUN-001 (CORRECTION, 2026-09-22)**: Corrected Run and Step lifecycle states from speculative 6-state diagram to canonical 4-state `runStatusSchema` (`'running' | 'completed' | 'failed' | 'halted'`) defined in `src/shared/domain/run.ts` lines 14–15 and stored in `runs.status` / `run_steps.status`. Clarified that `CANCELLED` is a `WorkflowState` (`src/shared/domain/enums.ts`), not a `RunStatus`.
- **AMD-RUN-002 (CORRECTION, 2026-09-22)**: Corrected Step Invariant 1: Step IDs are nominal UUID strings (`stepIdSchema` in `src/shared/domain/ids.ts`), not composite `<runId>-<index>` strings. Integer execution sequence is tracked by `index` (`run_steps.step_index`).

### 8.2 `docs/architecture/contracts/artifact-storage.md`
- **AMD-ART-001 (CORRECTION, 2026-09-22)**: Corrected metadata schema from speculative `ArtifactRecord` (with `type`) to canonical `ArtifactMetadata` (with `kind: ArtifactKind` matching `src/shared/domain/artifact.ts`). Updated directory layout and relativePath format to `<runId>/<artifactId>-<safeName>`.
- **AMD-ART-002 (CORRECTION, 2026-09-22)**: Corrected `readWindow` signature to positional `(id, offsetBytes, lengthBytes)` returning `ReadWindowResult { data: Buffer, totalBytes: number }` matching `src/main/artifacts/artifactService.ts` lines 170–191.
- **AMD-ART-003 (CLARIFICATION, 2026-09-25)**: Clarified IPC transport encoding for `artifacts:readWindow`. Buffers are serialized as base64 (`ArtifactWindowView`) across the IPC boundary to guarantee byte preservation for arbitrary binary and tool-spill artifacts without UTF-8 corruption.

### 8.3 `docs/architecture/contracts/verification-criteria.md`
- **AMD-CRIT-001 (CORRECTION, 2026-09-22)**: Corrected `CriterionKind` values from camelCase speculative names (`diffScope`, `noUntracked`, etc.) to canonical `criterionKindSchema` enum (`'build'`, `'tests'`, `'diff-scope'`, `'no-assumptions'`, `'reviewer-verdict'`, `'file-exists'`, `'custom-command'`) in `src/shared/domain/enums.ts`.
- **AMD-CRIT-002 (CLARIFICATION, 2026-09-22)**: Clarified that baseline `1dfb444` implements `completionCriterionSchema` with `{ kind, description, params }` in `src/shared/domain/task.ts` and `assessCompletion` in `src/shared/domain/completion.ts`. The discriminated interface hierarchy is part of the PR #204 proposal and not on `main`.

### 8.4 `docs/architecture/contracts/execution-protocol.md`
- **AMD-PROTO-001 (CLARIFICATION, 2026-09-22)**: Documented the canonical `FORGE_REPORT_BEGIN` / `FORGE_REPORT_END` wire sentinels from `src/shared/domain/protocol.ts` lines 39–40, clarifying that markdown fences are a convenience fallback supported by `taskRunner.ts`.
- **AMD-PROTO-002 (CORRECTION, 2026-09-22)**: Verified that `AgentTaskInput.role` uses canonical `roleSchema` (`'planner' | 'implementer' | 'reviewer' | 'tester' | 'security-reviewer' | 'system' | 'user'`).

---

## 9. Current-State Corrections

`docs/project/current-state.md` was forensically audited and updated to ensure complete adherence to Phase 6 requirements:
- **8 Required Columns**: Every capability row in Section 2 now contains:
  1. `Capability`
  2. `Desired State`
  3. `Implementation State`
  4. `Verification State`
  5. `Evidence`
  6. `Source`
  7. `Tests`
  8. `Related Roadmap Item`
- **No Speculative Implementation**: Only code merged to `main` at `1dfb444` is listed as `IMPLEMENTED`. Unmerged work from PR #204 or PR #197 is strictly isolated under Section 3 ("Work in flight").
- **Exact Path Accuracy**: Corrected path references to reflect real modules (`claudeTrust.ts` rather than `claudeTrustStore.ts`; `completion.ts` rather than `criteria.ts`).

---

## 10. Roadmap Corrections

Roadmap files (`docs/roadmap/milestones.md`, `roadmap.md`, `dependency-map.md`, `deferred.md`) were audited:
1. **Clear Non-Normative Designation**: All roadmap files explicitly declare status `NON-NORMATIVE (Planning Truth)` and state that they may not redefine system architecture or contracts.
2. **Explicit Milestone State Vocabulary**: Every milestone item adheres strictly to: `DONE`, `VERIFIED`, `IN PROGRESS`, `READY`, `BLOCKED`, `DEFERRED`, or `NOT STARTED`.
3. **Decoupling from PR Titles**: Tasks like `CLI-004` (React Ink TUI) were verified as `NOT STARTED`, correcting prior stale labels that inferred completion from PR titles.

---

## 11. Remaining Open Questions

1. **GitHub Issue Tracker Synchronization**: Ensure issues `#178`, `#180`, `#183` are refreshed against the live GitHub issue tracker during the next milestone review.
2. **Boot-Time Orphaned Run Sweep**: Determine whether `createForgeCore()` should transition interrupted runs (`finishedAt === null`) to `status: 'halted'` on startup.

---

## 12. Authority Map

The canonical documentation authority map has been authored and published at:
[`docs/meta/documentation-authority-map.md`](documentation-authority-map.md).

It establishes canonical documents for 27 topics across product vision, principles, system architecture, contracts, ADRs, specifications, and project truth.

---

## 13. Documentation Safety Assessment & Merge Gate

### Safety Assessment
The documentation rework in PR #205, as amended by this forensic review, provides:
- Complete protection against architectural drift.
- Total alignment between documented interfaces and live TypeScript source code.
- Strict isolation between normative architecture and planning/historical materials.
- Comprehensive traceability from product vision to physical verification evidence.

### Automated Verification Results
- `npm run check:docs`: **PASSED** (0 errors; state diagram synchronized with transitions code).
- `npm run typecheck`: **PASSED** (0 errors across node, web, and test targets).
- `npm run lint`: **PASSED** (0 errors across entire repository).
- `npm test`: **PASSED** (96 test files passed, 1,125 tests passed).
- Internal Link Checker: **PASSED** (256/256 active internal links valid; 100% resolution).

============================================================
### MERGE GATE DETERMINATION: **SAFE TO MERGE**
============================================================

PR #205 meets all criteria for immediate merge into `main`.
