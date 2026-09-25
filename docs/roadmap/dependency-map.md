# Program Dependency Map

**Status:** PROPOSED  
**Authority:** Planning Truth  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `5987501` (PR #204 merged)  
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
    M6 --> M7["M7: Human Control & Interactive Sessions"]
    M7 --> M8["M8: Extensible Provider Ecosystem"]
    M8 --> M9["M9: Polish & Packaging"]

    style M0 fill:#e1f5fe,stroke:#0288d1
    style M1 fill:#e8f5e9,stroke:#388e3c
    style M2 fill:#e8f5e9,stroke:#388e3c
    style M3 fill:#e8f5e9,stroke:#388e3c
    style M4 fill:#e8f5e9,stroke:#388e3c
    style M5 fill:#fff3e0,stroke:#f57c00
    style M6 fill:#fce4ec,stroke:#c2185b
    style M7 fill:#fce4ec,stroke:#c2185b
    style M8 fill:#f3e5f5,stroke:#7b1fa2
    style M9 fill:#ede7f6,stroke:#512da8
```

---

## 2. Key Blocking Paths

1. **Headless Decoupling (M1) Was the Universal Blocker**:
   - Until `createForgeCore` was decoupled from Electron (PR #198), neither the standalone CLI (`bin/forge.ts`) nor automated headless CI testing could exist. M1 unblocked M2, M3, M4, and M6.
2. **Dual-Tier State (M4) Unblocks Advanced Verification (M5)**:
   - To store criteria test logs, raw compilation outputs, and unified diffs without memory pressure, `ArtifactService` and SQLite `RunStore` were required (PR #203). This unblocked `CRIT-001` and `ARTIFACT-001` (PR #204).
3. **Graph Engine (M6) Precedes Advanced Human Steering (M7)**:
   - Dynamic stage pause, resume, and branch-level steering require a graph execution kernel (`WORK-001`) to support arbitrary execution nodes rather than a fixed sequential pipeline.
