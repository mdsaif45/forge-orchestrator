# Program Dependency Map

**Status:** IMPLEMENTED  
**Authority:** Planning Truth  
**Last Updated:** 2026-11-26  
**Baseline:** `main` @ `cfb0f4c` (PR #488 merged)  
**Related Milestones:** [milestones.md](milestones.md)  

---

## 1. Topological Milestone Dependencies

```mermaid
graph TD
    M0["M0: Quality Gates & CI"] --> M1["M1: Headless Forge Core"]
    M1 --> M2["M2: Native Agent Core"]
    M2 --> M3["M3: Forge CLI 1.0"]
    M1 --> M4["M4: State & Storage (SQLite)"]
    M1 --> M5["M5: Verification & Criteria"]
    M4 --> M5
    M3 --> M5
    M1 --> M6["M6: Generic Workflow Graph"]
    M6 --> M7["M7: Human Control Plane"]
    M7 --> M8["M8: Extensible Provider Ecosystem"]
    M8 --> M9["M9: Warm Sessions & Speed"]
    M7 --> M10["M10: Interactive Control"]
    M10 --> M11["M11: Host the Real CLI"]
    M11 --> M12["M12: Autonomous Hardening"]
    M12 --> M13["M13: Empirical Benchmarking"]
    M13 --> M14["M14: Workspace Isolation & Concurrency"]
    M12 --> M16["M16: Modular Monorepo (ADR-008)"]
    M14 --> M15["M15: Workflow DSL, Canvas & Cloud Sync"]
    M16 --> M15

    style M0 fill:#e8f5e9,stroke:#388e3c
    style M1 fill:#e8f5e9,stroke:#388e3c
    style M2 fill:#e8f5e9,stroke:#388e3c
    style M3 fill:#e8f5e9,stroke:#388e3c
    style M4 fill:#e8f5e9,stroke:#388e3c
    style M5 fill:#e8f5e9,stroke:#388e3c
    style M6 fill:#e8f5e9,stroke:#388e3c
    style M7 fill:#e8f5e9,stroke:#388e3c
    style M8 fill:#e8f5e9,stroke:#388e3c
    style M9 fill:#e8f5e9,stroke:#388e3c
    style M10 fill:#e8f5e9,stroke:#388e3c
    style M11 fill:#e8f5e9,stroke:#388e3c
    style M12 fill:#e8f5e9,stroke:#388e3c
    style M13 fill:#e8f5e9,stroke:#388e3c
    style M14 fill:#e8f5e9,stroke:#388e3c
    style M15 fill:#e8f5e9,stroke:#388e3c
    style M16 fill:#e8f5e9,stroke:#388e3c
```

---

## 2. Key Blocking Paths

1. **Headless Decoupling (M1) Was the Universal Blocker**:
   - Decoupling `createForgeCore` from Electron (PR #198) enabled both the standalone CLI (`packages/forge-cli`) and automated headless CI testing across M2, M3, M4, and M6.
2. **Dual-Tier State (M4) Enabled Advanced Verification (M5)**:
   - SQLite `RunStore` and filesystem `ArtifactService` (PR #203) enabled independent verification (`CRIT-001`, `ARTIFACT-001`, `VERIFY-003`).
3. **Graph Engine (M6) Preceded Interactive Control & Real CLI Hosting (M7–M11)**:
   - Stage-level controls (`WORK-002`), blocking approval gates (`HUMAN-001`), and bidirectional ConPTY terminal sessions enabled real CLI orchestration without fragile stdout scraping.
4. **Monorepo Package Extraction (M16) Enforced Zero-Cycle Boundaries**:
   - Eliminating circular dependencies (`npm run check:cycles`) unlocked clean package separation into `@forge/shared`, `@forge/core`, `@forge/runtimes`, `@forge/cli`, and `@forge/desktop` prior to M13–M15 completion.
