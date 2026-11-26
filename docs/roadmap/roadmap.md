# Forge Strategic Roadmap

**Status:** IMPLEMENTED  
**Authority:** Planning Truth  
**Last Updated:** 2026-11-26  
**Baseline:** `main` @ `cfb0f4c` (PR #488 merged)  
**Related Milestones:** [milestones.md](milestones.md)  
**Related Dependencies:** [dependency-map.md](dependency-map.md)  

---

## 1. Strategic Trajectory

Forge has evolved from an Electron-bound desktop prototype into a modular, dual-interface AI engineering control plane (`@forge/shared`, `@forge/core`, `@forge/runtimes`, `@forge/cli`, `@forge/desktop`).

The initial 17-milestone engineering program (**M0–M16**) is **100% complete on `main`**:

```
PHASE 1: Core Decoupling & Storage (M0–M4)              ██████████  COMPLETE (on main)
PHASE 2: Observability & Verification (M5)              ██████████  COMPLETE (on main)
PHASE 3: Modular DAG & Interactive Steering (M6–M7)     ██████████  COMPLETE (on main)
PHASE 4: Provider Ecosystem & Warm Sessions (M8–M11)    ██████████  COMPLETE (on main)
PHASE 5: Autonomous Plane, Bench & Isolation (M12–M14)  ██████████  COMPLETE (on main)
PHASE 6: Workflow DSL, Canvas, Sync & Monorepo (M15–M16)██████████  COMPLETE (on main)
```

---

## 2. Program Phases in Detail

### Phase 1: Foundation & Headless Core (Milestones M0 – M4)
*Goal: Decouple the execution engine from the GUI, establish native agent execution, and build a dual-tier persistence layer.*
- **M0 Baseline**: Hardened CI, typecheck, lint, process boundaries, Windows git `EBUSY` elimination.
- **M1 Headless Core**: Extract `createForgeCore` from Electron Main; support custom `--data-dir` and `.forgerc` (PR #198, PR #231).
- **M2 Native Agent Core**: Native in-process autonomous tool loop (`taskRunner.ts`, `agentLoop.ts`), concurrent read-only tools, Ollama discovery (PR #198, PR #235).
- **M3 Forge CLI**: Standalone `bin/forge.ts` with NDJSON streaming, exit codes (`0`/`1`/`2`), workflow CLI, and interactive terminal TUI (`CLI-004`, PR #477).
- **M4 State & Storage**: SQLite `RunStore`/`EventStore`/`ArtifactStore` and filesystem `ArtifactService` with SHA-256 and windowed reading (PR #203, PR #231).

### Phase 2: Observability, Verification & Criteria (Milestone M5)
*Goal: Independent objective verification and full criteria enforcement.*
- **Criteria Hardening**: 7 criteria evaluators in the task loop (`CRIT-001`, PR #204; `CRIT-002`).
- **Physical Reconciliation**: Diff reconciliation for untracked and binary files (`VERIFY-001`, PR #206).
- **Verification Runner & Adversarial Audit**: Child-process test/build runner (`VERIFY-002`) and adversarial verifier (`VERIFY-003`, PR #208).

### Phase 3: Modular DAG Workflows & Interactive Steering (Milestones M6 – M7)
*Goal: Evolve from sequential stage pipelines to flexible DAG execution with mid-flight human intervention.*
- **M6 Generic Graph Engine**: `GraphExecutor`, branch worktrees, fan-in merging, stage controls (`WORK-001..006E`, PRs #214–#230).
- **M7 Human Control Plane**: Real blocking human approval gate (`HUMAN-001`), live PTY steering (`HUMAN-002`), xterm process attachment (`HUMAN-004`), and ADR-005 task boundary (`HUMAN-005`).

### Phase 4: Provider Ecosystem, Warm Sessions & Real CLI Hosting (Milestones M8 – M11)
*Goal: Broad provider compatibility, fast session resumption, and ConPTY-hosted external agent CLIs.*
- **M8 Extensible Providers**: Data-driven custom CLI adapters (`RUNTIME-001`), hosted Antigravity ConPTY sessions (`RUNTIME-002`), quota detection (`RUNTIME-003`).
- **M9 Warm Sessions**: Resumable `IAgentRuntime` sessions (`WARM-001`), `--resume` / `--conversation` adapter support (`WARM-002`), latency benchmark (`WARM-003`).
- **M10 Interactive Control**: Real approval gating (#163), stage rerun/skip (#164), mid-run interjections (#161, #171).
- **M11 Host the Real CLI**: Bidirectional ConPTY session hosting (#167, #168), direct terminal attachment (#170), decommission of legacy stdout scrapers (#172).

### Phase 5: Autonomous Hardening, Empirical Benchmarking & Parallel Isolation (Milestones M12 – M14)
*Goal: Harden multi-agent reliability, verify performance empirically, and enforce parallel workspace isolation.*
- **M12 Autonomous Control Plane**: Streaming chunk pipelines, speculative branch pruning, reverse patch verification, SQLite WAL mmap/optimizer tooling, capability killswitches, and `CLI-004` TUI (closed on GitHub; PRs through #477).
- **M13 Empirical Benchmarking**: Reproducible multi-agent benchmark harness (`BENCH-001`, PR #478), latency profiler (`BENCH-002`, PR #479), concurrency endurance stress suite (`BENCH-003`, PR #480).
- **M14 Workspace Isolation & Concurrency**: Policy-governed concurrency limiter (`PAR-001`, PR #481), multi-agent worktree isolation (`PAR-002`, PR #482), subagent capability quarantine (`AGENT-033`, PR #483), multi-repo workspace orchestration (`POLISH-001`, PR #484).

### Phase 6: Declarative DSL, Visual Authoring, Replication & Monorepo Architecture (Milestones M15 – M16)
*Goal: Decouple package boundaries cleanly and complete declarative/visual authoring and state replication.*
- **M15 DSL, Canvas & Cloud Sync**: YAML Workflow DSL parser (`COMP-001`, PR #485), parameterized sub-workflow compiler (`COMP-002`, PR #486), drag-and-drop visual workflow canvas (`UI-001`, PR #487), cloud replication backplane (`POLISH-002`, PR #488).
- **M16 Modular Monorepo Refactoring**: Full migration out of legacy `src/` into `@forge/shared`, `@forge/core`, `@forge/runtimes`, `@forge/cli`, and `@forge/desktop` under [ADR-008](../decisions/ADR-008-modular-monorepo-workspace-architecture.md) (PRs #456–#467).
