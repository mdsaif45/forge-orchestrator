# FORGE — MASTER PROJECT TRACKER (TODO)

This document is the single canonical cross-phase project tracking map for Forge. Every implementation task maps to a Milestone and a GitHub Issue.

Status Legend:
- `DONE` : Completed, verified with tests and physical evidence
- `IN-PROGRESS` : Actively under development
- `READY` : Fully specified, dependencies met, ready for implementation
- `BLOCKED` : Waiting on upstream dependency
- `DEFERRED` : Scheduled for later milestone

---

## M0: Baseline & Program Setup

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| M0-001 | — | docs | P0 | DONE | — | Forensic audit & 678 tests recorded | `FORGE-MASTER-ENGINEERING-PROGRAM.md` |
| M0-002 | #178 | testing | P1 | READY | — | Fix intermittent Windows git EBUSY test failures | `git.test.ts` passing in parallel |
| M0-003 | #64 | runtime | P3 | READY | — | Formally close obsolete spike #64 with evidence | ADR-001 / ADR-003 evidence |

---

## M1: Headless Forge Core (Electron Decoupling)

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| CORE-001 | NEW | engine | P0 | READY | M0-001 | Decouple domain/orchestrator from Electron | Vitest run in headless Node CLI |
| CORE-002 | NEW | state | P0 | READY | CORE-001 | Support arbitrary SQLite `--data-dir` path | SQLite DB boots in test dir |
| CORE-003 | NEW | core | P1 | READY | CORE-001 | Headless configuration & environment loader | Reads `.forgerc` / env vars |

---

## M2: Native Forge Agent Core 1.0

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| AGENT-001| NEW | agent | P0 | BLOCKED | CORE-001 | Native Agent Core Loop & Execution Lifecycle | Bounded ReAct loop & tools |
| AGENT-002| NEW | agent | P1 | BLOCKED | AGENT-001 | Tool output disk spill (>50KB) to `.forge/cache` | Large diff does not blow context |
| AGENT-003| NEW | agent | P1 | BLOCKED | AGENT-001 | Eager concurrent tool execution via `Promise.all` | Wall-clock latency benchmark |
| AGENT-004| NEW | agent | P1 | BLOCKED | AGENT-001 | Local Ollama auto-discovery & capability check | Offline execution on Qwen 2.5 |

---

## M3: Forge CLI 1.0 (Headless & TUI)

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| CLI-001 | NEW | cli | P0 | BLOCKED | AGENT-001 | Build `bin/forge.ts` CLI entrypoint | `forge --version` / `forge run` |
| CLI-002 | NEW | cli | P1 | BLOCKED | CLI-001 | Headless NDJSON event streaming mode | Machine-readable CI output |
| CLI-003 | NEW | cli | P1 | BLOCKED | CLI-001 | Clean exit code contract (0=OK, 1=Fail, 2=Halt)| Exit codes verified in E2E tests |
| CLI-004 | NEW | cli | P2 | BLOCKED | CLI-001 | Interactive React Ink terminal TUI | Multi-pane status & diff stream |
| CLI-005 | #155 | cli/ui | P2 | BLOCKED | CLI-004 | Live tool-call timeline | Timeline rendering in terminal |

---

## M4: State, Events, Artifacts & Evidence System

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| STATE-001| NEW | state | P1 | BLOCKED | CORE-002 | Structured artifact directory store | `.forge/artifacts/<run-id>/` |
| ARTIFACT-1| NEW | state | P1 | BLOCKED | STATE-001 | Byte-offset artifact reader | Windowed preview of huge logs |
| EVIDENCE-1| NEW | evidence| P0 | BLOCKED | CORE-001 | Authoritative Evidence Model & Domain Contract | Creation, Persistence, Verification |
| IPC-001 | #153 | ipc | P2 | BLOCKED | CORE-001 | Push runtime events over typed IPC | Event streaming tests |
| EVENT-001| #149 | engine | P1 | BLOCKED | CORE-001 | Live agent channel event subscription | Event log audit trail |

---

## M5: Independent Verification & Ground-Truth Reconciliation

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| VERIFY-001| NEW | evidence| P0 | BLOCKED | EVIDENCE-1 | Physical diff reconciliation enhancements | Catches untracked/renamed files |
| VERIFY-002| NEW | evidence| P1 | BLOCKED | VERIFY-001 | Independent test & build execution runner | Exit code verified against claims |
| VERIFY-003| NEW | evidence| P2 | BLOCKED | VERIFY-001 | Adversarial edge-case verifier agent | Probes boundary regressions |

---

