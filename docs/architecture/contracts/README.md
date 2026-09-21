# Architecture Contracts

This directory contains formal, binding contract specifications for Forge.

## Contracts Inventory

| Contract | Purpose | Status | Authority |
| :--- | :--- | :--- | :--- |
| [`execution-protocol.md`](execution-protocol.md) | The typed task input/output wire protocol between ForgeCore and agent runtimes. | **FROZEN** | Canonical Protocol |
| [`run-and-step-lifecycle.md`](run-and-step-lifecycle.md) | Deterministic state transitions, error semantics, and bounds for Runs and Steps. | **FROZEN** | Canonical Lifecycle |
| [`artifact-storage.md`](artifact-storage.md) | Filesystem directory layout, path containment security, SHA-256 integrity, and windowed reading. | **FROZEN** | Canonical Storage |
| [`verification-criteria.md`](verification-criteria.md) | Criteria schemas, evaluator precedence, and physical reconciliation rules. | **FROZEN** | Canonical Verification |

---

## Contract Standards

Every contract document in this directory adheres to the following structural requirements:
- **Purpose**: Clear definition of the boundary governed by the contract.
- **Status & Authority**: Explicit metadata declaring binding status.
- **Schema & Types**: Exact TypeScript or JSON schemas.
- **Invariants**: Strict rules that must never be violated.
- **Valid Transitions & Failure Semantics**: How errors, halts, and cancellations behave.
- **Verification Evidence**: Automated tests that enforce the contract in CI.
