# Forge Documentation Authority Map

**Status:** ACCEPTED  
**Authority:** Governance Reference (see [documentation-policy.md](documentation-policy.md))  
**Last Updated:** 2026-11-26  
**Baseline:** `main` @ `cfb0f4c` (PR #488 merged)  
**Audit Report:** [normative-truth-audit.md](normative-truth-audit.md)  

---

## 1. Purpose

This authority map establishes the canonical document for every architectural topic, domain concept, and engineering subsystem in Forge.

When any conflict or ambiguity arises, the **Canonical Document** designated below is the sole authoritative specification for that topic. No secondary document, roadmap entry, task tracker, or PR description may contradict it.

---

## 2. Topic Authority Matrix

| Topic | Canonical Document | Status | Authority Level | Implementation Package / Path | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Product Purpose & Core Thesis** | [`docs/product/vision.md`](../product/vision.md), [`docs/product/north-star.md`](../product/north-star.md) | ACCEPTED | Normative (Vision) | `packages/forge-core/src/core/forgeCore.ts` | Human-loop workflows, acceptance suite |
| **Product Invariants & Axioms** | [`docs/product/principles.md`](../product/principles.md) | FROZEN | Normative (Principles) | Axioms A1–A7 enforced across `@forge/core` & `@forge/shared` | Architectural tests, state guard assertions |
| **Human Interaction Workflow** | [`docs/product/user-workflow.md`](../product/user-workflow.md) | ACCEPTED | Informative (Workflow) | `packages/forge-core/src/workflows/workflowService.ts` | `mvpAcceptance.test.ts` |
| **High-Level System Architecture** | [`docs/architecture/architecture-overview.md`](../architecture/architecture-overview.md) | IMPLEMENTED | Normative (System) | `@forge/core` (`createForgeCore`) | `forgeCore.test.ts` |
| **Monorepo Package Structure** | [`docs/decisions/ADR-008-modular-monorepo-workspace-architecture.md`](../decisions/ADR-008-modular-monorepo-workspace-architecture.md) | IMPLEMENTED | Normative Decision | `packages/forge-{shared,core,runtimes,cli,desktop}` | `npm run check:cycles` |
| **Execution Kernel & Task Loops** | [`docs/architecture/execution-model.md`](../architecture/execution-model.md) | ACCEPTED | Normative (Architecture) | `packages/forge-core/src/core/taskRunner.ts` | `taskRunner.test.ts` |
| **Dual-Tier State & Storage** | [`docs/architecture/state-and-storage.md`](../architecture/state-and-storage.md) | ACCEPTED | Normative (Architecture) | `packages/forge-core/src/db/`, `artifacts/artifactService.ts` | `runStore.test.ts`, `eventStore.test.ts`, `artifactService.test.ts` |
| **Evidence & Physical Verification** | [`docs/architecture/evidence-and-verification.md`](../architecture/evidence-and-verification.md) | ACCEPTED | Normative (Architecture) | `packages/forge-core/src/evidence/`, `packages/forge-shared/src/domain/reconcile.ts` | `verifier.test.ts`, `adversarial.test.ts`, `reconciliation.integration.test.ts` |
| **Criteria Evaluator Engine** | [`docs/architecture/contracts/verification-criteria.md`](../architecture/contracts/verification-criteria.md) | FROZEN | Canonical Contract | `packages/forge-shared/src/domain/{criterion,completion}.ts` | `completion.test.ts`, `taskRunner.test.ts` |
| **Agent Runtime & CLI Adapters** | [`docs/architecture/agent-runtime.md`](../architecture/agent-runtime.md) | ACCEPTED | Normative (Architecture) | `packages/forge-shared/src/domain/runtime.ts`, `packages/forge-runtimes/` | `runtimes.test.ts`, `claudeCliRuntime.test.ts` |
| **Agent / Skill / Tool Concept Model** | [`docs/architecture/agent-concept-model.md`](../architecture/agent-concept-model.md) | PROPOSED | Design Gate (Concept) | Design specification | Architecture review |
| **Process Isolation & PTY** | [`docs/architecture/concurrency-and-isolation.md`](../architecture/concurrency-and-isolation.md) | ACCEPTED | Normative (Architecture) | `packages/forge-runtimes/src/process/` | `process.test.ts`, `ptyProcessRunner.test.ts` |
| **Security, Scoping & Trust** | [`docs/architecture/security-and-trust.md`](../architecture/security-and-trust.md) | ACCEPTED | Normative (Architecture) | `packages/forge-shared/src/domain/policyEngine.ts`, `packages/forge-runtimes/` | `claudeTrust.test.ts`, `guards.integration.test.ts` |
| **Workflow Engine & DAG Graph** | [`docs/architecture/workflow-engine.md`](../architecture/workflow-engine.md) | IMPLEMENTED | Normative Architecture | `packages/forge-core/src/workflows/{workflowService,graphExecutor}.ts` | `orchestrator.test.ts`, `graphExecutor.test.ts`, `workflowService.test.ts` |
| **Domain Entities & State Machine** | [`docs/DOMAIN.md`](../DOMAIN.md), [`docs/architecture/domain-model.md`](../architecture/domain-model.md) | IMPLEMENTED | Code-Pinned Normative | `packages/forge-shared/src/domain/` | `npm run check:docs` CLI gate, domain unit tests |
| **Standing Policy Rules R1–R8** | [`docs/FORGE_RULES.md`](../FORGE_RULES.md), [`docs/specifications/rules-and-policy.md`](../specifications/rules-and-policy.md) | IMPLEMENTED | Code-Pinned Normative | `packages/forge-shared/src/domain/forgeRules.ts` | `projects.test.ts` |
| **Execution Protocol Contract** | [`docs/architecture/contracts/execution-protocol.md`](../architecture/contracts/execution-protocol.md) | FROZEN | Canonical Contract | `packages/forge-shared/src/domain/protocol.ts` | `protocol.test.ts`, `taskRunner.test.ts` |
| **Run & Step Lifecycle Contract** | [`docs/architecture/contracts/run-and-step-lifecycle.md`](../architecture/contracts/run-and-step-lifecycle.md) | FROZEN | Canonical Contract | `packages/forge-shared/src/domain/run.ts`, `packages/forge-core/src/db/runStore.ts` | `runStore.test.ts`, `guards.test.ts` |
| **Artifact Storage Contract** | [`docs/architecture/contracts/artifact-storage.md`](../architecture/contracts/artifact-storage.md) | FROZEN | Canonical Contract | `packages/forge-core/src/artifacts/artifactService.ts` | `artifactService.test.ts`, `artifactStore.test.ts` |
| **Agent / Runtime / Account Split** | [`docs/decisions/ADR-001-agents-runtimes-accounts.md`](../decisions/ADR-001-agents-runtimes-accounts.md) | IMPLEMENTED | Normative Decision | `packages/forge-shared/src/domain/runtime.ts` | `accountSwitch.integration.test.ts` |
| **Interactive Orchestration** | [`docs/decisions/ADR-002-interactive-orchestration.md`](../decisions/ADR-002-interactive-orchestration.md) | IMPLEMENTED | Normative Decision | `packages/forge-runtimes/` | `sessionRegistry.test.ts` |
| **Host Real CLI in ConPTY** | [`docs/decisions/ADR-003-host-the-real-cli.md`](../decisions/ADR-003-host-the-real-cli.md) | IMPLEMENTED | Normative Decision | `packages/forge-runtimes/` | `ptyProcessRunner.test.ts` |
| **Main / Renderer IPC Boundary** | [`docs/architecture/architecture-overview.md`](../architecture/architecture-overview.md) | IMPLEMENTED | Normative (IPC) | `packages/forge-shared/src/ipc.ts`, `packages/forge-desktop/src/main/ipc/` | `npm run check:router` gate |
| **Preload Bridge API** | [`docs/architecture/architecture-overview.md`](../architecture/architecture-overview.md) | IMPLEMENTED | Normative (Bridge) | `packages/forge-desktop/src/preload/` | `npm run smoke` gate |
| **CLI Commands & Flags** | [`docs/architecture/cli-and-ipc.md`](../architecture/cli-and-ipc.md) | IMPLEMENTED | Normative (CLI) | `packages/forge-cli/src/cli.ts`, `bin/forge.ts` | `packages/forge-cli/src/cli.test.ts` |
| **Current Implementation Reality** | [`docs/project/current-state.md`](../project/current-state.md) | IMPLEMENTED | Implementation Truth | `main` @ `cfb0f4c` (PR #488 merged) | [`verification-baseline.md`](../project/verification-baseline.md) |
| **Verification Baseline** | [`docs/project/verification-baseline.md`](../project/verification-baseline.md) | IMPLEMENTED | Verification Truth | Node 22, 3 CI jobs (`static`, `app`, `windows`) | `.github/workflows/ci.yml` |
| **Milestones & Program Roadmap** | [`docs/roadmap/milestones.md`](../roadmap/milestones.md), [`docs/roadmap/roadmap.md`](../roadmap/roadmap.md) | IMPLEMENTED | Planning Truth (Non-normative) | Roadmap tracking M0–M16 | All 17 GitHub milestones closed |
| **Documentation Governance** | [`docs/meta/documentation-policy.md`](documentation-policy.md) | FROZEN | Governance Policy | Documentation layout, status schemas, precedence | `npm run check:docs` |

---

## 3. Operational Governance: Authority, Evidence, Reporting & Planning

Forge separates system governance into four distinct operational dimensions rather than a naive linear precedence list:

- **AUTHORITY** ([`docs/product/`](../product/), [`docs/architecture/`](../architecture/), [`docs/decisions/`](../decisions/), [`docs/architecture/contracts/`](../architecture/contracts/)): Constrains implementation. Defines what Forge should be.
- **EVIDENCE** (`packages/`, automated tests, git diffs, child process exit codes, CI logs): Establishes what is actually implemented and verified.
- **REPORTING** ([`docs/project/current-state.md`](../project/current-state.md), [`docs/project/verification-baseline.md`](../project/verification-baseline.md)): Reports measured implementation reality. Does not override architecture or contracts.
- **PLANNING** ([`docs/roadmap/roadmap.md`](../roadmap/roadmap.md), [`docs/roadmap/milestones.md`](../roadmap/milestones.md)): Describes intended future work. Does not authorize architecture.

### The Cardinal Invariant

> **Evidence does not outrank authority, and authority does not substitute for evidence.**

- **Authority without evidence is unverified intent**: A contract, ADR, or architecture document defines what must be built, but does not prove that code exists or works.
- **Evidence without authority is unverified code**: Running code or passing tests prove that software executes, but do not make that behavior architectural truth.

### Operational Governance Rules

1. **Contracts constrain implementation**: Contracts are binding specifications across subsystem boundaries. A contract conflict with code is an **implementation defect** unless the contract is formally amended via an approved Architectural Change Request (ACR).
2. **Tests cannot silently redefine architecture or contracts**: A passing test proves current execution behavior; it cannot silently redefine an architecture, contract, or domain invariant.
3. **Current-state cannot promote architecture**: Current-state documentation reports measured implementation reality. It cannot promote planned or proposed architecture to accepted architecture.
4. **Roadmap cannot authorize architecture**: Roadmap entries describe planned delivery targets; they do not authorize architectural implementation.
5. **Research cannot authorize architecture**: Spikes and field research gather empirical data; they carry zero normative force until ratified by an accepted ADR.
6. **Discrepancy Rule**: When implementation contradicts a frozen contract, the discrepancy must be recorded as a defect; implementation must not silently redefine the contract, nor may the contract be silently weakened to match accidental code behavior.
7. **Archive has zero current authority**: [`docs/archive/`](../archive/) contains historical records for provenance only.
