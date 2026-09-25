# Forge Documentation Policy & Governance

**Status:** FROZEN  
**Authority:** Canonical Documentation Policy  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Applies to:** All files within `docs/` and root documentation  

---

## 1. Purpose & Philosophy

Forge documentation serves as the single source of truth for product intent, system architecture, engineering contracts, and project state. 

Because Forge is an engineering control plane built with autonomous agent assistance, the greatest threat to project integrity is **architectural drift**: code working by accident, tests passing against false assumptions, and documentation devolving into unverified aspirational claims.

This policy defines the authority model, status vocabulary, metadata schemas, and rules that keep Forge documentation authoritative, durable, and navigable.

---

## 2. The Twelve Canonical Documentation Rules

Every contributor and agent modifying Forge documentation must adhere to these twelve rules:

1. **Never guess.** If repository code, configuration, or history does not definitively answer a design or implementation question, it must be marked as `UNKNOWN` or escalated as an `OPEN QUESTION`. Never convert an unknown into an assumption.
2. **Never silently resolve contradictions.** When two documents disagree, or when documentation disagrees with code, record both statements and document the discrepancy in `docs/meta/forensic-audit-report.md` before establishing the canonical resolution.
3. **Accepted and Frozen contracts are binding.** A document marked `ACCEPTED` or `FROZEN` defines normative system requirements. Implementation cannot unilaterally deviate from an accepted specification without an approved Architectural Change Request (ACR) or new ADR.
4. **Roadmap is not implementation truth.** A roadmap describes what we intend to build and in what sequence. The existence of an issue, task ID, or milestone does not prove that code exists.
5. **Implementation is not architecture truth.** The fact that code compiles or tests pass does not make the code architecture. Accidental coupling or legacy implementations must be challenged against the architecture, not canonized by default.
6. **Research is not decision.** Spikes, benchmarks, and field guides gather evidence. They are informative. They do not become normative system architecture until an ADR or contract explicitly promotes them.
7. **Agent reports are claims, not evidence.** Transcripts, summaries, and agent-authored reports are assertions. Verification requires physical git diffs, executed test suites, and deterministic CLI exit codes.
8. **Historical logs are not authoritative.** Transcripts, session records, and task trackers are archival artifacts. They must be isolated in `docs/archive/` and never serve as normative references.
9. **Every major architectural change requires documentation traceability.** An architecture change must link bidirectionally: Product Vision ↔ Architecture ↔ Contract ↔ ADR ↔ Implementation PR ↔ Verification Evidence.
10. **Every implementation milestone must update project truth.** When a milestone or slice merges to `main`, `docs/project/current-state.md` and `docs/project/verification-baseline.md` must be updated with the exact commit SHA, test counts, and verified capabilities.
11. **Obsolete documents must be marked or archived, not silently abandoned.** Dead proposals or superseded plans must have their status header set to `SUPERSEDED` or `ARCHIVED` with an explicit pointer to the replacement.
12. **Do not duplicate normative statements across documents.** A concept has one canonical home. Other documents must reference the canonical document rather than paraphrasing or re-stating the rule.

---

## 3. Multi-Dimensional Status Vocabulary

To eliminate ambiguity, Forge documentation strictly separates three orthogonal status dimensions. A document or task must never use an overloaded single status field to mean three different things.

### Dimension 1: Document Lifecycle Status
Applies to entire documentation files in metadata headers:

| Status | Definition | Normative Force |
| :--- | :--- | :--- |
| **`DRAFT`** | Under active composition. May contain incomplete sections, open questions, and unverified hypotheses. | Non-binding |
| **`PROPOSED`** | Fully drafted and internally consistent. Submitted for architectural review. Must carry a `DESIGN GATE` warning banner; **not permission to implement**. | Non-binding |
| **`ACCEPTED`** | Formally decided and approved by the project owner. Serves as normative architecture for subsequent work. | **Binding** |
| **`FROZEN`** | Sealed contract or specification. Invariants and interfaces are immutable; changes require an approved ACR. | **Binding** |
| **`IMPLEMENTED`** | Normative architecture or ADR whose core specification is fully merged into `main` and verified by tests. | **Binding** |
| **`SUPERSEDED`** | Previously accepted or implemented, but replaced by a newer decision or contract. Must link to replacement. | Non-binding (Historical) |
| **`DEPRECATED`** | Scheduled for removal. Retained only for temporary backward compatibility during migrations. | Non-binding (Transitional) |
| **`ARCHIVED`** | Non-normative historical record preserved solely for provenance, forensic audits, or reference. | Non-binding (Archival) |

