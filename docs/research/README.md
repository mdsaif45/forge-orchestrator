# Research & Empirical Field Studies

This directory contains empirical research, vendor capability measurements, and platform investigations conducted for Forge.

---

## The Boundary: Research vs. Decision

To prevent speculative architecture and drift, Forge enforces a strict epistemological boundary:

```
RESEARCH (docs/research/, docs/spikes/)
  = Evidence and information gathering.
  = Empirical measurements, vendor probes, benchmarks, traps discovered.
  = INFORMATIVE. Has zero normative authority.

DECISION (docs/decisions/, docs/architecture/)
  = Formally accepted architectural choices.
  = Binding on interfaces, database schemas, and implementation.
  = NORMATIVE. Enforced by tests and compiler types.
```

**Rule 6 of Documentation Policy:** *Research must never silently become architecture.* A finding in a research document only becomes system design when an Architectural Decision Record (ADR) or contract explicitly adopts it.

---

## Research Inventory

| Document | Scope / Subject | Date | Primary Finding |
| :--- | :--- | :--- | :--- |
| [**CLI Field Guide**](cli-field-guide.md) | Empirical measurements of Claude Code, Antigravity, OpenCode, ConPTY, and Windows terminal shims. | 2026-08-31 | Direct executable spawning required; trust dialogs block fresh worktrees; raw PTY streams required for responsive terminal panes. |

---

## Research Document Standard

When adding research documents to this directory, include:
- **Question**: The specific technical unknown being investigated.
- **Scope & Environment**: Operating system, Node version, tool versions, date.
- **Empirical Findings**: Concrete terminal outputs, measured latencies, and error codes.
- **Implications**: What this means for Forge architecture.
- **Related ADR / Spikes**: Traceability to architectural choices.
