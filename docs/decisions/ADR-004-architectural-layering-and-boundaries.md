# ADR-004 — Architectural Layering and Boundary Enforcement

**Status:** ACCEPTED  
**Authority:** Canonical Repository Dependency Architecture  
**Date:** 2026-09-29  
**Target:** Entire Codebase (`src/`)  
**Related Decisions:** [ADR-001](ADR-001-agents-runtimes-accounts.md), [ADR-002](ADR-002-interactive-orchestration.md), [ADR-003](ADR-003-host-the-real-cli.md), [ADR-005](README.md), [ADR-006](ADR-006-artifact-storage-authority.md)  
**Related Architecture:** [architecture-overview.md](../architecture/architecture-overview.md), [contracts/](../architecture/contracts/README.md)  

---

## Context

Forge is an AI engineering control plane where multiple autonomous coding agents collaborate on software repositories under a shared execution protocol. Because Forge is developed with heavy AI assistance, the characteristic architectural hazard is **architectural drift**: code compiles, test suites pass, but module boundaries blur as components import across layers without architectural discipline.

Prior architectural milestones established key boundaries:
- **ADR-001 / ADR-003:** Established `IAgentRuntime` and hosted real CLIs in pseudo-terminals (ConPTY / POSIX PTY), separating agent processes from accounts.
- **Axiom A6:** Forbade concrete provider and runtime names (`claude`, `anthropic`, `antigravity`) from core orchestration logic.
- **ADR-005:** Extracted Application Read Models (`src/shared/views/`) from IPC transport (`src/shared/ipc.ts`), ensuring pure query DTOs and event payloads.
- **ADR-006:** Established `ArtifactService` as application authority and SQLite `ArtifactStore` as metadata persistence.

However, a live baseline audit of `main` revealed four critical boundary violations and architectural ambiguities:
1. **Infrastructure Upward Leak:** `src/main/terminal/terminalService.ts` directly imported and called `ProjectService` (`src/main/projects/projectService.ts`) to resolve project working directories.
2. **Database Schema & ORM Leak:** `src/main/workflows/workflowService.ts` bypassed persistence abstractions to directly import `drizzle-orm` and `src/main/db/schema.ts` (`tasks` table) for raw database queries.
3. **Runtime Adapter Leaking into Application Services:** `src/main/runtimes/claudeCliRuntime.ts` imported `accountEnv` from `src/main/accounts/accountAuth.ts` rather than receiving process environment through runtime invocation contracts.
4. **Application Leaking into Concrete Provider Concerns:** `src/main/workflows/workflowService.ts` directly imported and instantiated `ClaudeTrustStore` (`src/main/runtimes/claudeTrust.ts`), violating Axiom A6.

To prevent architectural entropy, Forge requires a normative dependency model backed by automated CI gates.

---

## Decision

Forge formally establishes a **strict unidirectional dependency-direction model** defined by explicit subsystem roles. Architecture in Forge is governed by a directed acyclic graph (DAG) of architectural layers rather than directory depth.

### 1. Subsystem Definitions