### Dimension 2: Project & Milestone State
Applies to roadmap issues and task items (`docs/roadmap/`):
- **`DONE`**: Merged to `main` and proven by passing automated tests and physical evidence.
- **`IN-PROGRESS`**: Actively under development in an open PR branch.
- **`READY`**: Fully specified, all upstream dependencies satisfied, ready for implementation.
- **`BLOCKED`**: Waiting on an incomplete upstream dependency or architectural gate.
- **`NOT STARTED`**: Planned work for future milestones, not yet under active development.
- **`DEFERRED`**: Formally postponed with documented technical rationale.

### Dimension 3: Implementation Capability State
Applies to rows in the capability matrix (`docs/project/current-state.md`):
- **`VERIFIED`**: Implemented on `main` and demonstrated by passing automated tests named in the Evidence column.
- **`IMPLEMENTED`**: Code exists on `main`, but no automated test pins the specific behavior claimed.
- **`PARTIAL`**: Some part exists on `main`; the rest is open. The gap is stated explicitly.
- **`PLANNED`**: No implementation on `main`. Types or scaffolding may exist.
- **`UNKNOWN`**: Genuinely undetermined state; must be investigated before claiming completion.
- **`SUPERSEDED`**: Replaced by a different implementation approach.

> **Key Rule on Dimensions**: A document being `ACCEPTED` or `IMPLEMENTED` does not mean every future capability mentioned within it is implemented. A roadmap item being `DONE` means its milestone criteria were satisfied, not that speculative future work is finished.

---

## 4. Authority, Reality, and Evidence Precedence

The Forge governance model distinguishes three distinct categories:
1. **Authority**: What determines what Forge **should** mean.
2. **Reality**: What the repository source code currently **does**.
3. **Evidence**: What **proves** the reality claim.

### The Epistemic Flow:

```
Product Intent & Axioms (docs/product/)
         ↓
Accepted System Architecture (docs/architecture/)
         ↓
Frozen Contracts (docs/architecture/contracts/) & Accepted ADRs (docs/decisions/)
         ↓
Physical Implementation Reality (src/)
         ↓
Verification Evidence (Vitest tests, git diffs, exit codes, CI)
         ↓
Current-State Claims (docs/project/current-state.md)
```

### Precedence & Reconciliation Rules:
- **Frozen contracts constrain implementation**: Contracts are binding specifications across subsystem boundaries. Implementation code cannot unilaterally violate or redefine a frozen contract.
- **ADRs record accepted decisions**: Architectural decisions define why subsystems are shaped the way they are. Modifying an ADR requires an explicit superseding ADR.
- **Source code is physical implementation reality**: The code in `src/` represents what is built, but code alone does not constitute architectural authority.
- **Evidence substantiates reality**: Per Axiom A3 (*Evidence > Claims*), tests, independent git diffs, and compiler exit codes substantiate whether implementation reality satisfies the architecture.
- **Current-state documentation summarizes verified reality**: `docs/project/current-state.md` and `docs/project/verification-baseline.md` must cite physical source files, test suites, and commit SHAs.
- **Roadmap does not override implementation reality**: `docs/roadmap/` records planning intent only. The existence of a task ID or milestone does not prove that code exists.
- **Research does not override architecture or contracts**: Research documents (`docs/research/`, `docs/spikes/`) gather empirical findings. They are informative and carry zero normative force until ratified by an ADR or contract.
- **Archive has zero current authority**: `docs/archive/` contains historical provenance only.
- **Discrepancy Rule**: If implementation contradicts a frozen contract, **the discrepancy must be recorded as a defect**; the implementation must not silently redefine the contract, nor may the contract be silently weakened to match accidental code behavior.

