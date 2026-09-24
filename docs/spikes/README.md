# Validation Spikes

This directory contains timeboxed, exploratory spikes executed to validate technical assumptions against real hardware and software before committing to architectural decisions.

---

## Spikes Inventory

| Spike | Question / Hypothesis | Date | Outcome | Related ADR |
| :--- | :--- | :--- | :--- | :--- |
| [**Agent CLI Capability**](agent-cli-capability.md) | Can agent CLIs (Claude, Antigravity) be driven headlessly on Pro plans? | 2026-08-19 | **Mixed**: Claude Code supports headless `-p`; Antigravity requires GUI/PTY. Spawning two headless CLIs for MVP is not viable. | [ADR-001](../decisions/ADR-001-agents-runtimes-accounts.md) |
| [**Interactive CLI PTY**](interactive-cli-pty.md) | Why does an interactive prompt typed into a hosted TUI fail to complete? | 2026-08-31 | **GO**: Terminal trust dialog in fresh worktrees blocked input; pre-recording trust unblocks prompt loop. | [ADR-003](../decisions/ADR-003-host-the-real-cli.md) |

---

## Spike Methodology

1. **Timeboxed**: A spike runs for a fixed window (typically 1–4 hours) to answer a specific unknown.
2. **Empirical**: Must run real commands on actual developer machines, recording outputs verbatim.
3. **Decisive Outcome**: Concludes in a definitive **GO**, **NO-GO**, or **PIVOT** verdict that feeds directly into an ADR.
