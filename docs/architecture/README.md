# Forge Architecture Documentation

This directory contains the authoritative, modular technical architecture specifications for Forge.

## Architectural Documents

| Document | Subsystem / Responsibility | Authority |
| :--- | :--- | :--- |
| [`architecture-overview.md`](architecture-overview.md) | High-level system topology, process boundaries, Headless Core vs UI, and engine-vs-agent separation. | **Canonical Architecture** |
| [`agent-concept-model.md`](agent-concept-model.md) | Canonical concept model distinguishing Agent, Persona, Skill, Tool, Runtime, Provider, Model, Workflow, Step, and Task. | **Proposed Concept Gate** |
| [`execution-model.md`](execution-model.md) | The lifecycle and domain hierarchy: Task → Run → Step → Event → Artifact → Verification. | **Normative** |
| [`evidence-and-verification.md`](evidence-and-verification.md) | Physical diff reconciliation, criteria evaluators, independent test runners, and authoritative verdicts (Axiom A3). | **Normative** |
| [`agent-runtime.md`](agent-runtime.md) | `IAgentRuntime` abstraction, Native Agent task loop, external CLI adapters, PTY session lifecycle, and provider isolation. | **Normative** |
| [`state-and-storage.md`](state-and-storage.md) | Dual-tier persistence: SQLite (`RunStore`, `EventStore`, `ArtifactStore`) vs Filesystem (`ArtifactService`), IDs, and consistency guarantees. | **Normative** |
| [`workflow-engine.md`](workflow-engine.md) | Linear state machine loop, generic DAG graph roadmap, loop guards, no-progress diff detection, and human approval gates. | **Normative** |
| [`cli-and-ipc.md`](cli-and-ipc.md) | Headless CLI interface (`bin/forge.ts`), NDJSON streaming, and typed IPC router contract between Electron Main and Renderer. | **Normative** |
| [`security-and-trust.md`](security-and-trust.md) | Security posture, least-privilege scoping, workspace folder trust (`ClaudeTrustStore`), secret redaction, and OS boundary limits. | **Normative** |
| [`concurrency-and-isolation.md`](concurrency-and-isolation.md) | `ProcessManager`, tree termination, Windows ConPTY vs Linux PTY, crash recovery, and orphaned process cleanup. | **Normative** |
| [`domain-model.md`](domain-model.md) | Canonical domain entities, relationships, invariants, and integration with `docs/DOMAIN.md`. | **Normative** |

## Subdirectories

- [`contracts/`](contracts/): Formal schema, transition, and invariant specifications.
- [`diagrams/`](diagrams/): System context, process flow, and boundary diagrams.

---

## Authority Model

All documents in this directory have **Architectural Authority**. They define the intended structure, invariants, and contracts of Forge. Implementation code in `src/` must conform to these documents. Any discrepancy must be resolved by updating the code to match the architecture or by ratifying an architectural decision (ADR) to amend the document.
