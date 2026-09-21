# Forge Documentation

Welcome to the Forge documentation system.

Forge is an **AI engineering control plane** where multiple autonomous coding agents collaborate on a software repository under a shared execution protocol, while the human developer watches, steers, and decides.

This documentation is organized into clear, durable, and authoritative domains following the documentation governance policy established in [`docs/meta/documentation-policy.md`](meta/documentation-policy.md).

---

## Master Documentation Catalog

```
docs/
├── meta/               Documentation governance, authority rules, audit reports
├── product/            Product vision, North Star manifesto, axioms, developer loop
├── architecture/       Subsystem architectures, execution models, storage, contracts
│   ├── contracts/      Formal protocol, lifecycle, and storage schemas
│   └── diagrams/       Mermaid system topologies and boundary graphs
├── decisions/          Architectural Decision Records (ADRs 001–003)
├── research/           Empirical field studies, CLI measurements, platform facts
├── spikes/             Timeboxed technical feasibility explorations
├── roadmap/            Strategic roadmap, M0–M9 milestone tasks, dependency maps
├── project/            Verified ground truth: current state, progress, baseline metrics
├── specifications/     Normative rules, policy engine hierarchy, wire protocols
├── operations/         Local developer setup, testing runbooks, release procedures
└── archive/            Superseded plans, legacy trackers, historical agent logs
```

---

## 1. Product Intent & Foundations

| Document | Purpose |
| :--- | :--- |
| [**`product/vision.md`**](product/vision.md) | High-level vision: eliminating manual copy-paste while keeping the human in the loop. |
| [**`product/north-star.md`**](product/north-star.md) | Canonical manifesto: the measured gap against manual workflows and the terminal PTY inversion. |
| [**`product/principles.md`**](product/principles.md) | The seven invariant axioms (A1–A7) governing truth, evidence, decision locking, and bounds. |
| [**`product/user-workflow.md`**](product/user-workflow.md) | The end-to-end developer loop: planning, decision gates, live steering, and review. |

---

## 2. Technical Architecture

| Document | Subsystem / Focus |
| :--- | :--- |
| [**`architecture/architecture-overview.md`**](architecture/architecture-overview.md) | System topology, process boundaries, Headless Core kernel, and dependency rules. |
| [**`architecture/execution-model.md`**](architecture/execution-model.md) | Domain hierarchy: Task → Run → Step → Event → Artifact → Verification. |
| [**`architecture/evidence-and-verification.md`**](architecture/evidence-and-verification.md) | Axiom A3, physical git diff reconciliation, criteria evaluation, and test runners. |
| [**`architecture/agent-runtime.md`**](architecture/agent-runtime.md) | `IAgentRuntime`, native agent loop, external CLI adapters, and PTY hosting. |
| [**`architecture/state-and-storage.md`**](architecture/state-and-storage.md) | Dual-tier persistence: SQLite (`RunStore`, `EventStore`) + disk `ArtifactService`. |
| [**`architecture/workflow-engine.md`**](architecture/workflow-engine.md) | State machine pipeline, loop guards, no-progress diff detector, and DAG roadmap. |
| [**`architecture/cli-and-ipc.md`**](architecture/cli-and-ipc.md) | Headless CLI (`bin/forge.ts`), NDJSON streaming, and typed Electron IPC router. |
| [**`architecture/security-and-trust.md`**](architecture/security-and-trust.md) | Guardrails vs sandbox, least-privilege scoping, folder trust, and secret redaction. |
| [**`architecture/concurrency-and-isolation.md`**](architecture/concurrency-and-isolation.md) | `ProcessManager`, tree termination (`taskkill /T /F`), Windows ConPTY vs POSIX PTY. |
| [**`architecture/domain-model.md`**](architecture/domain-model.md) | Canonical domain entity relationships. Links to [`docs/DOMAIN.md`](DOMAIN.md). |

