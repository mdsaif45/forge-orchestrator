# System Context & Process Boundaries

**Status:** IMPLEMENTED  
**Authority:** Informative Architecture Diagram  
**Last Updated:** 2026-09-25  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
**Related Architecture:** [architecture-overview.md](../architecture-overview.md)  

---

## 1. System Topology & Context

```mermaid
graph TD
    User["Software Engineer"]
    
    subgraph UI_Tier["Client Presentation Tier"]
        CLI["Standalone CLI (forge)<br/>bin/forge.ts (Node.js)"]
        ElectronRenderer["Electron UI (React 19)<br/>Context-Isolated Renderer"]
    end

    subgraph Core_Tier["Headless Forge Core (Kernel)"]
        Preload["Preload ContextBridge<br/>src/preload/index.ts"]
        IpcRouter["Typed IPC Router<br/>src/main/ipc/router.ts"]
        Core["ForgeCore Kernel<br/>src/main/core/forgeCore.ts"]
        TaskRunner["TaskRunner & Orchestrator<br/>executeDirectTask"]
        Verifier["Evidence Verifier<br/>src/main/evidence/verifier.ts"]
        GitService["GitService (Direct CLI)<br/>src/main/git/gitService.ts"]
    end

    subgraph Persistence_Tier["Dual-Tier Persistence"]
        SQLite[("SQLite DB (forge.db)<br/>RunStore / EventStore")]
        DiskStorage[("Filesystem Store<br/>.forge/artifacts/<runId>/")]
    end

    subgraph External_Workers["Worker & Tool Execution"]
        ConPTY["ConPTY / PTY Host<br/>node-pty (Windows / POSIX)"]
        ClaudeCLI["Claude Code CLI<br/>claude.exe"]
        AntigravityCLI["Antigravity CLI<br/>agy.exe"]
        Compilers["Compilers & Test Runners<br/>tsc / vitest / pytest"]
    end

    User -->|Commands / Prompts| CLI
    User -->|Interactions / Approvals| ElectronRenderer
    
    ElectronRenderer -->|invoke| Preload
    Preload -->|Typed Channel| IpcRouter
    IpcRouter -->|Dispatches| Core

    CLI -->|Imports / Boots| Core

    Core --> TaskRunner
    TaskRunner --> Verifier
    TaskRunner --> GitService

    TaskRunner -->|Relational Records| SQLite
    TaskRunner -->|Blobs & Output Logs| DiskStorage

    TaskRunner -->|Hosts via PTY| ConPTY
    ConPTY --> ClaudeCLI
    ConPTY --> AntigravityCLI

    Verifier -->|Spawns with Timeout| Compilers
```
