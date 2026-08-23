# MVP Acceptance Report: Multi-Agent Closed Loop (#43)

> **Hypothesis Proven**: A multi-agent software engineering workflow can plan, implement, self-verify, and review changes on a real git repository with **zero manual copy-paste** from the user.

---

## 1. System Architecture & Flow

```
                                  [ User Goal ]
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           1. DISCOVERY & PLANNING                             │
│  • Agent 'planner' receives strict read-only scope (Axiom A1 & A2)            │
│  • Disk modifications strictly halted by Orchestrator (Permission Violation)  │
│  • Emits structured plan packet and architectural proposals                  │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           2. DECISION LOCK GATE                               │
│  • User locks architectural decisions via SQLite Event Log (Axiom A4)         │
│  • Transition to implementation mode enforces >= 1 locked decision            │
│  • Emits 'workflow.mode_transition' audit event                              │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           3. IMPLEMENTATION PHASE                             │
│  • Agent 'implementer' authorized to modify allowed paths                     │
│  • Checkpoint written to SQLite before side effects (Crash Resilient)        │
│  • Changes isolated to worktree, diff measured against base SHA               │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           4. CRITERIA SELF-VERIFICATION                       │
│  • Forge executes real build & test commands (Axiom A3: Evidence, not claims) │
│  • Test outputs parsed into structured TestCounts                             │
│  • Fails cleanly back to CORRECTION_REQUIRED if tests/build break             │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           5. INDEPENDENT CODE REVIEW                          │
│  • Agent 'reviewer' audits unified git diff + real test evidence (Axiom A5)   │
│  • Review findings compiled into ChangeSetStore                               │
│  • PASS ──> DONE                                                              │
│  • FAIL ──> CORRECTION_REQUIRED (with feedback packet)                        │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           6. HUMAN REVIEW & FINISH                            │
│  • User inspects final changeset via Changes Review UI (/changes)             │
│  • Unified diff viewer with read-only default and user edit mode              │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Axioms Verification Matrix

| Axiom | Description | Enforcement Mechanism | Verified Status |
|---|---|---|---|
| **A1** | Conversation is not truth | Context packets compiled from DB state & git; transcripts never used as truth | **VERIFIED** |
| **A2** | Agents only touch worktree | Path containment checks; read-only roles blocked from disk modification | **VERIFIED** |
| **A3** | Verification is evidence-based | Forge executes real build/test commands; agent self-reports never trusted | **VERIFIED** |
| **A4** | Decisions are binding | Only users may lock decisions; decision lock required before implementation | **VERIFIED** |
| **A5** | Code reviews require diff + evidence | Reviewers receive git patch + parsed test counts, not just agent prose | **VERIFIED** |
| **A6** | Crash resilience via events | SQLite WAL event log records checkpoints before side effects | **VERIFIED** |
| **A7** | Zero copy-paste handoff | Orchestrator routes structured packets across roles automatically | **VERIFIED** |

---

## 3. Acceptance Test Results

- **Test Suite**: `src/main/acceptance/mvpAcceptance.test.ts`
- **Total Test Suite**: 45 test files, 685 tests passing across all packages.
- **Coverage**:
  - Full closed loop: `DISCOVERY` ➔ `PLANNING` ➔ `AWAITING_APPROVAL` ➔ `DECISIONS_LOCKED` ➔ `IMPLEMENTING` ➔ `VERIFYING` ➔ `REVIEWING` ➔ `DONE`.
  - Pause on genuine open questions & resume upon user response.
  - Crash recovery & checkpoint resume planning.
  - Disk modification breach detection in discussion mode.
  - Scope policy violation halting.

---

## 4. MVP Limits & Documented Gaps (Deferred to Milestone M6)

1. **Multi-Account CLI Registry (#44)**:
   - Dynamic credentials rotation across accounts for rate limit prevention.
2. **Custom Workflow Templates as Data (#45)**:
   - Dynamic schema-driven definitions for bugfix, refactor, and security templates.
3. **Packaging & Release Pipeline (#47)**:
   - Electron forge distribution installers for macOS/Linux/Windows.
4. **Audit Timeline PDF/Markdown Export (#48)**:
   - One-click export of complete workflow execution history and decision log.
