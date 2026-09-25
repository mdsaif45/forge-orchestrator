# Deferred Capabilities & Non-Goals

**Status:** ACCEPTED  
**Authority:** Planning Truth  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Roadmap:** [roadmap.md](roadmap.md), [milestones.md](milestones.md)  

---

## 1. Explicit Non-Goals (For MVP)

To maintain focus and avoid architectural bloat, the following capabilities are explicitly classified as non-goals for the initial releases of Forge:

| Non-Goal | Technical & Strategic Rationale |
| :--- | :--- |
| **Custom Code Editor** | Forge is an orchestration control plane, not an IDE replacement. Developers already have tuned editors (VS Code, Cursor, Neovim, JetBrains). Forge diffs and monitors repositories; it does not build a text editor. |
| **Cloud Synchronization / Team SaaS** | Forge is local-first and sovereign. Syncing state to a central SaaS backend introduces auth complexity, latency, and security liabilities prematurely. |
| **Autonomous Self-Approval** | Removing the human from critical decision gates and merge authorization is an anti-pattern. Forge automates transport, not judgment. |
| **Plugin Marketplace** | Core execution and adapter interfaces (`IAgentRuntime`) must stabilize before defining third-party plugin extension points. |

---

## 2. Intentionally Deferred Items

The following features have been proposed and validated as valuable, but are intentionally deferred to later milestones:

### 1. Visual Drag-and-Drop Workflow Canvas
- **Deferred to:** Milestone M6 / M7.
- **Rationale:** Building a visual canvas before the underlying execution engine (`WORK-001`) is stable results in throwaway UI code. The DAG execution semantics must be proven headlessly before building visual authoring tools.
- **Reactivation Trigger:** Successful headless execution of DAG workflow schemas.

### 2. Multi-Repository Workspace Orchestration
- **Deferred to:** Milestone M9.
- **Rationale:** Orchestrating agents across multiple interdependent git repositories simultaneously multiplies worktree management, branch tracking, and dependency complexity. Single-repository multi-agent execution must achieve zero-defect reliability first.
- **Reactivation Trigger:** M7 Human Control Plane declared complete and verified.

### 3. Agent Semantic Memory System
- **Deferred to:** Milestone M8.
- **Rationale:** Cross-run agent memory without verified ground truth leads to hallucination propagation. Long-term memory should be backed by the immutable SQLite event log and committed git history, not arbitrary vector embeddings.
- **Reactivation Trigger:** Event log replay and indexing fully implemented.
