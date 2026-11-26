# Deferred Capabilities & Non-Goals

**Status:** ACCEPTED  
**Authority:** Planning Truth  
**Last Updated:** 2026-11-26  
**Baseline:** `main` @ `cfb0f4c` (PR #488 merged)  
**Related Roadmap:** [roadmap.md](roadmap.md), [milestones.md](milestones.md)  

---

## 1. Explicit Non-Goals

To maintain focus on orchestration control and avoid architectural bloat, the following capabilities remain explicit non-goals for Forge:

| Non-Goal | Technical & Strategic Rationale |
| :--- | :--- |
| **Custom Code Editor** | Forge is an orchestration control plane, not an IDE replacement. Developers keep their preferred editors (VS Code, Cursor, Neovim, JetBrains); Forge orchestrates agents, diffs, and verification around the repository. |
| **Autonomous Self-Approval** | Removing the human from critical decision gates and merge authorization is an anti-pattern. Forge automates execution and verification, not engineering judgment (Axiom A4). |
| **Third-Party Plugin Marketplace** | Provider/runtime extension is standardized via `IAgentRuntime` and data-driven CLI configs rather than an untrusted third-party UI plugin ecosystem. |

---

## 2. Previously Deferred Items — Now Implemented

The items originally deferred in earlier releases were reactivated after their upstream prerequisites stabilized and are now **complete on `main`**:

### 1. Visual Drag-and-Drop Workflow Canvas (`UI-001`) — **IMPLEMENTED**
- **Originally Deferred To:** M6 / M7; **Delivered In:** M15 (#439, PR #487).
- **Status:** React visual DAG composition canvas (`WorkflowCanvas.tsx`) delivered after `GraphExecutor` and YAML DSL schemas (`COMP-001`, `COMP-002`) stabilized.

### 2. Multi-Repository Workspace Orchestration (`POLISH-001`) — **IMPLEMENTED**
- **Originally Deferred To:** M9; **Delivered In:** M14 (#440, PR #484).
- **Status:** Multi-repository workspace registration and cross-repo coordination shipped on top of policy-governed concurrency (`PAR-001`) and isolated git worktrees (`PAR-002`).

### 3. Cross-Run Agent Memory (`AGENT-007`) — **IMPLEMENTED**
- **Originally Deferred To:** M8; **Delivered In:** M12 (`agentMemory.ts`).
- **Status:** Grounded solution pattern recall backed by verified exit-0 runs, SQLite event history, and physical git artifacts (avoiding ungrounded vector hallucinations).

### 4. Cloud Synchronization & State Replication Backplanes (`POLISH-002`) — **IMPLEMENTED**
- **Originally Deferred To:** Post-MVP; **Delivered In:** M15 (#441, PR #488).
- **Status:** Content-addressed local-first state sync and delta reconciliation backplane added while keeping SQLite + local disk sovereign.
