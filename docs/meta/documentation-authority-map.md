# Forge Documentation Authority Map

**Status:** ACCEPTED  
**Authority:** Governance Reference (see [documentation-policy.md](documentation-policy.md))  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `5987501` (PR #204 merged) | Active Branch: `docs/crit-001-post-merge-bookkeeping` @ `9719092`  
**Audit Report:** [normative-truth-audit.md](normative-truth-audit.md)  

---

## 1. Purpose

This authority map establishes the canonical document for every architectural topic, domain concept, and engineering subsystem in Forge. 

When any conflict or ambiguity arises, the **Canonical Document** designated below is the sole authoritative specification for that topic. No secondary document, roadmap entry, task tracker, or PR description may contradict it.

---

## 2. Topic Authority Matrix

| Topic | Canonical Document | Status | Authority Level | Implementation Evidence | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Product Purpose & Core Thesis** | [`docs/product/vision.md`](../product/vision.md), [`docs/product/north-star.md`](../product/north-star.md) | ACCEPTED | Normative (Vision) | `src/main/core/forgeCore.ts` | Human-loop workflows, dogfood acceptance logs |
| **Product Invariants & Axioms** | [`docs/product/principles.md`](../product/principles.md) | FROZEN | Normative (Principles) | Core architecture enforcement of Axioms A1–A7 | Architectural tests, state guard assertions |
| **Human Interaction Workflow** | [`docs/product/user-workflow.md`](../product/user-workflow.md) | ACCEPTED | Informative (Workflow) | `src/main/workflows/workflowService.ts` | `src/main/acceptance/mvpAcceptance.test.ts` (3) |
| **High-Level System Architecture** | [`docs/architecture/architecture-overview.md`](../architecture/architecture-overview.md) | ACCEPTED | Normative (System) | Decoupled core in `src/main/core/forgeCore.ts` | `src/main/core/forgeCore.test.ts` (4) |
| **Execution Kernel & Task Loops** | [`docs/architecture/execution-model.md`](../architecture/execution-model.md) | ACCEPTED | Normative (Architecture) | `src/main/core/taskRunner.ts` | `src/main/core/taskRunner.test.ts` (8) |
| **Dual-Tier State & Storage** | [`docs/architecture/state-and-storage.md`](../architecture/state-and-storage.md) | ACCEPTED | Normative (Architecture) | `src/main/db/`, `src/main/artifacts/artifactService.ts` | `runStore.test.ts` (4), `eventStore.test.ts` (24), `artifactService.test.ts` (8) |
| **Evidence & Physical Verification** | [`docs/architecture/evidence-and-verification.md`](../architecture/evidence-and-verification.md) | ACCEPTED | Normative (Architecture) | `src/main/evidence/verifier.ts`, `src/shared/domain/reconcile.ts`, `src/main/git/gitService.ts` | `verifier.test.ts` (14), `reconciliation.integration.test.ts` (12), `gitService.test.ts` (47) |
| **Criteria Evaluator Engine** | [`docs/architecture/contracts/verification-criteria.md`](../architecture/contracts/verification-criteria.md) | FROZEN | Canonical Contract | `src/shared/domain/criterion.ts`, `src/shared/domain/completion.ts`, `src/main/core/taskRunner.ts` | `completion.test.ts` (25), `taskRunner.test.ts` (8) |
| **Agent Runtime & CLI Adapters** | [`docs/architecture/agent-runtime.md`](../architecture/agent-runtime.md) | ACCEPTED | Normative (Architecture) | `src/shared/domain/runtime.ts`, `src/main/runtimes/` | `runtimes.test.ts` (30), `claudeCliRuntime.test.ts` (17) |
| **Agent / Skill / Tool Concept Model** | [`docs/architecture/agent-concept-model.md`](../architecture/agent-concept-model.md) | PROPOSED | Design Gate (Concept) | Gated design specification (Not implemented) | Conceptual gate; architecture review |
| **Process Isolation & PTY** | [`docs/architecture/concurrency-and-isolation.md`](../architecture/concurrency-and-isolation.md) | ACCEPTED | Normative (Architecture) | `src/main/process/processManager.ts`, `ptyProcessRunner.ts` | `process.test.ts` (40), `ptyProcessRunner.test.ts` (12) |
| **Security, Scoping & Trust** | [`docs/architecture/security-and-trust.md`](../architecture/security-and-trust.md) | ACCEPTED | Normative (Architecture) | `src/shared/domain/policyEngine.ts`, `src/main/runtimes/claudeTrust.ts` | `claudeTrust.test.ts` (8), `guards.integration.test.ts` (4) |
| **Linear Workflow Engine / Generic DAG** | [`docs/architecture/workflow-engine.md`](../architecture/workflow-engine.md) | ACCEPTED (Linear) / PROPOSED (DAG) | Normative (Linear) / Future (DAG) | `src/main/workflows/workflowService.ts`, `orchestrator.ts` | `orchestrator.test.ts` (31), `workflowGraph.test.ts` (6) |
| **Domain Entities & State Machine** | [`docs/DOMAIN.md`](../DOMAIN.md), [`docs/architecture/domain-model.md`](../architecture/domain-model.md) | IMPLEMENTED | Code-Pinned Normative | `src/shared/domain/` (`enums.ts`, `ids.ts`, `run.ts`, `artifact.ts`) | `npm run check:docs` CI gate, domain unit tests |
| **Standing Policy Rules R1–R8** | [`docs/FORGE_RULES.md`](../FORGE_RULES.md), [`docs/specifications/rules-and-policy.md`](../specifications/rules-and-policy.md) | IMPLEMENTED | Code-Pinned Normative | `src/shared/domain/forgeRules.ts`, `policyEngine.ts` | `src/main/projects/projects.test.ts` (39) |
| **Execution Protocol Contract** | [`docs/architecture/contracts/execution-protocol.md`](../architecture/contracts/execution-protocol.md) | FROZEN | Canonical Contract | `src/shared/domain/protocol.ts`, `src/main/core/taskRunner.ts` | `protocol.test.ts` (36), `taskRunner.test.ts` (8) |
| **Run & Step Lifecycle Contract** | [`docs/architecture/contracts/run-and-step-lifecycle.md`](../architecture/contracts/run-and-step-lifecycle.md) | FROZEN | Canonical Contract | `src/shared/domain/run.ts`, `src/main/db/runStore.ts` | `runStore.test.ts` (4), `guards.test.ts` (38) |
| **Artifact Storage Contract** | [`docs/architecture/contracts/artifact-storage.md`](../architecture/contracts/artifact-storage.md) | FROZEN | Canonical Contract | `src/main/artifacts/artifactService.ts`, `artifactStore.ts` | `artifactService.test.ts` (8), `artifactStore.test.ts` (1) |
| **Verification Criteria Contract** | [`docs/architecture/contracts/verification-criteria.md`](../architecture/contracts/verification-criteria.md) | FROZEN | Canonical Contract | `src/shared/domain/criterion.ts`, `completion.ts`, `taskRunner.ts` | `completion.test.ts` (25), `taskRunner.test.ts` (8) |
| **Agent / Runtime / Account Split** | [`docs/decisions/ADR-001-agents-runtimes-accounts.md`](../decisions/ADR-001-agents-runtimes-accounts.md) | ACCEPTED | Normative Decision | `src/shared/domain/runtime.ts`, `src/main/accounts/` | `accountSwitch.integration.test.ts` (1) |
| **Interactive Orchestration** | [`docs/decisions/ADR-002-interactive-orchestration.md`](../decisions/ADR-002-interactive-orchestration.md) | ACCEPTED | Normative Decision | `src/main/terminal/sessionRegistry.ts`, `ptyProcessRunner.ts` | `sessionRegistry.test.ts` (10) |
| **Host Real CLI in ConPTY** | [`docs/decisions/ADR-003-host-the-real-cli.md`](../decisions/ADR-003-host-the-real-cli.md) | ACCEPTED | Normative Decision | `src/main/runtimes/ptyProcessRunner.ts`, `claudeCliRuntime.ts` | `ptyProcessRunner.test.ts` (12) |
| **Main / Renderer IPC Boundary** | [`docs/architecture/architecture-overview.md`](../architecture/architecture-overview.md#5-ipc-contract-single-source-of-truth) | IMPLEMENTED | Normative (IPC) | `src/shared/ipc.ts`, `src/main/ipc/router.ts` (70 channels) | `npm run check:router` CI gate |
| **Preload Bridge API** | [`docs/architecture/architecture-overview.md`](../architecture/architecture-overview.md) | IMPLEMENTED | Normative (Bridge) | `src/preload/index.ts`, `src/preload/api.ts` | `npm run smoke` CI gate |
| **CLI Commands & Flags** | [`docs/architecture/cli-and-ipc.md`](../architecture/cli-and-ipc.md) | IMPLEMENTED | Normative (CLI) | `src/main/cli.ts`, `bin/forge.ts` (`run`, `status`, `models`, `runs`, `artifacts`) | `src/main/cli.test.ts` (8) |
| **Current Implementation Reality** | [`docs/project/current-state.md`](../project/current-state.md) | IMPLEMENTED | Implementation Truth | `main` @ `5987501` (PR #204 merged) | 1,142 passing tests across 97 test suites |
| **Verification Baseline** | [`docs/project/verification-baseline.md`](../project/verification-baseline.md) | IMPLEMENTED | Verification Truth | Node 22, 3 CI jobs (`static`, `app`, `windows`) | CI configuration `.github/workflows/ci.yml` |
| **Milestones & Program Roadmap** | [`docs/roadmap/milestones.md`](../roadmap/milestones.md), [`docs/roadmap/roadmap.md`](../roadmap/roadmap.md) | ACCEPTED | Planning Truth (Non-normative) | Roadmap tracking M0–M9 | Milestones distinguishing DONE, VERIFIED, IN-PROGRESS, BLOCKED |
| **Documentation Governance** | [`docs/meta/documentation-policy.md`](documentation-policy.md) | FROZEN | Governance Policy | Documentation layout, status schemas, precedence | `npm run check:docs`, markdown link validation |

---

## 3. Operational Governance: Authority, Evidence, Reporting & Planning

Forge separates system governance into four distinct operational dimensions rather than a naive linear precedence list:

- **AUTHORITY** ([`docs/product/`](../product/), [`docs/architecture/`](../architecture/), [`docs/decisions/`](../decisions/), [`docs/architecture/contracts/`](../architecture/contracts/)): Constrains implementation. Defines what Forge should be.
- **EVIDENCE** (`src/`, automated tests, git diffs, child process exit codes, CI logs): Establishes what is actually implemented and verified.
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
