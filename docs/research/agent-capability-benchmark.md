# Research: Comparative Agent Capability Benchmark

**Status:** DRAFT
**Authority:** Informative only — research, not a decision
**Date:** 2026-09-11 → 2026-09-21
**Decision status:** NOT A DECISION. Nothing in this document is binding on Forge's architecture.
**Related Decisions:** none
**Related Roadmap:** none

---

## Question

Where does Forge stand, as an *autonomous software-engineering agent architecture*,
against the strongest publicly available coding-agent systems — Claude Code, Cline,
Kilo Code and OpenCode?

The question deliberately excludes feature counts. The intended comparison was: given
the same model, the same repository and the same task, which system produces the
strongest autonomous engineer?

---

## Scope

- **Medium:** an extended external LLM chat session (22 turns), exported as
  `ChatGPT-Forge! Agent-20260922-0117.md`.
- **Subjects:** Forge, Claude Code, Cline, Kilo Code, OpenCode (the set grew during the
  session).
- **Evaluation dimensions drafted:** agent loop architecture, planning, repository
  understanding, tool-use intelligence, context management, self-correction, error
  recovery, verification, autonomy, long-horizon capability, multi-agent intelligence,
  adaptability, failure modes, maturity staging.

---

## Sources

| Source | Nature |
| :--- | :--- |
| Exported chat transcript (18,044 lines, 22 turns) | Primary record; not committed to this repository |
| Public `mdsaif45/forge-orchestrator` README at time of session | Read by the external model |
| Public repositories of the comparison systems | Read by the external model |

The transcript is not in version control. This summary is the citable record.

---

## Findings

### F1 — The benchmark was never executed against Forge

The elaborate scorecards drafted in the session are **templates with empty cells**, not
results. No dimension was scored from measured behaviour.

### F2 — Earlier numeric scores were predictions presented as measurements

An earlier iteration produced a scorecard placing Forge at `85.8/100`, ahead of Kilo
Code, Claude Code, OpenCode and Cline, plus "Forge Current = 82.5" and "Forge Future =
97.5". The session itself later retracts these, noting the source document labelled
them *"Simulated Benchmark Execution & Predicted Scoring"*.

**These numbers must not be cited anywhere as evidence of Forge's capability.** They
are exactly the substitution of a claim for a measurement that Axiom A3 exists to
prevent.

### F3 — Stale public documentation caused a materially wrong external assessment

The external review read the public README's claim that Forge was *"Pre-alpha, in M0"*
with *"No agent orchestration exists yet — that begins at M2"*, and concluded that
capabilities which **do** exist on `main` — `src/main/runtimes/orchestrator.ts`,
physical git-diff reconciliation, SHA-256 artifact storage — were unimplemented.

This is the most valuable finding in the session, and it is not about competitors: a
stale front-door document caused a third party to assess the project as substantially
less capable than it is. It is the same contradiction recorded as **C-01** in the
[forensic audit report](../meta/forensic-audit-report.md).

### F4 — Documentation architecture comparison against Noto

The closing turns compared Forge's documentation to the Noto repository's and found
Noto's healthier despite Forge having more total text: Noto separates product intent,
research, architecture, decisions, roadmap, progress and implementation into documents
with clear roles, whereas Forge's information existed but its *authority and lifecycle
were not obvious*.

Specific patterns identified as worth adopting:

- contracts that declare themselves `FROZEN`, record a baseline, list amendments, and
  distinguish `SPECIFIED` / `DERIVED` / `APPROVED`;
- an architecture overview with a fixed spine ending in **open questions**, rather than
  one large document accreting history;
- formal ADRs instead of architectural choices buried in planning documents;
- a progress document holding living implementation truth, separate from roadmap and
  architecture.

The session explicitly advised **not** copying Noto's filenames, because Forge has
different needs — architecture invariants, execution model, agent/runtime boundaries,
evidence and verification.

---

## Alternatives considered

The session weighed feature-count comparison (rejected as uninformative) against
architecture-level comparison (adopted as the intent, though never executed).

---

## Implications for Forge

These are implications, not decisions.

1. **F3 is actionable now and was acted on.** The README/north-star contradiction is
   documented as C-01 and the front-door claim corrected in this restructure.
2. **F4 informed this documentation restructure's shape** — the product / architecture
   / decisions / research / roadmap / project separation, and the status vocabulary. It
   informed the structure; it did not decide any Forge architecture.
3. **F1 and F2 mean Forge currently has no defensible competitive capability
   assessment.** Any future claim about Forge's standing against other agents needs a
   real, reproducible benchmark.

---

## Decision status

**NOT A DECISION.**

No ADR references this document. No architecture, contract or roadmap item derives from
it. Should a real benchmark be run, it belongs in a new dated research document, and any
resulting architectural change requires its own ADR.

---

## Open questions

- **Q-BM-01:** Should Forge invest in an executable, reproducible agent benchmark? The
  cost of doing it credibly is high and no roadmap item exists for it.
- **Q-BM-02:** The capability dimensions drafted here are a reasonable skeleton for such
  a benchmark, but they have never been validated against a real run.
