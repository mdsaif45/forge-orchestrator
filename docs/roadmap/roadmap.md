# Forge Strategic Roadmap

**Status:** PROPOSED  
**Authority:** Planning Truth  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Milestones:** [milestones.md](milestones.md)  
**Related Dependencies:** [dependency-map.md](dependency-map.md)  

---

## 1. Strategic Trajectory

Forge is evolving from an Electron-bound desktop prototype into a hardened, dual-interface AI engineering control plane (Headless CLI + Desktop UI).

The program is organized into four major phases:

```
PHASE 1: Core Decoupling & Storage (M0–M4)   ██████████  COMPLETE (on main)
PHASE 2: Observability & Verification (M5)   ████████░░  IN PROGRESS (PR #204)
PHASE 3: Modular DAG & Steering (M6–M7)      ░░░░░░░░░░  NEXT
PHASE 4: Provider Ecosystem & Scale (M8–M9)  ░░░░░░░░░░  FUTURE
```

---

## 2. Program Phases in Detail

### Phase 1: Foundation & Headless Core (Milestones M0 – M4)
*Goal: Decouple the execution engine from the GUI, establish native agent execution, and build a dual-tier persistence layer.*
- **M0 Baseline**: Hardened CI, typecheck, lint, process boundaries.
- **M1 Headless Core**: Extract `createForgeCore` from Electron Main; support custom `--data-dir` (PR #198).
- **M2 Native Agent Core**: Native in-process autonomous tool loop (`taskRunner.ts`, PR #198).
- **M3 Forge CLI**: Standalone `bin/forge.ts` with NDJSON streaming and exit codes (PR #198).
- **M4 State & Storage**: SQLite `RunStore`/`EventStore` and filesystem `ArtifactService` with SHA-256 and windowed reading (PR #203).

### Phase 2: Observability, Verification & Criteria (Milestone M5)
*Goal: Independent objective verification and full criteria enforcement.*
- **Criteria Hardening**: Implement the 7 criteria evaluators (`CRIT-001`).
- **Terminal Observability**: Interactive multi-pane TUI for CLI runs (`CLI-004`).
- **Windowed Artifact Inspection**: Streaming reader for large logs (`ARTIFACT-001`).
*(Actively implemented in PR #204, pending merge).*

### Phase 3: Modular DAG Workflows & Interactive Steering (Milestones M6 – M7)
*Goal: Evolve from sequential stage pipelines to flexible DAG execution with mid-flight human intervention.*
- **M6 Generic Graph Engine**: Visual DAG nodes, parallel branches, conditional looping.
- **M7 Human Control Plane**: Real-time PTY terminal steering, mid-flight interjections, interactive decision locking.

### Phase 4: Provider Ecosystem & Production Hardening (Milestones M8 – M9)
*Goal: Broad provider compatibility and enterprise readiness.*
- **M8 3rd-Party Adapters**: ConPTY/tmux support for 15+ external CLIs (Claude Code, Antigravity, OpenCode, Aider, Cline).
- **M9 Scale & Polish**: Multi-repository workspaces, daemon mode, remote execution.
