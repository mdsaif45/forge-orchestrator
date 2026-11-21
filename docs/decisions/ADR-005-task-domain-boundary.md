# ADR-005 — Task Domain Boundary and Workflow-Bound Execution Lifecycle

**Status:** IMPLEMENTED  
**Authority:** Architectural Decision Record (Resolves Issue #117)  
**Date:** 2026-11-18  
**Target:** Domain (`src/shared/domain/`), Navigation (`src/renderer/`), Workflow Views (`src/shared/views/`)  
**Related Decisions:** [ADR-001](ADR-001-agents-runtimes-accounts.md), [ADR-002](ADR-002-interactive-orchestration.md), [ADR-004](ADR-004-architectural-layering-and-boundaries.md)  
**Related Documentation:** [`docs/DOMAIN.md`](../DOMAIN.md)  

---

## 1. Context

During the Phase 1 hands-on usability review (#102), `/tasks` was identified as one of two navigation items pointing at a non-functional `RoutePlaceholder`. To maintain integrity and avoid presenting dead UI paths as features, the route was removed from the application navigation.

Issue #117 posed the fundamental architectural question regarding the entity `Task`:
1. **Option 1: Tasks are user-authored backlog tickets.** The user creates tasks with objectives and criteria in advance on a standalone `/tasks` page, managing a backlog and running workflows against pre-existing tasks.
2. **Option 2: Tasks are internal execution records.** Tasks are an authoritative execution contract minted implicitly per workflow run (`Workflow.taskId`), encapsulating the objective, constraints, scope, and criteria for that specific execution. Work history and active execution belong on the Workflow screen.

---

## 2. Decision

Forge formally adopts **Option 2: Tasks are internal execution records bound to workflow runs.**

1. **No Standalone Backlog Page:**
   - Forge is an agentic engineering control plane and live steering environment, not an issue tracker or general-purpose project management backlog.
   - The `/tasks` route remains absent from application navigation and will not be resurrected as an independent page.

2. **Authoritative Execution Contract:**
   - A `Task` domain entity (`objective`, `constraints[]`, `completionCriteria[]`, `scope`, `lockedDecisionIds[]`) represents the precise goal and constraints agreed upon for an execution run.
   - It is immutably minted when a workflow is initiated (`workflowService.start`) and remains the single source of truth for prompt packet compilation (Axiom A1).

3. **Surfacing on Workflow Views:**
   - The task's objective, constraints, and criteria are first-class fields on the workflow screen (`WorkflowPage.tsx`, `StepInspector.tsx`, and `WorkflowCanvas.tsx`).
   - The user inspects and steers work in the workflow execution context, where terminal streams, agent personas, decisions, and artifacts converge.

---

## 3. Consequences

### Positive
- Prevents UI bloat and eliminates an empty, low-utility CRUD screen that developers would not use.
- Aligns with Axiom A1 (Forge owns truth): the execution contract is immutably versioned with the workflow rather than mutable in a separate backlog.
- Eliminates synchronization drift between backlog task state and active workflow execution state.

### Negative / Trade-offs
- Users who expect Jira/Linear-style backlog management within Forge must rely on external issue trackers or Forge project goals. (External issue synchronization can be handled via plugin MCPs or CLI tools without polluting the core domain).
