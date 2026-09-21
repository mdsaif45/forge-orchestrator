# Project Status & Ground Truth

This directory contains the authoritative, evidence-based records of Forge's current implementation state, milestone progress, and verification baselines.

---

## The Boundary: Progress vs. Architecture

> **Project progress is implementation truth, but cannot override accepted architecture or frozen contracts.**

Documentation in this directory reflects the **physical reality** of the repository: what is merged into `main`, what is covered by passing automated tests, and what has been empirically verified on developer machines.

---

## Documents Inventory

| Document | Purpose | Authority |
| :--- | :--- | :--- |
| [**`current-state.md`**](current-state.md) | The canonical "where are we now?" table mapping desired capabilities to physical implementation and test evidence. | **Physical Truth** |
| [**`progress.md`**](progress.md) | Progress line, milestone status tracking, and chronological slice history. | Physical Truth |
| [**`verification-baseline.md`**](verification-baseline.md) | Authoritative metrics: test counts, commit hashes, CI gates, and toolchain checks. | Physical Truth |
| [**`implementation-log.md`**](implementation-log.md) | Immutable ledger of merged PRs, architectural commits, and closed issues. | Physical Truth |
