# Canonical Domain Model & Entity Relationships

**Status:** IMPLEMENTED  
**Authority:** Normative Domain Architecture  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Specifications:** `docs/DOMAIN.md`, `docs/FORGE_RULES.md`  
**Related Contracts:** [run-and-step-lifecycle.md](contracts/run-and-step-lifecycle.md), [execution-protocol.md](contracts/execution-protocol.md)  
**Related Implementation:** `src/shared/domain/`  

---

## 1. Domain Entities & Hierarchy

Forge models software projects, multi-agent collaboration, and execution history through a strongly typed domain model:

```
Workspace
 └── Project
      ├── Repository     (path, defaultBranch, buildCmd, testCmd, tech[])
      ├── Rule           (scope, key, value, source)
      ├── AgentBinding   (role, runtimeId, accountId, permissions)
      ├── Decision       (statement, rationale, status, lockedAt)
      ├── OpenQuestion   (asker, evidence[], options[], recommendation, answer)
      ├── Task           (objective, constraints[], completionCriteria[])
      ├── Workflow       (templateId, state, iteration, checkpoint)
      │    └── Step      (role, agentId, contextRef, output, verdict)
      ├── Run            (id, taskId, status, timing, metadata)
      │    ├── StepRun   (runId, stepIndex, status, verdict)
      │    ├── Artifact  (id, runId, type, path, sha256, sizeBytes)
      │    └── Event     (seq, ts, type, payload, actor)
      └── ChangeSet      (baseSha, files[], patch, authorAgent, reviewVerdict)
```

---

## 2. Critical Distinctions That Matter

To prevent architectural degradation, Forge strictly distinguishes four concepts that are frequently conflated in naive orchestrators:

### 1. Decision vs. Rule
- **Rule (`docs/FORGE_RULES.md`)**: Standing, structural policy that applies across scopes (e.g. "Never modify database migrations without approval"). Rules are inherited hierarchically (Global → Project → Workflow → Task).
- **Decision (`Decision`)**: A specific, point-in-time architectural or technical choice made during a workflow (e.g. "Use SQLite for metadata, filesystem for blobs"). Decisions are versioned and explicitly locked by the human user.

### 2. Task vs. Workflow
- **Task (`Task`)**: The declaration of *what* needs to be achieved, specifying constraints (`allowedPaths`) and objective verification criteria (`completionCriteria`).
- **Workflow (`Workflow`)**: The execution state machine of *how* the task is being attempted, tracking stages, iterations, and checkpointed state.

### 3. ChangeSet vs. Step Output
- **Step Output (`AgentTaskOutput`)**: What the agent *claimed* occurred during its execution turn.
- **ChangeSet (`ChangeSet`)**: What the physical git repository *actually shows* upon diffing the worktree against the base SHA. 
Forge reconciles these two entities; it never assumes they are identical (Axiom A3).

### 4. Account vs. Agent vs. Session
- **Account**: An authentication credential or API key for an LLM provider.
- **Agent**: A logical worker bound to a role from `roleSchema` in `src/shared/domain/enums.ts`: `planner`, `implementer`, `reviewer`, `tester`, `security-reviewer`, plus `system` and `user`, which Forge performs itself with no runtime involved.
- **Session**: One active, ephemeral PTY process or conversation instance.
Switching accounts changes only credentials—it never alters project state, locked decisions, or workflow progress.

---

## 3. Workflow State Machine Specification

The canonical workflow state machine, transition logic, and auto-generated Mermaid diagram are maintained in:
👉 **[`docs/DOMAIN.md`](../DOMAIN.md)**

`docs/DOMAIN.md` is verified by the automated build system (`npm run check:docs`). The state diagram inside it is compiled directly from `src/shared/domain/transitions.ts` via `scripts/generate-state-diagram.mjs`.