---

## 5. Domain State Models in Forge

Forge explicitly separates three distinct state models across the system to prevent conflating execution layers:

1. **`WorkflowState` (Domain Workflow Machine)**: Formally defined in `src/shared/domain/enums.ts` and `src/shared/domain/transitions.ts`. Governs the high-level multi-stage engineering workflow. Contains 13 states: `DISCOVERY`, `PLANNING`, `PLAN_READY`, `DECISIONS_LOCKED`, `IMPLEMENTING`, `VERIFYING`, `REVIEWING`, `CORRECTION_REQUIRED`, `AWAITING_USER`, and four terminal states: `DONE`, `HALTED_LIMIT`, `HALTED_POLICY`, `CANCELLED`.
2. **`RunStatus` (Execution & Storage Lifecycle)**: Formally defined in `src/shared/domain/run.ts` and SQLite schema `src/main/db/schema.ts`. Governs discrete Task Runs and Steps. Contains exactly 4 states: `running`, `completed`, `failed`, `halted`. Mapped directly to CLI exit codes (0 = completed, 1 = failed, 2 = halted).
3. **`ReportStatus` (Agent Wire Protocol)**: Formally defined in `src/shared/domain/enums.ts`. Governs the status emitted in an agent's `FORGE_REPORT` block: `completed`, `blocked`, `question`.

---

## 6. Statement Classification in Contracts

Document *status* (section 3) describes a whole document's lifecycle. Inside a contract,
individual statements differ in where their authority comes from, so each normative
statement carries one of four classifications:

| Classification | Meaning | May implementation rely on it? |
| :--- | :--- | :--- |
| **`SPECIFIED`** | Stated directly by an accepted contract, ADR, or product requirement. The authority is the document itself. | Yes |
| **`DERIVED`** | Logically follows from something `SPECIFIED`, or was read out of the implementation and is recorded as the current behaviour. The authority is upstream, not this line. | Yes, but it changes when its source changes |
| **`APPROVED`** | Was `PROPOSED` and has since been explicitly accepted by the owner. Carries the same force as `SPECIFIED`, with the approval recorded. | Yes |
| **`UNKNOWN`** | Genuinely undetermined. No decision exists and none may be inferred. | **No** |

Two rules govern `UNKNOWN`, and they are the point of the whole scheme:

1. **Never silently convert `UNKNOWN` into an assumption.** An `UNKNOWN` may become
   `SPECIFIED` or `APPROVED` only through an explicit decision by the owner, recorded in
   an ADR or in the contract's amendment history. Rewriting it as prose because the
   answer seems obvious is the failure mode this classification exists to prevent.
2. **An `UNKNOWN` must be accompanied by an open question** carrying an identifier, so
   it is discoverable and can be closed deliberately rather than forgotten.

---

## 7. Standard Metadata Schema

All normative documents in `docs/architecture/`, `docs/architecture/contracts/`, `docs/specifications/`, and `docs/decisions/` must begin with the following metadata header:

```markdown
# [Document Title]

**Status:** [DRAFT | PROPOSED | ACCEPTED | FROZEN | IMPLEMENTED | SUPERSEDED | DEPRECATED | ARCHIVED]
**Authority:** [Canonical | Component | Informative]
**Last Updated:** YYYY-MM-DD
**Baseline:** [e.g. main @ 5987501]
**Related Decisions:** [e.g. ADR-001, ADR-003]
**Related Roadmap Items:** [e.g. CORE-001, STATE-001]
**Related Implementation:** [e.g. src/main/core/taskRunner.ts]
**Supersedes:** [Optional: previous document path]
**Superseded by:** [Optional: replacement document path]
```

Fields that are not applicable to a specific document may be omitted, but `Status`, `Authority`, and `Last Updated` are mandatory on all normative files.