1. **Domain (`src/shared/domain/`):** Pure entities, value objects, state machines, validation schemas, and domain protocols. Zero dependencies on platform, framework, or lower layers.
2. **Views (`src/shared/views/`):** Pure read models, query DTOs, projection types, and event-stream payloads. Depends only on `zod` and `domain`.
3. **IPC Transport (`src/shared/ipc.ts`, `src/main/ipc/`, `src/preload/`):** Channel constants, request-response envelope types, Zod routers, and ContextBridge preload bindings.
4. **Application Services (`src/main/<service>/`):** Business logic, project management, workflow orchestration, artifact management, and decision governance (`projects`, `accounts`, `workflows`, `changesets`, `decisions`, `questions`, `bindings`, `artifacts`, `audit`, `health`, `templates`).
5. **Execution & Coordination (`src/main/core/taskRunner.ts`, `src/main/runtimes/orchestrator.ts`, `src/main/evidence/`, `src/main/context/`):** Task/workflow execution loops, evidence collection, step verification, and prompt packet assembly.
6. **Runtime Adapters (`src/main/runtimes/`):** External CLI process hosting (PTY/pipes), `IAgentRuntime` implementations, capability declarations, and runtime registries.
7. **Providers (`src/main/providers/`):** LLM API clients, tool schemas, token stream parsers, and active model selection.
8. **Infrastructure (`src/main/db/`, `src/main/process/`, `src/main/git/`, `src/main/terminal/`, `src/main/logging/`):** SQLite persistence, process tree management, Git CLI execution, and terminal session registries.
9. **Composition Roots (`src/main/core/forgeCore.ts`, `src/main/index.ts`, `src/main/cli.ts`):** Central dependency injection factories that wire, instantiate, and boot the system.
10. **Renderer (`src/renderer/`):** Sandboxed React 19 user interface and design system.

---

## 2. Dependency-Direction Rules

### Rule 1: Pure Domain Isolation
- `src/shared/domain/**` **MUST NOT** import from any other subsystem (`views`, `ipc`, `main`, `preload`, `renderer`).
- `src/shared/domain/**` **MUST NOT** import Node.js built-ins (`fs`, `path`, `crypto`, `child_process`), Electron, or DOM APIs.
- Domain modules depend exclusively on peer domain modules and external pure validation libraries (`zod`).

### Rule 2: Pure Views / Read Models Isolation
- `src/shared/views/**` **MUST NOT** import from `src/main/**`, `src/preload/**`, or `src/renderer/**`.
- `src/shared/views/**` **MUST NOT** import Node.js built-ins, Electron, or DOM APIs.
- Views modules **MAY** import from `src/shared/domain/**` for domain types and schemas.

### Rule 3: Renderer Sandboxing
- `src/renderer/**` **MUST NOT** import Node.js built-ins (`fs`, `path`, `child_process`), Electron internals, or any module from `src/main/**`.
- `src/renderer/**` **MUST** communicate with the backend exclusively through the typed `window.forge` contextBridge API declared in `src/preload/api.ts`.
- `src/renderer/**` **MAY** import types and schemas from `@shared/views`, `@shared/domain`, and `@shared/ipc`.

### Rule 4: Application ↔ IPC Transport Separation
- Application Services (`src/main/<service>/**`) **MUST NOT** import from `@shared/ipc` or `src/main/ipc/**`.
- Application Services return View DTOs defined in `@shared/views`.
- `src/main/ipc/**` dispatches incoming IPC requests to Application Services and serializes responses into typed envelopes.
- IPC transport concerns never leak into application services.

### Rule 5: Infrastructure Downward Direction
- Infrastructure modules (`src/main/{db,process,git,terminal,logging}/**`) **MUST NOT** import Application Services, Execution modules, or Runtime Adapters.
- Dependencies between Infrastructure and Application Services **MUST** point downward: Application Services depend on Infrastructure abstractions.
- Infrastructure services requiring application context (e.g. project working directories) **MUST** receive it via injected callbacks or ports (Dependency Inversion).

### Rule 6: Persistence Abstraction & Database Schema Privacy
- Database table definitions (`src/main/db/schema.ts`) and ORM query builders (`drizzle-orm`) **MUST NOT** be imported outside `src/main/db/**`.
- Application Services and Execution engines **MUST** interact with persistence exclusively through Store or Repository interfaces.
- Composition roots **MUST** inject Store instances into Application Services via constructor parameters (**PREFERRED**).