### Formal Contracts & Topologies
- [**`architecture/contracts/`**](architecture/contracts/README.md): Binding schemas for [execution protocols](architecture/contracts/execution-protocol.md), [run lifecycles](architecture/contracts/run-and-step-lifecycle.md), [artifact storage](architecture/contracts/artifact-storage.md), and [verification criteria](architecture/contracts/verification-criteria.md).
- [**`architecture/diagrams/`**](architecture/diagrams/README.md): Visual [system context](architecture/diagrams/system-context.md) and process interaction graphs.

---

## 3. Architecture Decision Records (ADRs)

Managed in [**`docs/decisions/`**](decisions/README.md):
- [**ADR-001**](decisions/ADR-001-agents-runtimes-accounts.md): Agents, runtimes, and the end of account isolation.
- [**ADR-002**](decisions/ADR-002-interactive-orchestration.md): Interactive orchestration vs headless stdout parsing.
- [**ADR-003**](decisions/ADR-003-host-the-real-cli.md): Host the real CLI instead of parsing a headless one.

---

## 4. Research & Spikes

- [**`research/README.md`**](research/README.md): Empirical research standards.
  - [**CLI Field Guide**](research/cli-field-guide.md): Empirical facts regarding Claude Code, Antigravity, ConPTY, and Windows terminal shims.
- [**`spikes/README.md`**](spikes/README.md): Timeboxed exploratory spikes.
  - [**Agent CLI Capability**](spikes/agent-cli-capability.md): Headless CLI driving feasibility.
  - [**Interactive CLI PTY**](spikes/interactive-cli-pty.md): ConPTY terminal hosting feasibility.

---

## 5. Planning & Roadmap

- [**`roadmap/roadmap.md`**](roadmap/roadmap.md): Strategic program phases (Phases 1 through 4).
- [**`roadmap/milestones.md`**](roadmap/milestones.md): Canonical M0 through M9 task breakdown with issue and PR traceability.
- [**`roadmap/dependency-map.md`**](roadmap/dependency-map.md): Topological dependency graphs.
- [**`roadmap/deferred.md`**](roadmap/deferred.md): Intentionally deferred features and non-goals.

---

## 6. Project Truth & Verification

- [**`project/current-state.md`**](project/current-state.md): Authoritative capability matrix backed by physical test evidence.
- [**`project/progress.md`**](project/progress.md): Milestone progress line and merged PR history.
- [**`project/verification-baseline.md`**](project/verification-baseline.md): Test metrics (1,125 passing tests), toolchain gates, and CI status.
- [**`project/implementation-log.md`**](project/implementation-log.md): Reverse chronological engineering ledger.

---

## 7. Specifications & Invariants

- [**`specifications/rules-and-policy.md`**](specifications/rules-and-policy.md): Policy engine hierarchy and scope resolution.
- [**`specifications/agent-wire-protocol.md`**](specifications/agent-wire-protocol.md): `FORGE_REPORT` format specification.
- [**`FORGE_RULES.md`**](FORGE_RULES.md): The eight canonical agent rules (R1–R8). *(Automated test dependency)*.
- [**`DOMAIN.md`**](DOMAIN.md): State machine transition specification and generated Mermaid diagram. *(Build script dependency)*.

---

## 8. Operations & Runbooks

- [**`operations/development.md`**](operations/development.md): Developer onboarding, native build prerequisites, and daily workflows.
- [**`operations/testing.md`**](operations/testing.md): Vitest suites, integration tests, and automated quality gates.
- [**`operations/release.md`**](operations/release.md): Packaging runbook, NSIS/portable targets, code signing, and release pipeline.
- [**`operations/troubleshooting.md`**](operations/troubleshooting.md): Windows git `EBUSY` resolution, `node-pty` rebuilds, and trust recovery.

---

## 9. Archive & Governance

- [**`meta/documentation-policy.md`**](meta/documentation-policy.md): The Twelve Canonical Rules of documentation governance.
- [**`meta/forensic-audit-report.md`**](meta/forensic-audit-report.md): Phase 0 audit report and contradiction analysis.
- [**`archive/`**](archive/README.md): Preserved historical records, legacy plans, and past agent task records.
