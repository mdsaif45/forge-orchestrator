# Forge Documentation Policy & Governance

**Status:** FROZEN  
**Authority:** Canonical Documentation Policy  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `1dfb444`  
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

## 3. Status Vocabulary

Every normative document (Architecture, Specifications, Contracts, ADRs, Milestones) must declare exactly one status from this lifecycle:

| Status | Definition | Normative Force |
| :--- | :--- | :--- |
| **`DRAFT`** | Under active composition. May contain incomplete sections, open questions, and unverified hypotheses. | Non-binding |
| **`PROPOSED`** | Fully drafted and internally consistent. Submitted for architectural review or team consideration. | Non-binding |
| **`ACCEPTED`** | Formally decided and approved. Serves as the binding specification for subsequent implementation. | **Binding** |
| **`FROZEN`** | Sealed contract or specification. Invariants and interfaces are immutable; changes require an approved ACR. | **Binding** |
| **`IMPLEMENTED`** | Normative architecture or ADR whose implementation is fully merged into `main` and verified by tests. | **Binding** |
| **`SUPERSEDED`** | Previously accepted or implemented, but replaced by a newer decision or contract. Must link to replacement. | Non-binding (Historical) |
| **`DEPRECATED`** | Scheduled for removal. Retained only for temporary backward compatibility during migrations. | Non-binding (Transitional) |
| **`ARCHIVED`** | Non-normative historical record preserved solely for provenance, forensic audits, or reference. | Non-binding (Archival) |

---

## 4. Authority & Precedence Hierarchy

When statements conflict across repository artifacts, authority is resolved in strict hierarchical order:

```
                  ┌──────────────────────────────┐
                  │ 1. Product Intent & Vision   │  docs/product/
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 2. System Architecture       │  docs/architecture/
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 3. Specifications & Contracts│  docs/specifications/ , contracts/
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 4. ADR Decisions             │  docs/decisions/
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 5. Physical Implementation   │  src/
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 6. Verification & Evidence   │  vitest, git diffs, test logs
                  └──────────────┬───────────────┘
                                 │
                  ┌──────────────▼───────────────┐
                  │ 7. Project Progress & State  │  docs/project/
                  └──────────────────────────────┘
```

### Interpretation Rules:
- **Research & Spikes (`docs/research/`, `docs/spikes/`)**: Informative only. Cannot override architecture or specifications.
- **Roadmap (`docs/roadmap/`)**: Tracks planning intent. Cannot override architecture, contracts, or verified project state.
- **Archive (`docs/archive/`)**: Preserved history. Has zero normative authority over current behavior.

---

## 5. Statement Classification in Contracts

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

## 6. Standard Metadata Schema

All normative documents in `docs/architecture/`, `docs/architecture/contracts/`, `docs/specifications/`, and `docs/decisions/` must begin with the following metadata header:

```markdown
# [Document Title]

**Status:** [DRAFT | PROPOSED | ACCEPTED | FROZEN | IMPLEMENTED | SUPERSEDED | DEPRECATED | ARCHIVED]
**Authority:** [Canonical | Component | Informative]
**Last Updated:** YYYY-MM-DD
**Baseline:** [e.g. main @ 1dfb444]
**Related Decisions:** [e.g. ADR-001, ADR-003]
**Related Roadmap Items:** [e.g. CORE-001, STATE-001]
**Related Implementation:** [e.g. src/main/core/taskRunner.ts]
**Supersedes:** [Optional: previous document path]
**Superseded by:** [Optional: replacement document path]
```

Fields that are not applicable to a specific document may be omitted, but `Status`, `Authority`, and `Last Updated` are mandatory on all normative files.
