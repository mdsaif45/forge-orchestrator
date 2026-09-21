# Architecture Decision Records (ADRs)

This directory records the formal, durable record of **why** Forge is designed and built the way it is.

Because Forge is an engineering platform developed with heavy AI assistance, the characteristic hazard is **architectural drift**: code runs, tests pass, but nobody can explain why a subsystem is shaped the way it is. When that happens, modifying the architecture becomes an exercise in archaeological guesswork.

These records serve as the defense against architectural drift.

---

## Index of Decisions

| ADR | Title | Status | Date | Target / Scope |
| :--- | :--- | :--- | :--- | :--- |
| [**ADR-001**](ADR-001-agents-runtimes-accounts.md) | Agents, runtimes, and the end of account isolation | **IMPLEMENTED** | 2026-08-31 | Separates accounts from runtime execution; models CLI vs API provider kinds. |
| [**ADR-002**](ADR-002-interactive-orchestration.md) | Interactive orchestration vs headless stdout parsing | **IMPLEMENTED** | 2026-08-31 | Inverts the architecture from headless scraping to live interactive steering. |
| [**ADR-003**](ADR-003-host-the-real-cli.md) | Host the real CLI instead of parsing a headless one | **IMPLEMENTED** | 2026-09-01 | Embeds ConPTY/tmux pseudo-terminals and xterm.js panes directly in the UI. |

---

## Status Definitions

| Status | Meaning |
| :--- | :--- |
| **`PROPOSED`** | Under active design and discussion. Has no binding authority on current code. |
| **`ACCEPTED`** | Decided, approved, and binding. Serves as the normative requirement for upcoming implementation. |
| **`IMPLEMENTED`** | The decision is both accepted and fully realized in the codebase, with automated test verification on `main`. |
| **`SUPERSEDED`** | Replaced by a subsequent ADR. Must explicitly link to the superseding record. |
| **`DEPRECATED`** | The architectural choice is marked for removal or phase-out. |

---

## When is an ADR Required?

An ADR must be created whenever a change:
1. Introduces, removes, or alters a core domain entity or transition rule.
2. Inverts a data flow or changes process boundaries (e.g. headless parsing vs PTY hosting).
3. Adds or removes an external runtime execution protocol.
4. Changes persistence technology or schema isolation boundaries.
5. Involves trade-offs where multiple viable architectural alternatives were rejected.

Trivial refactors, bug fixes, or adding unit tests do not require an ADR.

---

## How Implementation References ADRs

1. Code implementing an ADR should link to it in its module-level docstring (e.g. `// Architecture decision: docs/decisions/ADR-003-host-the-real-cli.md`).
2. Pull requests implementing the decision must reference the ADR in their summary.
3. Once the code is merged and verified in `main`, the ADR status should be updated from `ACCEPTED` to `IMPLEMENTED`.