### Rule 7: Runtime & Provider Boundary (Axiom A6)
- Concrete runtime adapters (`src/main/runtimes/*CliRuntime.ts`, `mockRuntime.ts`) and vendor provider names (`claude`, `anthropic`, `antigravity`) **MUST NOT** be imported outside `src/main/runtimes/**`.
- Application Services and Execution modules **MUST** interact with runtimes strictly through `IAgentRuntime` resolved via `RuntimeRegistry`.
- Runtime adapters **MUST NOT** import application service internals. Configuration, credentials, and account homes **MUST** cross the boundary via `SessionOptions` or constructor options.
- Workspace preparation (such as folder trust) **MUST** be encapsulated inside the runtime adapter lifecycle or an injected workspace preparation port, not called directly by application services.

### Rule 8: Composition Root Exemption
- Central composition roots (`src/main/core/forgeCore.ts`, `src/main/index.ts`, `src/main/cli.ts`) **MAY** import and wire concrete classes from all main subsystems.
- This exemption applies strictly to the composition roots; no other module inherits this exemption.

### Rule 9: Zero Circular Dependencies
- The module dependency graph across `src/` **MUST** remain a strict Directed Acyclic Graph (DAG).
- Circular dependencies are **STRICTLY FORBIDDEN**.

---

## 3. Remediations Executed Under ADR-004

To achieve compliance with these rules, four pre-existing boundary violations were remediated:

1. **`terminalService.ts` Inverted:** Inverted `TerminalService`'s dependency on `ProjectService` by injecting `resolveProjectCwd: (projectId: string) => Promise<string | null>` in `TerminalServiceOptions`.
2. **`workflowService.ts` Query Encapsulated:** Encapsulated raw task queries inside `WorkflowStore.getTask(taskId)` in `src/main/db/workflowStore.ts`, removing all imports of `drizzle-orm` and `src/main/db/schema.ts` from `workflowService.ts`.
3. **`claudeCliRuntime.ts` Decoupled from Accounts:** Extracted the pure process environment builder `accountEnv(home)` to `src/main/process/accountEnv.ts`, eliminating the runtime adapter's dependency on `src/main/accounts/accountAuth.ts`.
4. **`ClaudeTrustStore` Encapsulated:** Removed direct `ClaudeTrustStore` instantiation from `WorkflowService`. Workspace trust preparation is handled by the runtime adapter lifecycle (`prepareWorkspace`) or workspace trust abstraction.

---

## 4. Enforcement Strategy

These boundaries are enforced deterministically on every CI run and developer check:

1. **ESLint Rules (`eslint.config.js`):**
   - Configures `no-restricted-imports` with exact subsystem patterns for Domain, Views, Renderer, IPC Transport, Infrastructure, and DB Schema privacy.
   - Enforces Axiom A6 syntax restrictions to prevent vendor name leaks.
2. **Deterministic Cycle Gate (`scripts/check-cycles.mjs`):**
   - Pure Node.js script using the TypeScript Compiler AST and Tarjan's Strongly Connected Components algorithm.
   - Evaluates all non-test TypeScript source files in `src/`.
   - Exits 0 on DAG; exits 1 and prints the exact cycle path if a circular dependency is detected.
3. **Router Contract Check (`scripts/router-check.mjs`):**
   - Enforces typed IPC dispatch and runtime contract validation.
4. **Architectural Tests (`src/test/architecture.test.ts`):**
   - Automated tests verifying that no forbidden imports or cycle regressions occur.

---

## 5. Consequences & Non-Goals

### Consequences
- Architectural integrity is mechanically verified on every `npm run check`.
- Unidirectional dependencies ensure that subsystems can be independently tested and refactored without cascading breaks.

### Explicit Non-Goals
- **No StepExecutor Implementation:** ADR-004 defines boundaries; it does not implement or prescribe the StepExecutor extraction.
- **No M6 DAG Redesign:** The linear workflow state machine remains unchanged; DAG engine work is deferred to milestone M6.
- **No Package Extraction:** Forge remains a cohesive monorepo; packages such as `forge-engine`, `forge-cli`, or `forge-desktop` are not extracted at this time.
- **No Broad Folder Restructuring:** Modules remain in their existing physical directories; boundaries are enforced across the current tree.
