# Product Vision: The AI Engineering Control Plane

**Status:** ACCEPTED  
**Authority:** Canonical Product Vision  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Decisions:** [ADR-001](../decisions/ADR-001-agents-runtimes-accounts.md), [ADR-002](../decisions/ADR-002-interactive-orchestration.md)  
**Related Architecture:** [architecture-overview.md](../architecture/architecture-overview.md)  

---

## 1. The Core Problem

Today's software engineering with AI agents suffers from a fundamental structural defect: **the developer is the transport layer**.

When an engineer uses multiple specialized coding agents (for example, planning with one model, writing code with a CLI agent, and running reviews with another), the interaction requires manual, error-prone human intervention at every boundary:

```
YOU ──> plan with Agent A ──> copy prompt ──> Agent B implements
 ▲                                                    │
 └──── copy response ──── review with Agent A ────────┘
                    repeat until it is right
```

### The Failure Modes of the Manual Loop
1. **Context Loss at Boundaries**: Copy-pasting prompts strips conversation history, working directory metadata, and subtle environmental constraints.
2. **Fabricated Progress**: Agents frequently hallucinate completion, claiming "tests pass" or "all requirements implemented" when test files were not executed or git diffs were empty.
3. **Loss of Velocity**: Switching windows, formatting diffs, and manually feeding terminal outputs into chat windows introduces massive cognitive friction and latency.
4. **Drifting State**: The agent's chat transcript is ephemeral. It cannot be queried, rolled back, audited, or reliably resumed after a process crash.

---

## 2. What Forge Is

Forge is an **AI engineering control plane** where multiple coding agents collaborate on a software project under a shared, enforceable execution protocol.

```
                        ┌──────────────┐
                        │     YOU      │
                        │  decisions   │
                        └──────┬───────┘
                               │  goals · approvals · answers
                        ┌──────▼───────┐
                        │    FORGE     │  ← owns the truth
                        │ orchestrator │
                        └──────┬───────┘
               ┌────────────────┼────────────────┐
          ┌────▼────┐      ┌────▼────┐      ┌────▼────┐
          │ PLANNER │      │IMPLEMENTER│    │REVIEWER │
          └────┬────┘      └────┬────┘      └────┬────┘
               └────────────────┼────────────────┘
                        ┌──────▼───────┐
                        │ PROJECT STATE│
                        │ git · files  │
                        │ tests · log  │
                        └──────────────┘
```

Forge decouples **execution** from **state**:
- **Forge owns the state**: Git repositories, worktrees, SQLite event logs, structured artifacts, and physical diffs.
- **Agents are workers**: Ephemeral, replaceable runtime processes bound to specific roles (Planner, Implementer, Reviewer).
- **The Developer owns decisions**: Architectural direction, high-level approvals, and answers to ambiguous blockers.

---

## 3. The Core Thesis

> **The user stays in the loop. They just stop being the transport.**

Automating engineering judgment is an anti-pattern. High-leverage developers do not want an opaque black box that makes unchecked architectural decisions in the dark. 

What developers need is an orchestration engine that eliminates the mechanical friction of multi-agent development:
- Automate context assembly and packet compilation.
- Automate worktree isolation and branch management.
- Automate verification against real compilers, linters, and test suites.
- Provide live, interactive terminal steering so the human can intervene mid-flight without killing the session.

---

## 4. Product Pillars

1. **Evidence Over Claims**: An agent claiming success has zero normative weight. Forge runs the compiler, runs the tests, diffs the git worktree, and computes objective completion criteria.
2. **Local-First & Sovereign**: Runs on your local machine. No external cloud backend or proprietary SaaS database is required. State lives in `.forge/` and local SQLite databases.
3. **Provider-Agnostic Engine**: Core execution does not know about Anthropic, OpenAI, or Google. Agents interact via the unified `IAgentRuntime` contract, supporting native agents, headless CLIs, and interactive PTY sessions.
4. **Resilient & Replayable**: Every state transition, agent packet, tool invocation, and verification verdict is appended to a durable, immutable event log. Any workflow can be inspected, resumed, or audited.