## M6: Generic Workflow Graph Engine

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| WORK-001 | NEW | workflow| P0 | BLOCKED | CORE-001 | DAG execution engine for Generic Workflow Graph | Arbitrary graph execution |
| WORK-002 | #164 | workflow| P1 | BLOCKED | WORK-001 | Stage run, skip, re-run controls | Interactive stage control |
| WORK-003 | NEW | workflow| P1 | BLOCKED | WORK-001 | Conditional branching and loop edges | Loop/Retry test suite |

---

## M7: Human Control & Interactive Sessions

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| HUMAN-001| #163 | engine | P0 | BLOCKED | WORK-001 | Real human approval gate (no auto-approve) | FSM pauses for human decision |
| HUMAN-002| #171 | runtime | P1 | BLOCKED | RUNTIME-1 | Send prompts & mid-run interjections to session | Steer running agent without abort |
| HUMAN-003| #160 | engine | P1 | BLOCKED | HUMAN-002 | Master interactive control epic | Interactive control test |
| HUMAN-004| #154 | ui | P1 | BLOCKED | HUMAN-002 | Bind terminal to real step process | UI terminal attachment |
| HUMAN-005| #117 | ui | P3 | READY | — | Tasks vs Workflow page decision | Product UI resolution |

---

## M8: Universal Agent Runtime & Registry

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| RUNTIME-1| #157 | runtime | P1 | BLOCKED | CORE-001 | Resumable sessions in `IAgentRuntime` | `resumeKey` across stages |
| RUNTIME-2| #156 | runtime | P2 | BLOCKED | RUNTIME-1 | Warm session reuse across workflow steps | Context preserved across steps |
| RUNTIME-3| #183 | runtime | P1 | BLOCKED | RUNTIME-1 | Runtime resolution truth (no silent fallback) | `runtime.substituted` audit event |
| RUNTIME-4| #174 | runtime | P1 | BLOCKED | RUNTIME-1 | Data-configured generic CLI runtime | Runtime configured via JSON |
| RUNTIME-5| #138 | runtime | P2 | BLOCKED | RUNTIME-1 | Agent persona identity & names | Persisted agent configurations |

---

## M9: External Agent Adapters

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| ADAPT-001| #165 | runtime | P1 | BLOCKED | RUNTIME-1 | Host real CLI interactively via PTY/hooks | Replaces stdout parsing |
| ADAPT-002| #172 | adapter | P3 | BLOCKED | ADAPT-001 | Delete obsolete stdout scraping code | Cleaner adapter codebase |
| ADAPT-003| #180 | adapter | P2 | BLOCKED | ADAPT-001 | Structured provider limit error handling | Halts with remedy on quota |
| ADAPT-004| #158 | adapter | P2 | BLOCKED | ADAPT-001 | CLI session resumption (`--resume`, `--conv`) | Resumed sessions in adapters |
| ADAPT-005| #168 | adapter | P2 | BLOCKED | ADAPT-001 | Launch Antigravity CLI interactively | Verified Antigravity adapter |
| ADAPT-006| #162 | adapter | P2 | BLOCKED | ADAPT-001 | Research Claude CLI mid-session input spike | Documented input mechanism |

---

## M10: Workspace Isolation & Policy-Governed Concurrency

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PAR-001  | NEW | engine | P1 | BLOCKED | WORK-001 | Policy-governed concurrency controller | CPU/Memory/Rate-limit budgets |
| PAR-002  | NEW | runtime | P1 | BLOCKED | PAR-001  | Workspace isolation manager (worktrees/temp) | Isolated workspace instances |
| PAR-003  | NEW | git | P1 | BLOCKED | PAR-002  | Merge & conflict reconciliation policy | Topological branch integration |

---

## M11: Workflow DSL, Templates & Optimization

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| COMP-001 | NEW | workflow| P2 | BLOCKED | WORK-001 | Human-editable YAML workflow format | `workflow.yaml` parser & validator |
| COMP-002 | NEW | workflow| P2 | BLOCKED | COMP-001 | Parameterized reusable sub-workflows | Embedded sub-workflow execution |
| AGENT-005| NEW | agent | P2 | BLOCKED | AGENT-001 | Provider prompt-cache optimization (Anthropic/OpenAI) | Static-prefix KV cache hit |

---

## M12: Empirical Benchmarking & Hardening

| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| BENCH-001| #159 | testing | P2 | BLOCKED | CLI-001 | Reproducible benchmark harness | Fixed repo snapshots & raw evidence |
| BENCH-002| NEW | testing | P1 | BLOCKED | BENCH-001| 20-task adversarial benchmark execution | Measured competitive scorecards |
