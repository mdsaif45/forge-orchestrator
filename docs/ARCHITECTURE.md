# Forge Architecture

**Status:** IMPLEMENTED  
**Authority:** Architectural Hub & Navigation Bridge  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Modular Architecture Root:** [`docs/architecture/`](architecture/README.md)  

---

## 1. Overview & Modular Documentation Structure

Forge's architecture documentation has been refactored from a monolithic document into a modular, authoritative architecture suite located in [`docs/architecture/`](architecture/README.md).

For detailed specifications and contracts on individual subsystems, consult the dedicated architecture documents:

| Architectural Domain | Authoritative Modular Document | Primary Topics & Contracts |
| :--- | :--- | :--- |
| **System Overview & Topology** | [**`architecture-overview.md`**](architecture/architecture-overview.md) | High-level system topology, process boundaries, Headless Core kernel, client interfaces. |
| **Execution Model & Lifecycle** | [**`execution-model.md`**](architecture/execution-model.md) | Task → Run → Step → Event → Artifact hierarchy, execution lifecycle. |
| **Evidence & Verification** | [**`evidence-and-verification.md`**](architecture/evidence-and-verification.md) | Axiom A3, physical git diff reconciliation, criteria evaluation, independent test runners. |
| **Agent Runtime Abstraction** | [**`agent-runtime.md`**](architecture/agent-runtime.md) | `IAgentRuntime`, native agent loop, external CLI adapters, PTY session lifecycle. |
| **State, Persistence & Storage** | [**`state-and-storage.md`**](architecture/state-and-storage.md) | Dual-tier persistence: SQLite (`RunStore`, `EventStore`, `ArtifactStore`) + filesystem `ArtifactService`. |
| **Workflow Engine & Graph** | [**`workflow-engine.md`**](architecture/workflow-engine.md) | Linear state machine pipeline, loop guards, no-progress diff detector, DAG roadmap. |
| **CLI & IPC Interfaces** | [**`cli-and-ipc.md`**](architecture/cli-and-ipc.md) | Headless CLI (`bin/forge.ts`), NDJSON streaming, Electron IPC router contracts. |
| **Security & Isolation** | [**`security-and-trust.md`**](architecture/security-and-trust.md) | Guardrails vs sandbox, least privilege scoping, folder trust (`ClaudeTrustStore`), secret redaction. |
| **Concurrency & Processes** | [**`concurrency-and-isolation.md`**](architecture/concurrency-and-isolation.md) | `ProcessManager`, process tree termination (`taskkill /T /F`), Windows ConPTY vs POSIX PTY. |
| **Domain Model & Entities** | [**`domain-model.md`**](architecture/domain-model.md) | Domain entity definitions, relationships. Links to [`docs/DOMAIN.md`](DOMAIN.md). |

### Formal Contracts
- [**`contracts/execution-protocol.md`**](architecture/contracts/execution-protocol.md): The typed task input/output wire protocol and `FORGE_REPORT` format.
- [**`contracts/run-and-step-lifecycle.md`**](architecture/contracts/run-and-step-lifecycle.md): State transitions, bounded loop invariants, and failure semantics.
- [**`contracts/artifact-storage.md`**](architecture/contracts/artifact-storage.md): Filesystem directory layout, path containment security, and windowed byte-offset reader.
- [**`contracts/verification-criteria.md`**](architecture/contracts/verification-criteria.md): The 7 criteria kinds, schemas, and evaluator precedence rules.

---

## 2. Core Topology & Processes

```
┌─────────────────────── MAIN (Node) ────────────────────────┐
│ owns: project truth · git · child processes · persistence  │
│                                                            │
│  src/main/core/forgeCore.ts Headless Core kernel           │
│  src/main/core/taskRunner.ts Native agent execution loop   │
│  src/main/db/               SQLite stores (better-sqlite3) │
│  src/main/artifacts/        Filesystem ArtifactService     │
│  src/main/ipc/router.ts     Validation & typed dispatch    │
└────────────────────────────┬───────────────────────────────┘
                             │  contextBridge (typed IPC channels)
┌────────────────────────────┴───────────────────────────────┐
│ PRELOAD  src/preload/index.ts                              │
│ named methods only · no bare invoke reaches renderer       │
└────────────────────────────┬───────────────────────────────┘
                             │  window.forge.<domain>.<method>()
┌────────────────────────────┴───────────────────────────────┐
│ RENDERER (React 19)  no Node · no Electron · sandboxed     │
│                                                            │
│  src/renderer/src/app/    Shell, routing, UI stores        │
│  src/renderer/src/ui/     Tokens + primitives              │
│  src/renderer/src/ipc.ts  Unwraps result envelopes         │
└────────────────────────────────────────────────────────────┘

           src/shared/   compiled into all three
                         pure data and pure functions only
```

---

## 3. The Core Invariants

1. **Axiom A1 (State Ownership)**: Forge owns state; agents are replaceable workers. Chat transcripts are never project state.
2. **Axiom A2 (Unknown != Assume)**: Never guess. Probe repository and configuration; if ambiguous, halt in `AWAITING_USER` and present a structured `OpenQuestion`.
3. **Axiom A3 (Evidence > Claims)**: An agent claiming success has zero normative weight. Forge runs compilers, executes test suites, and runs `git diff` independently.
4. **Axiom A4 (Decisions Lock)**: Architectural decisions are versioned and locked in SQLite. Modifying them requires an approved Architectural Change Request.
5. **Axiom A5 (Bounded Loops)**: Every workflow enforces max iterations, wall-clock timeouts, and no-progress diff detection.
6. **Axiom A6 (No Provider in Core)**: Core kernel sees `IAgentRuntime` only. Vendor APIs and CLIs live exclusively in adapters.
7. **Axiom A7 (Least Privilege)**: Permissions are enforced structurally by the engine, not requested via prompts.
