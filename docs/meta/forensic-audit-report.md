# Forge Documentation Forensic Audit Report

**Status:** ACCEPTED  
**Date:** 2026-09-21  
**Target Repository:** `mdsaif45/forge-orchestrator`  
**Baseline Commit:** `1dfb444` (`main`, PR #203 merged)  
**Scope:** Complete repository documentation inventory, authority analysis, contradiction detection, and classification.

---

## 1. Executive Summary

A comprehensive forensic audit of the Forge repository documentation was conducted prior to executing the documentation architecture rework.

The audit revealed high-value, empirically grounded engineering decisions (such as Windows ConPTY measurements, IPC serialization constraints, GitService diffing guarantees, and SQLite state schemas) trapped inside a fragmented documentation structure. 

Crucially, the audit uncovered three primary systemic failure modes:
1. **Severe Architectural Contradiction**: The root `README.md` maintained stale pre-alpha claims ("you stay out of the message bus", "in M0. No agent orchestration exists yet") which directly contradict both `docs/NORTH-STAR.md` (which explicitly denounces that exact statement) and the live repository code (where Headless Core `createForgeCore`, SQLite persistence `RunStore`/`ArtifactStore`, native agent loop `taskRunner`, and CLI execution are fully merged and tested across 1,125 tests).
2. **Responsibility Pollution**: Single documents routinely mixed normative architectural contracts with historical agent execution logs, task checklists, and unvalidated aspirational ideas. Most prominently, `docs/decisions/` contained a 170-line task checklist (`ADR-001-TASKS.md`), and normative documentation was weighed down by a 1,663-line agent transcript (`docs/ANTIGRAVITY-PLAN-TASK-RECORD.md`, 102 KB) and root handoff logs (307 KB).
3. **Stale Tracking as Truth**: Planning documents (`docs/PLAN.md` and `docs/FORGE-MASTER-TODO.md`) were operating under conflicting milestone structures (M0–M6 legacy vs. M0–M9 master todo) and had already fallen behind merged PRs (e.g. `STATE-001` was marked as `READY` despite being fully merged on `main` via PR #203).

---

## 2. Inventory and Document Classification

Every existing documentation file in the repository has been audited and classified into its single primary responsibility:

| File Path | Original Responsibility | Identified Classification | Authority Level | Primary Findings |
| :--- | :--- | :--- | :--- | :--- |
| `README.md` | Front-door project introduction | **PRODUCT / LANDING** (Contaminated) | Non-normative | Contradicts `NORTH-STAR.md` and live code; claims M0 pre-alpha with no orchestration. |
| `CLAUDE.md` | Coding agent conventions & constraints | **SPECIFICATION / AGENT POLICY** | Authoritative (Agent) | High-integrity rules; references legacy file paths that need alignment. |
| `CONTRIBUTING.md` | Contributor workflow & boundaries | **OPERATIONS / WORKFLOW** | Authoritative (Dev) | Accurate lint and branch rules. |
| `CODE_OF_CONDUCT.md` | Community participation guidelines | **OPERATIONS / POLICY** | Authoritative | Standard Contributor Covenant. |
| `SECURITY.md` | Security vulnerability reporting & posture | **OPERATIONS / SECURITY** | Authoritative | Accurate threat posture; notes lack of OS sandbox. |
| `HANDOFF.md` | Agent session handoff summary | **HISTORICAL / AGENT LOG** | Non-normative | Transitory agent notes (1.5 KB). |
| `HANDOFF-DETAILED.md` | Agent session detailed history | **HISTORICAL / AGENT LOG** | Non-normative | Transitory agent log (307 KB). Should be archived. |
| `docs/ARCHITECTURE.md` | System design, IPC, security, git | **ARCHITECTURE** (Monolithic) | Authoritative (Mixed) | 1,128 lines covering 10 distinct subsystems. High factual value, poor navigability. |
| `docs/DOMAIN.md` | Entities, state machine, transitions | **SPECIFICATION / DOMAIN MODEL** | Authoritative (Normative) | Bound to `scripts/generate-state-diagram.mjs` and `npm run check:docs`. Must retain markers. |
| `docs/PLAN.md` | Legacy build plan & axioms | **ROADMAP / HISTORICAL** | Superseded | M0–M6 sequence from August 2026; superseded by modern master tracker. |
| `docs/NORTH-STAR.md` | Product vision, human loop, PTY thesis | **PRODUCT / VISION** | Authoritative (Vision) | The core product manifesto. Grounded in measured user workflow. |
| `docs/FORGE_RULES.md` | System agent rules R1–R8 | **SPECIFICATION / RULES** | Authoritative (Normative) | Bound to `src/main/projects/projects.test.ts`. Must retain exact headings. |
| `docs/FORGE-MASTER-TODO.md` | Program tracker (M0–M9) | **ROADMAP / PROGRESS** (Mixed) | Planning Truth | Mixes planning intent with status. Drifting behind merged PRs. |
| `docs/MVP_ACCEPTANCE.md` | Multi-agent closed-loop acceptance | **PROJECT / ACCEPTANCE RECORD** | Historical Evidence | Valid evidence report for early multi-agent loop milestone. |
| `docs/CLI-FIELD-GUIDE.md` | Empirical agent CLI & ConPTY facts | **RESEARCH / FIELD GUIDE** | Authoritative (Empirical) | High-value measured findings on Claude, Antigravity, ConPTY, trust flags. |
| `docs/RELEASE.md` | Release runbook, packaging, signing | **OPERATIONS / RELEASE** | Authoritative (Ops) | Clear instructions for `electron-builder` and GitHub release flow. |
| `docs/ANTIGRAVITY-PLAN-TASK-RECORD.md` | Agent task execution record | **HISTORICAL / ARCHIVE** | Non-normative | 1,663 lines (102 KB) of past execution transcripts. |
| `docs/decisions/ADR-001-agents-runtimes-accounts.md` | Agent / runtime / account separation | **DECISION** | Authoritative (Normative) | Accepted architectural decision. |
| `docs/decisions/ADR-001-TASKS.md` | Implementation task list for ADR-001 | **HISTORICAL / TASK LIST** | Non-normative | Task list misplaced in decision directory. |
| `docs/decisions/ADR-002-interactive-orchestration.md` | Interactive orchestration vs headless | **DECISION** | Authoritative (Normative) | Accepted architectural decision. |
| `docs/decisions/ADR-003-host-the-real-cli.md` | Host real CLI in ConPTY/tmux | **DECISION** | Authoritative (Normative) | Accepted architectural decision. |
| `docs/spikes/agent-cli-capability.md` | Headless CLI driving feasibility | **SPIKE** | Research Evidence | Empirical test of Claude vs Antigravity headless modes. |
| `docs/spikes/interactive-cli-pty.md` | ConPTY terminal hosting feasibility | **SPIKE** | Research Evidence | Empirical test of ConPTY interactive session hosting. |

---

## 3. Authoritative Document Map

Before this rework, authority was undefined and informal. The following table identifies what *was* acting as authoritative truth versus what *must* be authoritative going forward:

| Domain / Question | Previous Source | Issues Identified | Canonical Source (New Architecture) |
| :--- | :--- | :--- | :--- |
| **Product Purpose & UX** | `docs/NORTH-STAR.md` vs `README.md` | Direct contradiction on user role | `docs/product/vision.md` & `docs/product/north-star.md` |
| **System Architecture** | `docs/ARCHITECTURE.md` | Monolithic, mixes IPC with child processes | `docs/architecture/architecture-overview.md` (+ modular docs) |
| **Domain State Machine** | `docs/DOMAIN.md` | Entangled with build script invariants | `docs/DOMAIN.md` (preserved) & `docs/architecture/domain-model.md` |
| **Agent Execution Rules** | `docs/FORGE_RULES.md` | Entangled with test assertions | `docs/FORGE_RULES.md` (preserved) & `docs/specifications/rules-and-policy.md` |
| **Architectural Choices** | `docs/decisions/ADR-*.md` | ADR-001 contained task list | `docs/decisions/README.md` + individual `ADR-*.md` |
| **Roadmap & Priorities** | `docs/PLAN.md` vs `FORGE-MASTER-TODO.md` | Conflicting milestone structures | `docs/roadmap/roadmap.md` & `docs/roadmap/milestones.md` |
| **Implementation Reality** | None (inferred from code / PRs) | Drift between TODO and merged PRs | `docs/project/current-state.md` & `docs/project/verification-baseline.md` |
| **Third-Party CLI Facts** | `docs/CLI-FIELD-GUIDE.md` | Mixed with top-level root docs | `docs/research/cli-field-guide.md` |
| **Release Procedures** | `docs/RELEASE.md` | Sits at top-level `docs/` | `docs/operations/release.md` |

---

## 4. Contradiction Ledger

The audit discovered specific, documented contradictions across the repository. None are resolved silently:

### Contradiction C-01: User Role in Orchestration Loop
- **Statement A (`README.md`, lines 6–7)**: *"Multiple coding agents collaborate on the same software project under a shared execution protocol — planning, implementing, verifying, and reviewing — while you stay out of the message bus."*
- **Statement B (`docs/NORTH-STAR.md`, lines 16–21)**: *"The user stays in the loop. They just stop being the transport. Forge's README originally said the opposite — 'you stay out of the message bus' — and that framing produced a product that was slower and less capable than doing the work by hand."*
- **Physical Reality**: `NORTH-STAR.md`, ADR-002, and the Electron UI place the human at the center of decision locks, plan approval, and mid-flight steering.
- **Resolution**: `README.md` must be updated to align with the authoritative North Star vision ("The user stays in the loop. They just stop being the transport.").

### Contradiction C-02: Project Status and Agent Orchestration Existence
- **Statement A (`README.md`, lines 200–204)**: *"Pre-alpha, in M0. The app boots with a hardened process boundary... No agent orchestration exists yet — that begins at M2."*
- **Statement B (`docs/FORGE-MASTER-TODO.md`, `src/main/core/forgeCore.ts`, `taskRunner.ts`)**: Headless Forge Core (`CORE-001`), Native Agent execution loop (`AGENT-001`), CLI streaming interface (`CLI-001`), and SQLite durability (`STATE-001`) are merged and tested.
- **Physical Reality**: Forge has implemented and merged headless core orchestration, with 1,125 passing tests.
- **Resolution**: `README.md` must reflect the true milestone progress (M1–M4 foundation implemented/verified in core). `docs/project/current-state.md` is established as the sole source of current truth.

### Contradiction C-03: Competing Milestone Roadmaps
- **Statement A (`docs/PLAN.md`, lines 180–195)**: Defines milestones M0 through M6 (M0 Foundation, M1 Project & Git, M2 Runtime Adapters, M3 Workflow Engine, M4 Evidence & Review, M5 Human Control, M6 Polish).
- **Statement B (`docs/FORGE-MASTER-TODO.md`, lines 14–150)**: Defines milestones M0 through M9 (M0 Baseline, M1 Headless Core, M2 Native Agent Core, M3 Forge CLI, M4 State & Storage, M5 Independent Verification, M6 Workflow Graph, M7 Human Control, M8 Extensible Provider Ecosystem, M9 Enterprise / Scale).
- **Physical Reality**: Recent PRs (#198, #203, #204) and issues (#199, #200, #201, #202) explicitly follow the modern M0–M9 program.
- **Resolution**: `docs/PLAN.md` is marked as `HISTORICAL / LEGACY PLAN` and archived. `docs/roadmap/milestones.md` establishes the canonical modern M0–M9 framework.

### Contradiction C-04: Status of STATE-001 Storage Layer
- **Statement A (`docs/FORGE-MASTER-TODO.md`, line 61)**: Lists `STATE-001` as status `READY`, depends on `CORE-002`.
- **Statement B (`git log`, commit `1dfb444`)**: PR #203 ("feat(state): implement STATE-001 durable run, step, artifact, and event store") was merged into `main` on 2026-09-12.
- **Physical Reality**: `RunStore`, `ArtifactStore`, `EventStore`, `ArtifactService`, and SQLite schema migrations are fully implemented in `src/main/db/` and verified.
- **Resolution**: In `docs/roadmap/milestones.md` and `docs/project/current-state.md`, `STATE-001` is marked as `IMPLEMENTED` and `VERIFIED`.

---

## 5. Invariant Code-to-Document Dependencies

The audit identified two critical automated test/script linkages that impose hard constraints on documentation layout:

1. **`docs/DOMAIN.md`**:
   - `scripts/generate-state-diagram.mjs` line 21 hardcodes `const DOC = 'docs/DOMAIN.md'`.
   - `package.json` script `"check:docs"` runs this script in `--check` mode during `npm run check`.
   - `src/shared/domain/transitions.ts` cross-references this exact path.
   - **Constraint**: `docs/DOMAIN.md` must remain in place and retain its exact HTML comment delimiters:
     `<!-- BEGIN GENERATED STATE DIAGRAM -->`
     `<!-- END GENERATED STATE DIAGRAM -->`

2. **`docs/FORGE_RULES.md`**:
   - `src/main/projects/projects.test.ts` line 468 asserts:
     `it('declares a rule for every heading in docs/FORGE_RULES.md', () => { ... })`
   - It reads `docs/FORGE_RULES.md` and dynamically checks for the headings `## R1 — Never guess` through `## R8 — Stop cleanly`.
   - `src/shared/domain/forgeRules.ts` also hardcodes `const SOURCE = 'docs/FORGE_RULES.md'`.
   - **Constraint**: `docs/FORGE_RULES.md` must remain in place with its exact heading titles unmodified.

---

## 6. Architecture Rework Action Plan

Based on this forensic audit, the documentation architecture rework proceeds as follows:
1. **Establish Authority Model (`docs/meta/documentation-policy.md`)**: Formalize status vocabulary (`DRAFT`, `PROPOSED`, `ACCEPTED`, `FROZEN`, `IMPLEMENTED`, `SUPERSEDED`, `DEPRECATED`, `ARCHIVED`) and precedence rules.
2. **Decompose Architecture (`docs/architecture/`)**: Split `docs/ARCHITECTURE.md` into 10 modular, single-responsibility documents with exact technical contracts.
3. **Clarify Product Intent (`docs/product/`)**: House `vision.md`, `north-star.md`, `principles.md`, and `user-workflow.md`.
4. **Standardize Decisions (`docs/decisions/`)**: Introduce `README.md`, attach formal metadata to ADR-001, ADR-002, ADR-003, and move `ADR-001-TASKS.md` to `docs/archive/`.
5. **Establish Evidence-Based Project Truth (`docs/project/`)**: Create `current-state.md` and `verification-baseline.md` grounded in actual test counts and git commits.
6. **Rationalize Roadmap (`docs/roadmap/`)**: Reconcile M0–M9 milestones with actual repository progress.
7. **Preserve Invariants**: Keep `docs/DOMAIN.md` and `docs/FORGE_RULES.md` intact at their required paths while integrating them cleanly into the master documentation index.

---

## 7. Documentation Consistency Matrix

| Topic | Canonical Document | Secondary References | Identified Conflicts & Resolution |
| :--- | :--- | :--- | :--- |
| **Product Purpose & UX** | `docs/product/vision.md` & `north-star.md` | `README.md`, `CLAUDE.md` | `README.md` claimed "stay out of message bus"; resolved to "user stays in loop, stops being transport". |
| **Project Status** | `docs/project/current-state.md` | `README.md`, `docs/FORGE-MASTER-TODO.md` | `README.md` claimed M0 pre-alpha with no orchestration; resolved to verified Headless Core and SQLite state on `main`. |
| **System Architecture** | `docs/architecture/architecture-overview.md` | `docs/ARCHITECTURE.md`, `docs/product/vision.md` | Monolithic `ARCHITECTURE.md` decomposed into 10 single-responsibility specifications; top-level retained as bridge. |
| **Domain State Machine** | `docs/DOMAIN.md` | `docs/architecture/domain-model.md`, `src/shared/domain/transitions.ts` | Kept in sync via automated `scripts/generate-state-diagram.mjs` and `check:docs`. |
| **Agent Execution Rules** | `docs/FORGE_RULES.md` | `docs/specifications/rules-and-policy.md`, `CLAUDE.md` | Headings verified against `projects.test.ts`. Specification documents scope inheritance. |
| **Architectural Decisions** | `docs/decisions/` (ADR-001..003) | `docs/architecture/`, `docs/roadmap/milestones.md` | `ADR-001-TASKS.md` removed from `decisions/` and archived; ADR statuses standardized to `IMPLEMENTED`. |
| **Empirical CLI Facts** | `docs/research/cli-field-guide.md` | `docs/CLI-FIELD-GUIDE.md`, `docs/spikes/` | Top-level pointer preserved; canonical research cataloged in `docs/research/`. |
| **Milestone Tasks** | `docs/roadmap/milestones.md` | `docs/FORGE-MASTER-TODO.md`, `docs/PLAN.md` | Monolithic trackers superseded; canonical M0–M9 breakdown established with PR links. |

---

## 8. Documentation Migration Map

| Original Document | New Canonical Location | Action Taken | Rationale |
| :--- | :--- | :--- | :--- |
| `docs/ARCHITECTURE.md` | `docs/architecture/*.md` & `docs/ARCHITECTURE.md` | Decomposed & Bridged | Monolithic 1,128-line file split into 10 modular docs; top-level kept as navigation hub. |
| `docs/NORTH-STAR.md` | `docs/product/north-star.md` | Promoted & Pointers Added | Canonical vision promoted to `product/`; top-level kept as pointer. |
| `docs/PLAN.md` | `docs/archive/legacy-plan.md` & `docs/roadmap/milestones.md` | Archived & Superseded | Legacy M0–M6 plan archived; modern M0–M9 roadmap established. |
| `docs/FORGE-MASTER-TODO.md` | `docs/archive/legacy-master-todo.md` & `docs/roadmap/` | Archived & Superseded | Monolithic TODO replaced by `roadmap/milestones.md` and `project/current-state.md`. |
| `docs/CLI-FIELD-GUIDE.md` | `docs/research/cli-field-guide.md` | Re-indexed | High-value empirical research housed under `docs/research/`. |
| `docs/RELEASE.md` | `docs/operations/release.md` | Re-indexed | Operational runbook housed under `docs/operations/`. |
| `docs/MVP_ACCEPTANCE.md` | `docs/project/mvp-acceptance.md` | Re-indexed | Historical acceptance evidence cataloged under `docs/project/`. |
| `docs/ANTIGRAVITY-PLAN-TASK-RECORD.md` | `docs/archive/antigravity-plan-task-record.md` | Archived | 1,663 lines (102 KB) of agent transcripts removed from normative docs. |
| `docs/decisions/ADR-001-TASKS.md` | `docs/archive/ADR-001-TASKS.md` | Archived & Redirected | Task list removed from decision directory to preserve ADR integrity. |
| `docs/DOMAIN.md` | `docs/DOMAIN.md` | Preserved In Place | Script and build invariant maintained. Linked to `architecture/domain-model.md`. |
| `docs/FORGE_RULES.md` | `docs/FORGE_RULES.md` | Preserved In Place | Automated test invariant maintained. Linked to `specifications/rules-and-policy.md`. |
| `README.md` | `README.md` | Updated In Place | Fixed outdated M0 pre-alpha text and framing; linked to `docs/README.md`. |
| `CLAUDE.md` | `CLAUDE.md` | Updated In Place | Updated reading list to reflect new master catalog and governance rules. |

---

## 9. Authority Map

| Domain / Question | Primary Source of Truth | Precedence Rank |
| :--- | :--- | :--- |
| **Product Intent & Philosophy** | `docs/product/vision.md` & `docs/product/north-star.md` | Level 1 |
| **Axioms & Principles** | `docs/product/principles.md` | Level 1 |
| **System Architecture** | `docs/architecture/architecture-overview.md` & modular docs | Level 2 |
| **Contracts & Protocols** | `docs/architecture/contracts/` & `docs/specifications/` | Level 3 |
| **Domain State Machine** | `docs/DOMAIN.md` (generated from `transitions.ts`) | Level 3 |
| **Agent Ruleset** | `docs/FORGE_RULES.md` (verified by `projects.test.ts`) | Level 3 |
| **Architectural Decisions** | `docs/decisions/` (`ADR-001` through `ADR-003`) | Level 4 |
| **Physical Implementation** | `src/` (TypeScript source files) | Level 5 |
| **Verification & Evidence** | Vitest test suites, git diffs, CI test logs | Level 6 |
| **Current Project State** | `docs/project/current-state.md` & `verification-baseline.md` | Level 7 |
| **Roadmap & Milestones** | `docs/roadmap/roadmap.md` & `milestones.md` | Planning Truth (Non-normative) |
| **Empirical Research** | `docs/research/` & `docs/spikes/` | Informative (Non-normative) |
| **Historical Records** | `docs/archive/` | Historical (Non-normative) |
