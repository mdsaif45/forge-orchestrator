### Core Concept: Forge

```text
                  YOU (Decisions & Intent)
                             │
                     Goals / Decisions
                             ▼
                 ┌───────────────────────┐
                 │         FORGE         │
                 │  AI Control Plane App │
                 │  (Electron + React)   │
                 └───────────┬───────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
    ┌───────────────┐                 ┌───────────────┐
    │    PLANNER    │                 │    BUILDER    │
    │ (Claude etc.) │◄── Orchestrate ─►│(Antigravity/ │
    │               │    Protocol     │ Codex/etc.)   │
    └───────┬───────┘                 └───────┬───────┘
            │                                 │
            └────────────────┬────────────────┘
                             ▼
                   ┌───────────────────┐
                   │   PROJECT STATE   │
                   │ Git / SQLite DB / │
                   │ Evidence / Diffs  │
                   └───────────────────┘
```

---

### Key Invariants (The Axioms)

```text
[A1] Truth Ownership   : Forge owns DB & state. Chat != state. Agents = workers.
[A2] Never Guess       : Unknown != assume. Probe repo -> probe history -> ask human.
[A3] Evidence > Claims : Agent says "done" -> Forge runs tests & git diff.
[A4] Decisions Lock    : Approved decisions locked. Agents cannot override without CR.
[A5] Bounded Loops     : Max iterations + circuit breakers. No infinite agent loops.
[A6] Provider Agnostic : IAgentRuntime port. Claude/Antigravity = pluggable adapters.
[A7] Least Privilege   : Scoped role permissions enforced by Forge.
```

---

### Execution Protocol & State Machine

```text
                  ┌───────────────┐
                  │   DISCOVERY   │
                  └───────┬───────┘
                          ▼
                  ┌───────────────┐
                  │   PLANNING    │
                  └───────┬───────┘
                          ▼
                  ┌───────────────┐
                  │  PLAN_READY   │
                  └───────┬───────┘
                          │ (User Approve)
                          ▼
                  ┌───────────────┐
                  │DECISIONS_LOCK │
                  └───────┬───────┘
                          ▼
                  ┌───────────────┐
                  │ IMPLEMENTING  │◄────────────────────┐
                  └───────┬───────┘                     │
                          ▼                             │
                  ┌───────────────┐                     │
                  │   VERIFYING   │ (Evidence / Diff)   │ (Retry Loop)
                  └───────┬───────┘                     │
                          ▼                             │
                  ┌───────────────┐                     │
                  │   REVIEWING   │                     │
                  └───────┬───────┘                     │
                     ┌────┴────┐                        │
                  PASS        FAIL                      │
                     │         └──> CORRECTION_REQ ─────┘
                     ▼
                  ┌─────┐
                  │DONE │
                  └─────┘

  [ANY STATE] ───(Agent Uncertainty)───> [QUESTION QUEUE / WAITING] ───(User Answer)───> [RESUME]
```

---

### Milestones & Phases

```text
Milestone          Status   Phase   Focus
─────────────────────────────────────────────────────────────────────────────
M0 Foundation      [DONE]   P1      Electron shell, IPC sandbox, CI, UI primitives
M1 State Core      [DONE]   P2      SQLite + Drizzle, Event log, Git service
M2 Runtime Adapter [BLOCKED]P3      IAgentRuntime, Claude CLI / Antigravity CLI
                                    ↳ (MockRuntime carries M3-M5 forward)
M3 Workflow Engine [ACTIVE] P4      State machine, checkpts, loop guards, UI graph (#32)
M4 Evidence/Review [ACTIVE] P5      Build/test runners, diff scope, review loop (#37)
M5 Human Control   [NEXT]   P6      Question queue, Decision lock, Changes/Diff UI
M6 Polish & Scale  [FUTURE] P7      Multi-account, templates, packaging
```

---

### GitHub Operating Rules

```text
[Issue] ──> [Branch: feat/<issue>-<slug>]
                │
                ▼
            [Code + Tests]
                │
                ▼
            [npm run check] (All 540+ tests, smoke, UI, E2E)
                │
                ▼
            [Push & PR]
                │
                ▼
            [CI Green]
                │
                ▼
            [Ask User: "Merge?"] ──── NO ───> [Hold / Iterate]
                │
               YES
                ▼
      [Squash & Merge to main]
```

---


### Plan Overview: Issue #37 Policy Engine

```text
                               Agent Binding
                                    │
                                    ▼
                         Role Permissions (A7)
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
   [Command Denylist]      [Path & Write Guard]     [Secret Exclusion]
   (rm -rf, reset, force)  (planner/reviewer lock)  (.env, keys, tokens)
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    │
                            Violation Detected?
                              ┌─────┴─────┐
                             YES          NO
                              │           │
                              ▼           ▼
                       [HALTED_POLICY]  [ALLOW]
```

---

# Implementation Plan: Open Questions & Probe-Before-Ask (Issue #38)

Implements **Axiom A2: unknown is not assume**. When an agent encounters ambiguity, it must inspect the repository first and attach evidence. If still ambiguous, it raises an open question, which pauses the workflow in `AWAITING_USER` until the human answers.

```
                    AGENT ENCOUNTERS AMBIGUITY
                               │
               ┌───────────────┴───────────────┐
         [ No Evidence ]                 [ Has Evidence ]
               │                               │
       Bounced / Retried              Question Created & Stored
      (Schema Violation)                       │
                                    Workflow: AWAITING_USER
                                    (records resumeState)
                                               │
                                         User Answers
                                               │
                                  Answer Persisted & Projected
                                  (Optional Decision Promotion)
                                               │
                                  Workflow Resumes Prior State
                                  Context Packet carries Answers
```

## User Review Required

> [!IMPORTANT]
> - `OpenQuestion` requires at least 1 `evidenceRef` (`min(1)`); questions lacking evidence will fail protocol validation and prompt a retry to the agent.
> - Answering a question transitions the workflow from `AWAITING_USER` back to its pre-pause state (`resumeState`).
> - Answers are injected into all future compiled prompt packets via `answeredQuestions`.

## Proposed Changes

### Domain & Database Layer
- Project `question.asked` and `question.answered` events into `open_questions` in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
- Add [questionStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.ts) / [questionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/questions/questionService.ts) to query and answer questions.

### Orchestrator & Workflow Execution
- In [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts):
  - Handle `assessment.verdict === 'await-user'`.
  - Append `question.asked` event and create `OpenQuestion`.
  - Pause workflow via `workflowStore.apply(workflowId, 'questionRaised', actor, now, { questionId })`.
  - Return/halt cleanly while awaiting user response.
- In [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts):
  - Add `answerQuestion(questionId, answer, promoteToDecision?)`.
  - Resume paused workflows via `workflowStore.apply(workflowId, 'questionAnswered', 'user', now)` and resume background execution.
  - Query answered questions and pass them into `compilePacket`.

### IPC Contract & Preload
- In [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts):
  - Define `openQuestionViewSchema`, `question:list`, `question:get`, `question:answer`.
- In [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts) and [preload/api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts):
  - Wire question query and answer IPC channels.

## Verification Plan

### Automated Tests
- Unit tests in `questionStore.test.ts` / `questionService.test.ts` verifying persistence, unanswered ordering, and projection replay.
- Orchestrator scenario test verifying `question` scenario pauses in `AWAITING_USER` and resumes upon answer.
- Rejection test verifying an agent report with empty evidence is rejected with protocol schema violation.
- Full verification gate: `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build && npm run check:router && npm run check:docs && npm run smoke && npm run check:ui && npm run test:e2e`.


---

# Walkthrough: Issue #38 - Open Questions & Workflow Pause/Resume

## Architecture & Data Flow

```
Agent Report (status='question', evidence >= 1)
                  │
                  ▼
          assessReport() == 'await-user'
                  │
                  ▼
         QuestionStore.ask() ──► event: 'question.asked'
                  │
                  ▼
         Workflow paused in AWAITING_USER
         blockedByQuestionId: <uuid>
         resumeState: <previous_state>
                  │
         (User inspects & answers)
                  │
                  ▼
         WorkflowService.answerQuestion()
                  │
                  ├─► QuestionStore.answer() ──► event: 'question.answered'
                  ├─► workflow.apply('questionAnswered') ──► event: 'workflow.transitioned'
                  ├─► Prompt packet compiler injects answered questions into subsequent turns
                  └─► Workflow execution resumes cleanly from resumeState
```

## Changes Implemented

1. **Schema & Domain**:
   - Added `blockedByQuestionId` to `workflowTransitioned` payload in [eventPayloads.ts](file:///d:/my-quests/side-projects/Forge/src/shared/domain/eventPayloads.ts).
   - Enforced Axiom A2 probe-first requirement: questions require at least 1 concrete evidence ref.

2. **Persistence & Projections**:
   - Projected `question.asked` and `question.answered` into SQLite `open_questions` table in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
   - Implemented [QuestionStore](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.ts) with full test coverage in [questionStore.test.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.test.ts).

3. **Orchestrator & Workflow Engine**:
   - Updated [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts) to emit `openQuestions` and record `questionId` on `questionRaised` transition.
   - Updated [workflowStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/workflowStore.ts) to record `blockedByQuestionId`.
   - Updated [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts) to compile answered questions into prompt packets and resume execution on `answerQuestion`.

4. **IPC & Preload APIs**:
   - Added `question:list`, `question:get`, `question:answer` channels in [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts).
   - Added `QuestionService` in [questionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/questions/questionService.ts) and handlers in [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts).
   - Exposed `window.forge.question` in [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts) and [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts).

## Verification Results

- **Unit tests**: 661/661 passed across 38 files.
- **Router check**: 7/7 passed.
- **Docs/Diagram check**: passed.
- **Smoke checks**: 8/8 passed.
- **UI checks**: 13/13 passed.
- **E2E tests**: 10/10 Playwright tests passed.
- **GitHub Actions CI (PR #80)**: All 3 jobs passed (`Format, lint, types, tests`, `App checks (Electron)`, `App checks (Windows)`).


---

Plan: Issue #32 Workflow UI
```
┌──────────────────────────────────────────────────────────────────┐
│ OAuth Scope Refactor                        ● IMPLEMENTING 2/5   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Plan ──✓──> Approve ──✓──> Implement ──●──> Verify ──○──> Review│
│  planner       user        implementer      system       reviewer│
│                                                                  │
├─────────────────────────────────────────────────┬────────────────┤
│ LIVE STREAMING LOG                              │ STEP INSPECTION│
│ [Autoscroll ✓] [Pause ⏸] [Search 🔍]   [Cancel] │ Role: implement│
│ ----------------------------------------------- │ Runtime: mock  │
│ [10:04:12] agent: Starting task exchange...     │ Files: 2       │
│ [10:04:13] chunk: Reading src/math.ts...        │ Tests: Passed  │
│ [10:04:15] report: Done with changes            │ [View Packet]  │
└─────────────────────────────────────────────────┴────────────────┘
```
Key Deliverables

1. Primitives     : WorkflowNode, WorkflowEdge in @renderer/ui
2. Live Log       : Streaming chunks, autoscroll lock, pause, text search
3. Step Inspector : Clickable graph nodes showing prompt packet, report, evidence
4. Lifecycle      : Start, Cancel, and Interruption Resume controls
5. IPC Push       : Event stream subscription across bridge (zero polling)

---

# Implementation Plan: Open Questions & Probe-Before-Ask (Issue #38)

Implements **Axiom A2: unknown is not assume**. When an agent encounters ambiguity, it must inspect the repository first and attach evidence. If still ambiguous, it raises an open question, which pauses the workflow in `AWAITING_USER` until the human answers.

```
                    AGENT ENCOUNTERS AMBIGUITY
                               │
               ┌───────────────┴───────────────┐
         [ No Evidence ]                 [ Has Evidence ]
               │                               │
       Bounced / Retried              Question Created & Stored
      (Schema Violation)                       │
                                    Workflow: AWAITING_USER
                                    (records resumeState)
                                               │
                                         User Answers
                                               │
                                  Answer Persisted & Projected
                                  (Optional Decision Promotion)
                                               │
                                  Workflow Resumes Prior State
                                  Context Packet carries Answers
```

## User Review Required

> [!IMPORTANT]
> - `OpenQuestion` requires at least 1 `evidenceRef` (`min(1)`); questions lacking evidence will fail protocol validation and prompt a retry to the agent.
> - Answering a question transitions the workflow from `AWAITING_USER` back to its pre-pause state (`resumeState`).
> - Answers are injected into all future compiled prompt packets via `answeredQuestions`.

## Proposed Changes

### Domain & Database Layer
- Project `question.asked` and `question.answered` events into `open_questions` in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
- Add [questionStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.ts) / [questionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/questions/questionService.ts) to query and answer questions.

### Orchestrator & Workflow Execution
- In [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts):
  - Handle `assessment.verdict === 'await-user'`.
  - Append `question.asked` event and create `OpenQuestion`.
  - Pause workflow via `workflowStore.apply(workflowId, 'questionRaised', actor, now, { questionId })`.
  - Return/halt cleanly while awaiting user response.
- In [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts):
  - Add `answerQuestion(questionId, answer, promoteToDecision?)`.
  - Resume paused workflows via `workflowStore.apply(workflowId, 'questionAnswered', 'user', now)` and resume background execution.
  - Query answered questions and pass them into `compilePacket`.

### IPC Contract & Preload
- In [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts):
  - Define `openQuestionViewSchema`, `question:list`, `question:get`, `question:answer`.
- In [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts) and [preload/api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts):
  - Wire question query and answer IPC channels.

## Verification Plan

### Automated Tests
- Unit tests in `questionStore.test.ts` / `questionService.test.ts` verifying persistence, unanswered ordering, and projection replay.
- Orchestrator scenario test verifying `question` scenario pauses in `AWAITING_USER` and resumes upon answer.
- Rejection test verifying an agent report with empty evidence is rejected with protocol schema violation.
- Full verification gate: `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build && npm run check:router && npm run check:docs && npm run smoke && npm run check:ui && npm run test:e2e`.

---

```
+-----------------------------------------------------------------------------------------------+
| ISSUE #32: WORKFLOW UI CONTROL PLANE                                                          |
+-----------------------------------------------------------------------------------------------+
|                                                                                               |
|  [ IPC SERVICE ] ──> [ WORKFLOW GRAPH ] ──> [ LIVE LOG STREAMER ] ──> [ STEP INSPECTOR ]       |
|   (main process)       (DAG state nodes)      (auto-scroll / pause)     (packet / verdict)    |
|                                                                                               |
|  CI GATES:                                                                                    |
|  - Format / Lint / Typecheck / Tests (656/656 unit) ──────> PASS [✓]                         |
|  - App checks (Electron + Router + Docs + Smoke + UI) ────> PASS [✓]                         |
|  - Playwright E2E (10/10 tests) ──────────────────────────> PASS [✓]                         |
|                                                                                               |
|  PULL REQUEST:                                                                                |
|  https://github.com/mdsaif45/forge-orchestrator/pull/79                                       |
+-----------------------------------------------------------------------------------------------+
```
# Walkthrough: Issue #38 - Open Questions & Workflow Pause/Resume

## Architecture & Data Flow

```
Agent Report (status='question', evidence >= 1)
                  │
                  ▼
          assessReport() == 'await-user'
                  │
                  ▼
         QuestionStore.ask() ──► event: 'question.asked'
                  │
                  ▼
         Workflow paused in AWAITING_USER
         blockedByQuestionId: <uuid>
         resumeState: <previous_state>
                  │
         (User inspects & answers)
                  │
                  ▼
         WorkflowService.answerQuestion()
                  │
                  ├─► QuestionStore.answer() ──► event: 'question.answered'
                  ├─► workflow.apply('questionAnswered') ──► event: 'workflow.transitioned'
                  ├─► Prompt packet compiler injects answered questions into subsequent turns
                  └─► Workflow execution resumes cleanly from resumeState
```

## Changes Implemented

1. **Schema & Domain**:
   - Added `blockedByQuestionId` to `workflowTransitioned` payload in [eventPayloads.ts](file:///d:/my-quests/side-projects/Forge/src/shared/domain/eventPayloads.ts).
   - Enforced Axiom A2 probe-first requirement: questions require at least 1 concrete evidence ref.

2. **Persistence & Projections**:
   - Projected `question.asked` and `question.answered` into SQLite `open_questions` table in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
   - Implemented [QuestionStore](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.ts) with full test coverage in [questionStore.test.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.test.ts).

3. **Orchestrator & Workflow Engine**:
   - Updated [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts) to emit `openQuestions` and record `questionId` on `questionRaised` transition.
   - Updated [workflowStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/workflowStore.ts) to record `blockedByQuestionId`.
   - Updated [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts) to compile answered questions into prompt packets and resume execution on `answerQuestion`.

4. **IPC & Preload APIs**:
   - Added `question:list`, `question:get`, `question:answer` channels in [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts).
   - Added `QuestionService` in [questionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/questions/questionService.ts) and handlers in [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts).
   - Exposed `window.forge.question` in [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts) and [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts).

## Verification Results

- **Unit tests**: 661/661 passed across 38 files.
- **Router check**: 7/7 passed.
- **Docs/Diagram check**: passed.
- **Smoke checks**: 8/8 passed.
- **UI checks**: 13/13 passed.
- **E2E tests**: 10/10 Playwright tests passed.
- **GitHub Actions CI (PR #80)**: All 3 jobs passed (`Format, lint, types, tests`, `App checks (Electron)`, `App checks (Windows)`).

---

```
+-----------------------------------------------------------------------------------------------+
| ISSUE #38: OPEN QUESTIONS, PROBE-BEFORE-ASK & RESUME (MILESTONE M5)                           |
+-----------------------------------------------------------------------------------------------+
|                                                                                               |
|  [ AGENT AMBIGUITY ]                                                                          |
|         │                                                                                     |
|         ├── [ NO EVIDENCE ] ────────> BOUNCE / RETRY (Schema Violation, R2 breach)            |
|         │                                                                                     |
|         └── [ HAS EVIDENCE ] ───────> OPEN QUESTION STORED (Event: question.asked)           |
|                                              │                                                |
|                                       WORKFLOW PAUSED                                         |
|                                     (state: AWAITING_USER)                                    |
|                                              │                                                |
|                                        USER ANSWERS                                           |
|                                              │                                                |
|                                      WORKFLOW RESUMES                                         |
|                                   (Context carries Answers)                                   |
|                                                                                               |
+-----------------------------------------------------------------------------------------------+
```
# Implementation Plan: Open Questions & Probe-Before-Ask (Issue #38)

Implements **Axiom A2: unknown is not assume**. When an agent encounters ambiguity, it must inspect the repository first and attach evidence. If still ambiguous, it raises an open question, which pauses the workflow in `AWAITING_USER` until the human answers.

```
                    AGENT ENCOUNTERS AMBIGUITY
                               │
               ┌───────────────┴───────────────┐
         [ No Evidence ]                 [ Has Evidence ]
               │                               │
       Bounced / Retried              Question Created & Stored
      (Schema Violation)                       │
                                    Workflow: AWAITING_USER
                                    (records resumeState)
                                               │
                                         User Answers
                                               │
                                  Answer Persisted & Projected
                                  (Optional Decision Promotion)
                                               │
                                  Workflow Resumes Prior State
                                  Context Packet carries Answers
```

## User Review Required

> [!IMPORTANT]
> - `OpenQuestion` requires at least 1 `evidenceRef` (`min(1)`); questions lacking evidence will fail protocol validation and prompt a retry to the agent.
> - Answering a question transitions the workflow from `AWAITING_USER` back to its pre-pause state (`resumeState`).
> - Answers are injected into all future compiled prompt packets via `answeredQuestions`.

## Proposed Changes

### Domain & Database Layer
- Project `question.asked` and `question.answered` events into `open_questions` in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
- Add [questionStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.ts) / [questionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/questions/questionService.ts) to query and answer questions.

### Orchestrator & Workflow Execution
- In [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts):
  - Handle `assessment.verdict === 'await-user'`.
  - Append `question.asked` event and create `OpenQuestion`.
  - Pause workflow via `workflowStore.apply(workflowId, 'questionRaised', actor, now, { questionId })`.
  - Return/halt cleanly while awaiting user response.
- In [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts):
  - Add `answerQuestion(questionId, answer, promoteToDecision?)`.
  - Resume paused workflows via `workflowStore.apply(workflowId, 'questionAnswered', 'user', now)` and resume background execution.
  - Query answered questions and pass them into `compilePacket`.

### IPC Contract & Preload
- In [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts):
  - Define `openQuestionViewSchema`, `question:list`, `question:get`, `question:answer`.
- In [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts) and [preload/api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts):
  - Wire question query and answer IPC channels.

## Verification Plan

### Automated Tests
- Unit tests in `questionStore.test.ts` / `questionService.test.ts` verifying persistence, unanswered ordering, and projection replay.
- Orchestrator scenario test verifying `question` scenario pauses in `AWAITING_USER` and resumes upon answer.
- Rejection test verifying an agent report with empty evidence is rejected with protocol schema violation.
- Full verification gate: `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build && npm run check:router && npm run check:docs && npm run smoke && npm run check:ui && npm run test:e2e`.

---

          [ AGENT REPORT: QUESTION (evidence >= 1) ]
                               │
                               ▼
    [ assessReport() == 'await-user' (Axiom A2) ]
                               │
                               ▼
        [ QuestionStore.ask() ──► question.asked ]
                               │
                               ▼
    [ Workflow Paused: AWAITING_USER (blockedByQuestionId) ]
                               │
                        (User answers)
                               │
                               ▼
       [ QuestionStore.answer() ──► question.answered ]
                               │
                               ├─► [ workflow.apply('questionAnswered') ]
                               ├─► [ Context compiler injects answer ]
                               └─► [ Workflow resumes from resumeState ]

# Walkthrough: Issue #38 - Open Questions & Workflow Pause/Resume

## Architecture & Data Flow

```
Agent Report (status='question', evidence >= 1)
                  │
                  ▼
          assessReport() == 'await-user'
                  │
                  ▼
         QuestionStore.ask() ──► event: 'question.asked'
                  │
                  ▼
         Workflow paused in AWAITING_USER
         blockedByQuestionId: <uuid>
         resumeState: <previous_state>
                  │
         (User inspects & answers)
                  │
                  ▼
         WorkflowService.answerQuestion()
                  │
                  ├─► QuestionStore.answer() ──► event: 'question.answered'
                  ├─► workflow.apply('questionAnswered') ──► event: 'workflow.transitioned'
                  ├─► Prompt packet compiler injects answered questions into subsequent turns
                  └─► Workflow execution resumes cleanly from resumeState
```

## Changes Implemented

1. **Schema & Domain**:
   - Added `blockedByQuestionId` to `workflowTransitioned` payload in [eventPayloads.ts](file:///d:/my-quests/side-projects/Forge/src/shared/domain/eventPayloads.ts).
   - Enforced Axiom A2 probe-first requirement: questions require at least 1 concrete evidence ref.

2. **Persistence & Projections**:
   - Projected `question.asked` and `question.answered` into SQLite `open_questions` table in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
   - Implemented [QuestionStore](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.ts) with full test coverage in [questionStore.test.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/questionStore.test.ts).

3. **Orchestrator & Workflow Engine**:
   - Updated [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts) to emit `openQuestions` and record `questionId` on `questionRaised` transition.
   - Updated [workflowStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/workflowStore.ts) to record `blockedByQuestionId`.
   - Updated [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts) to compile answered questions into prompt packets and resume execution on `answerQuestion`.

4. **IPC & Preload APIs**:
   - Added `question:list`, `question:get`, `question:answer` channels in [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts).
   - Added `QuestionService` in [questionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/questions/questionService.ts) and handlers in [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts).
   - Exposed `window.forge.question` in [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts) and [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts).

## Verification Results

- **Unit tests**: 661/661 passed across 38 files.
- **Router check**: 7/7 passed.
- **Docs/Diagram check**: passed.
- **Smoke checks**: 8/8 passed.
- **UI checks**: 13/13 passed.
- **E2E tests**: 10/10 Playwright tests passed.
- **GitHub Actions CI (PR #80)**: All 3 jobs passed (`Format, lint, types, tests`, `App checks (Electron)`, `App checks (Windows)`).

---

```
┌──────────────────────────────────────────────────────────┐
│ ● 2 questions require your decision                      │
├──────────────────────────────────────────────────────────┤
│ OAuth authorization behaviour            asked by planner │
│                                                          │
│ Why undetermined: existing APIs use both behaviours       │
│                                                          │
│ Evidence inspected                                       │
│   ✓ Services/AuthService.cs:212                          │
│   ✓ Controllers/TenantController.cs:88                   │
│   ✓ appsettings.json                                     │
│   ✓ Tests/AuthServiceTests.cs                            │
│                                                          │
│ ○ 404   ○ 403   ○ other …          recommendation: 403   │
│                                                          │
│ [ Answer ]  [ Answer + lock as decision ]  [ View step ] │
├──────────────────────────────────────────────────────────┤
│ Database migration strategy         asked by implementer │
└──────────────────────────────────────────────────────────┘
```

# Implementation Plan - Issue #39: Question Queue UI with evidence trails and one-click answers

Provide an interactive, centralized Question Queue UI where users can inspect agent questions, review required evidence trails, select or type answers, promote answers to decisions, and resume paused workflows in real time.

## User Review Required

> [!NOTE]
> All Question Queue functionality is built with existing `ui/` primitives and design tokens (`Card`, `Badge`, `Button`, `Input`, `Code`, `ScrollArea`, `StatusDot`, `Tabs`).
> Answering questions triggers immediate resumption of the associated paused workflow.

## Proposed Changes

### Design System Primitives & Exports

#### [NEW] [QuestionCard.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/QuestionCard.tsx)
- Add `QuestionCard` primitive:
  - Header: Question prompt, actor badge (`asked by planner` / `asked by implementer`), time, status dot.
  - Body: `whyUndetermined` context, formatted list of `evidence` items (file paths + line numbers + notes).
  - Options selector: Render option choices, highlight `recommendation`, plus custom free-text input.
  - Action footer: `[ Answer ]`, `[ Answer + Lock as Decision ]`, and optional `[ View in Workflow ]`.
  - Answered state: shows user answer, timestamp, and decision status.

#### [NEW] [QuestionCard.test.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/QuestionCard.test.tsx)
- Unit tests for `QuestionCard`: renders evidence, option selection, free-text override, answer submission with/without decision lock.

#### [MODIFY] [index.ts](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/index.ts)
- Export `QuestionCard` and associated types from `@renderer/ui`.

---

### Question Queue Page & App Shell

#### [NEW] [QuestionsPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/QuestionsPage.tsx)
- Create Question Queue page:
  - Header summary banner showing count of open questions requiring decision.
  - Tab filters for `Unanswered` vs `All Questions`.
  - Lists questions grouped by project or chronological order.
  - Real-time updates via `window.forge.onWorkflowEvent`.
  - One-click answering and workflow resumption with toast feedback.

#### [MODIFY] [Sidebar.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/Sidebar.tsx)
- Add unmissable question counter badge on the `/questions` navigation item when there are unanswered questions.

#### [MODIFY] [App.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/App.tsx)
- Mount `QuestionsPage` on `/questions` route.

---

## Verification Plan

### Automated Tests
- Unit tests: `QuestionCard.test.tsx`, `routes.test.ts`.
- Complete test suite: `npm run format:check && npm run check`.
- E2E tests: `npx playwright test`.

### Manual Verification
- Verify Question Queue loads questions, displays evidence, allows option selection and custom text answer.
- Verify answering immediately resumes the paused workflow and updates badge count.

---

```
┌──────────────────────────────────────────────────────────┐
│ Questions                                                │
│ [ Unanswered (2) ]  [ All Questions (5) ]                │
├──────────────────────────────────────────────────────────┤
│ ● 2 questions require your decision                      │
├──────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────┐ │
│ │ ● OAuth authorization behaviour     asked by planner │ │
│ │                                                      │ │
│ │ Why undetermined: existing APIs use both behaviours   │ │
│ │                                                      │ │
│ │ EVIDENCE INSPECTED (4)                               │ │
│ │   ✓ Services/AuthService.cs:212                      │ │
│ │   ✓ Controllers/TenantController.cs:88               │ │
│ │   ✓ appsettings.json                                 │ │
│ │   ✓ Tests/AuthServiceTests.cs                        │ │
│ │                                                      │ │
│ │ (•) 403 [rec]   ( ) 404   ( ) Other / Custom…        │ │
│ │                                                      │ │
│ │ [ Answer ]  [ Answer + Lock as Decision ]            │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

# Walkthrough: Issue #39 - Question Queue UI with Evidence Trails & One-Click Answers

## User Interface & Data Flow

```
┌──────────────────────────────────────────────────────────┐
│ Questions                                                │
│ [ Unanswered (2) ]  [ All Questions (5) ]                │
├──────────────────────────────────────────────────────────┤
│ ● 2 questions require your decision                      │
├──────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────┐ │
│ │ ● OAuth authorization behaviour     asked by planner │ │
│ │                                                      │ │
│ │ Why undetermined: existing APIs use both behaviours   │ │
│ │                                                      │ │
│ │ EVIDENCE INSPECTED (4)                               │ │
│ │   ✓ Services/AuthService.cs:212                      │ │
│ │   ✓ Controllers/TenantController.cs:88               │ │
│ │   ✓ appsettings.json                                 │ │
│ │   ✓ Tests/AuthServiceTests.cs                        │ │
│ │                                                      │ │
│ │ (•) 403 [rec]   ( ) 404   ( ) Other / Custom…        │ │
│ │                                                      │ │
│ │ [ Answer ]  [ Answer + Lock as Decision ]            │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Changes Implemented

1. **Design System Primitive: `QuestionCard`**:
   - Implemented in [QuestionCard.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/QuestionCard.tsx).
   - Shows question prompt, actor badge (`asked by planner` / `asked by implementer`), why-undetermined explanation, and formatted evidence references.
   - Interactive options selector with highlighted recommendations and free-text override.
   - Submits answers with or without decision promotion (`[ Answer ]`, `[ Answer + Lock as Decision ]`).
   - Displays recorded answer details when already answered.
   - Fully covered by unit tests in [QuestionCard.test.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/QuestionCard.test.tsx).

2. **Question Queue Page**:
   - Implemented in [QuestionsPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/QuestionsPage.tsx).
   - Unanswered questions action banner and tab filters (`Unanswered`, `All Questions`).
   - Live synchronization with orchestrator events via `window.forge.onWorkflowEvent`.
   - Toast notifications on recording answers and resuming workflows.

3. **Shell & Navigation Integration**:
   - Added unmissable badge on `/questions` nav item in [Sidebar.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/Sidebar.tsx) displaying the count of unanswered questions.
   - Mounted `QuestionsPage` on `/questions` route in [App.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/App.tsx).

## Verification Results

- **Unit Tests**: 666/666 passed across 39 files.
- **Router check**: 7/7 passed.
- **Documentation check**: passed.
- **Smoke checks**: 8/8 passed.
- **Design System & UI checks**: 13/13 passed.
- **Playwright E2E Tests**: 11/11 passed.
- **GitHub Actions CI (PR #81)**: All 3 jobs passed (`Format, lint, types, tests`, `App checks (Electron)`, `App checks (Windows)`).

---

# Implementation Plan - Issue #40: Decision Lock + Architecture Change Requests

Implements Axiom A4: locked decisions cannot be changed by agents. Only the user may lock, unlock, or supersede a decision. Locked decisions are injected verbatim into prompt packets. When an agent proposes or requests a change to architecture, a change request pauses the workflow in `AWAITING_USER` for human review.

## User Review Required

> [!IMPORTANT]
> Axiom A4 is strictly enforced: `DecisionStore.lock` and `supersede` reject any actor other than `'user'`.
> Locked decisions are passed verbatim into subsequent prompt packets so implementers and reviewers treat them as binding constraints.

## Proposed Changes

### Core & Persistence

#### [NEW] [decisionStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/decisionStore.ts)
- Implement `DecisionStore`:
  - `find(decisionId: DecisionId): Decision | null`
  - `listForProject(projectId: ProjectId, status?: DecisionStatus): readonly Decision[]`
  - `listLocked(projectId: ProjectId): readonly Decision[]`
  - `propose(decision: Decision, projectId: ProjectId, actor: Actor, occurredAt: string): Decision`
  - `approve(decisionId: DecisionId, actor: Actor, occurredAt: string): Decision`
  - `lock(decisionId: DecisionId, actor: 'user', occurredAt: string): Decision` (Enforces user-only)
  - `supersede(decisionId: DecisionId, replacementId: DecisionId, actor: 'user', occurredAt: string): Decision`
  - `promoteFromQuestion(questionId: QuestionId, statement: string, rationale: string, actor: 'user', occurredAt: string): Decision`

#### [NEW] [decisionStore.test.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/decisionStore.test.ts)
- Unit tests for `DecisionStore`: proposing, approving, locking (user only), rejecting agent locking, superseding, and projection replay.

#### [MODIFY] [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts)
- Implement projections for `decision.proposed`, `decision.approved`, `decision.locked`, and `decision.superseded`.
- Remove them from `PROJECTED_LATER`.

---

### Context Engine & Orchestration

#### [MODIFY] [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts)
- Wire `DecisionStore` into `WorkflowService`.
- In `compilePacket`: fetch `lockedDecisions` for the project and pass `{ id: d.id, statement: d.statement, rationale: d.rationale }` into `compileContext`.
- When `answerQuestion` is called with `promoteToDecision = true`, promote the answer to a locked decision in `DecisionStore`.

---

### IPC & Preload APIs

#### [MODIFY] [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts)
- Add `decisionViewSchema` and IPC channels:
  - `decision:list`: `{ projectId: string, status?: string } -> { decisions: readonly DecisionView[] }`
  - `decision:get`: `{ decisionId: string } -> DecisionView | null`
  - `decision:propose`: `{ projectId: string, statement: string, rationale: string } -> DecisionView`
  - `decision:lock`: `{ decisionId: string } -> DecisionView`
  - `decision:supersede`: `{ decisionId: string, replacementStatement: string, replacementRationale: string } -> DecisionView`

#### [NEW] [decisionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/decisions/decisionService.ts)
- Service layer handling `decision:*` IPC channels.

#### [MODIFY] [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts)
- Wire `decision:*` handlers to `DecisionService`.

#### [MODIFY] [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts) & [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts)
- Expose `window.forge.decision` methods.

---

### UI & Decisions Page

#### [NEW] [DecisionCard.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/DecisionCard.tsx)
- Design system primitive displaying decision statement, rationale, status badge (`Proposed`, `Approved`, `Locked`, `Superseded`), lineage (origin question/workflow), and actions (`[ Lock Decision ]`, `[ Supersede ]`).

#### [NEW] [DecisionCard.test.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/DecisionCard.test.tsx)
- Unit tests for `DecisionCard`.

#### [NEW] [DecisionsPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/DecisionsPage.tsx)
- Decisions page with status filter tabs (`All`, `Locked`, `Proposed`, `Superseded`), Propose Decision modal/form, and live updates.

#### [MODIFY] [App.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/App.tsx)
- Mount `DecisionsPage` on `/decisions` route.

---

## Verification Plan

### Automated Tests
- Unit tests: `decisionStore.test.ts`, `DecisionCard.test.tsx`.
- Verification suite: `npm run format:check && npm run check`.
- E2E tests: `npx playwright test`.

### Manual Verification
- Test locking decisions from UI and from question answers.
- Verify locked decisions appear in prompt packets.
- Verify user-only locking constraint.

---

# Walkthrough: Issue #40 - Decision Lock & Architecture Change Requests (Axiom A4)

## Workflow & Lineage Model

```
┌──────────────────────────────────────────────────────────┐
│ Decisions                                                │
│ [ All (3) ]  [ Locked (2) ]  [ Proposed ]  [ Superseded ]│
├──────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────┐ │
│ │ [ Locked (Axiom A4) ]         proposed by user       │ │
│ │ Use PostgreSQL for persistent multi-tenant storage   │ │
│ │                                                      │ │
│ │ RATIONALE & JUSTIFICATION                            │ │
│ │ Required for row-level security and ACID compliance. │ │
│ │                                                      │ │
│ │ Locked on 8/24/2026 by user                          │ │
│ │ Promoted from question: q-101                        │ │
│ │                                                      │ │
│ │ [ Change Request (Supersede) ]                       │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Changes Implemented

1. **Persistence & Axiom A4 Enforcement**:
   - Implemented [decisionStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/decisionStore.ts).
   - Enforces user-only locking and superseding. Non-user actors attempting to lock or supersede throw an Axiom A4 violation error.
   - Added event projections for `decision.proposed`, `decision.approved`, `decision.locked`, and `decision.superseded` in [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts).
   - Replay test proves 100% byte-identical reconstruction from event log alone.

2. **Context Engine & Orchestrator Integration**:
   - Updated [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts) to read `locked` decisions and inject them verbatim as `lockedDecisions: LockedDecision[]` into every prompt packet.
   - Wired `promoteToDecision` in `answerQuestion` to promote human answers into binding locked decisions.

3. **IPC & Preload Surface**:
   - Added `decisionViewSchema` and channels in [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts): `decision:list`, `decision:get`, `decision:propose`, `decision:approve`, `decision:lock`, `decision:supersede`.
   - Implemented [decisionService.ts](file:///d:/my-quests/side-projects/Forge/src/main/decisions/decisionService.ts) and wired handlers in [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts).
   - Exposed typed methods on `window.forge.decision` in [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts) and [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts).

4. **UI & Decisions Page**:
   - Created [DecisionCard.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/DecisionCard.tsx) with locked badge, rationale card, lineage trail, and inline architecture change request form.
   - Created [DecisionsPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/DecisionsPage.tsx) on route `/decisions`.
   - Configured `.cursorrules` and `.rules` for the team GitHub achievement workflow.

## Verification Results

- **Unit Tests**: 673/673 tests passed.
- **Router check**: 7/7 passed.
- **Documentation check**: passed.
- **Smoke checks**: 8/8 passed.
- **Design System & UI checks**: 13/13 passed.
- **Playwright E2E Tests**: 12/12 passed (including full propose/lock decision flow).
- **GitHub Actions CI (PR #82)**: All 3 jobs passed (`Format, lint, types, tests`, `App checks (Electron)`, `App checks (Windows)`).

---

```
┌───────────────┬──────────────────────────────────────────────┐
│ CHANGESET #142│  Services/AuthService.cs        +24  -6      │
│ implementer   │──────────────────────────────────────────────│
│ review: FAIL  │  212 - if (!user.HasScope(scope))            │
│ 8 files       │  212 + if (!await _scopes.Allows(user, sc))  │
│               │                                              │
│ M AuthService │  [ read-only ]   [ Edit ]                     │
│ M TenantCtrl  │                                              │
│ A ScopeStore  │  ← discrepancy: claimed but not modified     │
│ D OldPolicy   │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

### Plan for Issue #41 (Changes Review UI):
1. **Persistence & Git**:
   - `ChangeSetStore` with projections for `changeset.captured` and `changeset.reviewed`.
   - `GitService.readFileInWorktree` & `GitService.writeFileInWorktree` for direct worktree inspection and user edits.
2. **IPC & Bridge**:
   - `changeset:list`, `changeset:get`, `git:getWorkingDiff`, `git:readFile`, `git:writeFile`.
3. **UI & Design System Primitives**:
   - `DiffViewer`: unified/split views, hunk line numbers, syntax/token styling, read-only default, opt-in edit mode with save action writing to disk.
   - `FileTree`: changed file tree with addition/deletion counters, status badges (`M`, `A`, `D`, `R`), and discrepancy indicators.
   - `ChangesPage`: `/changes` route with changeset history selector, discrepancy details, and file diff viewer.

# Implementation Plan - Issue #41: Changes Review UI

Provides a dedicated changes review UI with diff viewing, discrepancy highlighting, changeset history, and opt-in edit mode allowing user-authored modifications directly to the working tree.

## User Review Required

> [!IMPORTANT]
> **Read-only by default**: The UI displays diffs and files read-only by default. Edit mode is an explicit toggle `[ Read-only | Edit ]`.
> When in edit mode, edits write to the real working tree and are recorded as user-authored changes.

## Proposed Changes

### Core & Persistence

#### [NEW] [changeSetStore.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/changeSetStore.ts)
- Implement `ChangeSetStore`:
  - `find(changeSetId: ChangeSetId): ChangeSet | null`
  - `listForProject(projectId: ProjectId): readonly ChangeSet[]`
  - `record(changeSet: ChangeSet, projectId: ProjectId, actor: Actor, occurredAt: string): ChangeSet`
  - `recordReview(changeSetId: ChangeSetId, review: ReviewOutcome, projectId: ProjectId, actor: Actor, occurredAt: string): void`

#### [NEW] [changeSetStore.test.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/changeSetStore.test.ts)
- Unit tests for `ChangeSetStore` and projection replay.

#### [MODIFY] [projections.ts](file:///d:/my-quests/side-projects/Forge/src/main/db/projections.ts)
- Add projections for `changeset.captured` and `changeset.reviewed`. Remove from `PROJECTED_LATER`.

#### [MODIFY] [gitService.ts](file:///d:/my-quests/side-projects/Forge/src/main/git/gitService.ts)
- Add `readFileInWorktree(relativePath: string): Promise<string>`
- Add `writeFileInWorktree(relativePath: string, content: string): Promise<void>`

---

### IPC & Services

#### [MODIFY] [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts)
- Add schemas and channels:
  - `changeset:list`: `{ projectId: string } -> { changeSets: readonly ChangeSetView[] }`
  - `changeset:get`: `{ changeSetId: string } -> ChangeSetView | null`
  - `git:getWorkingDiff`: `{ projectId: string } -> { files: readonly ChangedFileView[], patch: string }`
  - `git:readFile`: `{ projectId: string, path: string } -> { content: string }`
  - `git:writeFile`: `{ projectId: string, path: string, content: string } -> { success: boolean }`

#### [NEW] [changeSetService.ts](file:///d:/my-quests/side-projects/Forge/src/main/changesets/changeSetService.ts)
- Service managing changesets and git file read/writes for the active project.

#### [MODIFY] [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts), [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts), [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts)
- Wire `changeset:*` and `git:*` methods through preload bridge.

---

### UI & Design System

#### [NEW] [DiffViewer.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/DiffViewer.tsx)
- Diff viewer component:
  - Supports unified and side-by-side split modes.
  - Line additions (+ green), line deletions (- red), line numbers.
  - Read-only default with `[ Read-only | Edit ]` mode toggle.
  - Syntax highlighted code editing in edit mode with `Save (Ctrl+S)` saving directly to disk via `window.forge.git.writeFile`.
  - Discrepancy banners for discrepancies found on the current file.

#### [NEW] [FileTree.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/FileTree.tsx)
- Tree / file list component:
  - Shows changed files with status badge (M, A, D, R) and line diff stats (`+24 -6`).
  - Discrepancy warning icon on files flagged with discrepancies.
  - Active selection highlighting.

#### [NEW] [ChangesPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/ChangesPage.tsx)
- Route `/changes` displaying:
  - Header with `<h1>Changes</h1>` (matching nav item).
  - Left pane: Changeset selector (Working Tree vs historical Changesets #N) + `FileTree`.
  - Right pane: `DiffViewer` with read-only/edit toggle and file summary.

#### [MODIFY] [App.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/App.tsx)
- Mount `ChangesPage` on `/changes` route.

---

## Verification Plan

### Automated Tests
- Unit tests: `changeSetStore.test.ts`, `DiffViewer.test.tsx`, `FileTree.test.tsx`.
- Verification suite: `npm run format:check && npm run check`.
- E2E tests: `npx playwright test` covering review and edit mode saving.

---

```
┌──────────────────────────────────────────────────────────────┐
│ CHANGES                                     [ Refresh Git ]  │
├─────────────────┬────────────────────────────────────────────┤
│ Changeset / Src │ src/services/AuthService.ts [ READ-ONLY ]  │
│ [ Working Tree] │────────────────────────────────────────────│
│                 │ 1  diff --git a/src/services/AuthService.ts│
│ M AuthService.ts│ 2  --- a/src/services/AuthService.ts       │
│   +24  -6       │ 3  +++ b/src/services/AuthService.ts       │
│ A User.ts       │ 4  @@ -12,4 +12,6 @@                       │
│   +40           │ 5  - if (!user.HasScope(scope))            │
│                 │ 6  + if (!await _scopes.Allows(user, sc))  │
│ [!] Scope Discr.│                                            │
│                 │ [ Edit File ] ──> [ EDIT MODE (User) ]     │
└─────────────────┴────────────────────────────────────────────┘
```

# Walkthrough: Issue #41 - Changes Review UI (Diff Viewer, Read-Only Default, Opt-In Edit Mode)

## UI & Architecture Model

```
┌──────────────────────────────────────────────────────────────┐
│ CHANGES                                     [ Refresh Git ]  │
├─────────────────┬────────────────────────────────────────────┤
│ Changeset / Src │ src/services/AuthService.ts [ READ-ONLY ]  │
│ [ Working Tree] │────────────────────────────────────────────│
│                 │ 1  diff --git a/src/services/AuthService.ts│
│ M AuthService.ts│ 2  --- a/src/services/AuthService.ts       │
│   +24  -6       │ 3  +++ b/src/services/AuthService.ts       │
│ A User.ts       │ 4  @@ -12,4 +12,6 @@                       │
│   +40           │ 5  - if (!user.HasScope(scope))            │
│                 │ 6  + if (!await _scopes.Allows(user, sc))  │
│ [!] Scope Discr.│                                            │
│                 │ [ Edit File ] ──> [ EDIT MODE (User) ]     │
└─────────────────┴────────────────────────────────────────────┘
```

## Summary of Changes

1. **Design System Primitives**:
   - [FileTree.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/FileTree.tsx): Changed files list with status badges (`M`, `A`, `D`, `R`), additions/deletions counters (`+24 -6`), active selection highlighting, and discrepancy warning indicators.
   - [DiffViewer.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/ui/primitives/DiffViewer.tsx): Code diff viewer with line numbers and token coloring. **Read-only by default** with an explicit `[ Edit File ]` toggle entering user-authored edit mode with live changes saving directly to the working tree. Inline discrepancy alert banners.

2. **Persistence & Read Models**:
   - [ChangeSetStore](file:///d:/my-quests/side-projects/Forge/src/main/db/changeSetStore.ts): Handles `changeset.captured` and `changeset.reviewed` projections and event log replay.
   - [gitService.ts](file:///d:/my-quests/side-projects/Forge/src/main/git/gitService.ts): Added `readFileInWorktree` and `writeFileInWorktree` for direct user editing.

3. **IPC & Preload Bridge**:
   - Channels: `changeset:list`, `changeset:get`, `git:getWorkingDiff`, `git:readFile`, `git:writeFile`.
   - Wired in [changeSetService.ts](file:///d:/my-quests/side-projects/Forge/src/main/changesets/changeSetService.ts), [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts), [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts), and [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts).

4. **Changes Page & Routing**:
   - [ChangesPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/ChangesPage.tsx) mounted on `/changes`.
   - Allows switching between uncommitted working tree diffs and historical Changesets with review verdicts and author attribution.

## Verification Results

- **Unit & Component Tests**: 680/680 passed (including `changeSetStore.test.ts`, `FileTree.test.tsx`, `DiffViewer.test.tsx`).
- **Router check**: 7/7 passed.
- **Documentation check**: passed.
- **Smoke checks**: 8/8 passed.
- **Design System UI checks**: 13/13 passed.
- **Playwright E2E Tests**: 13/13 passed (including Changes page rendering).
- **GitHub Actions CI (PR #83)**: All 3 jobs passed (`Format, lint, types, tests`, `App checks (Electron)`, `App checks (Windows)`).

---

```
DISCUSSION MODE                    IMPLEMENTATION MODE
  brainstorm                         execute the locked plan
  challenge architecture             modify files
  inspect repository                 run commands
  propose decisions                  produce changesets
  ask questions                      get reviewed
  ────────────────                   ────────────────
  NO FILE MODIFICATION               requires DECISIONS_LOCKED
```

### Proposed Plan for Issue #42:
1. **Structural Enforcement (Axiom A3 / A4 / A7)**:
   - In **Discussion Mode** (planner / debate roles), `writeFiles: false` is enforced.
   - `Orchestrator` verifies git diff post-step: if any files were changed during discussion mode, it immediately halts with `permission-violation`.
   - Discussion transcripts are stored with explicit disclaimers: **not** a source of truth per Axiom A1.
2. **Deliberate Mode Transition**:
   - Gated by: (1) at least one approved/locked decision, and (2) defined task completion criteria.
   - Dedicated IPC channel `workflow:approveAndStartImplementation`.
3. **UI Integration**:
   - `ModeBadge` in `WorkflowPage`: `[ DISCUSSION MODE ]` vs `[ IMPLEMENTATION MODE ]`.
   - Transition checklist and single explicit control: `[ Continue to Implementation ]`.


# Implementation Plan - Issue #42: Discussion Mode vs Implementation Mode

Structurally enforces the separation between Discussion Mode (read-only brainstorming, question asking, decision proposing) and Implementation Mode (plan execution, change generation, verification), gated by Decision Lock and completion criteria.

## User Review Required

> [!IMPORTANT]
> **Structural Enforcement**:
> - In **Discussion Mode**, all agents have `writeFiles: false` strictly enforced. If an agent attempts any file modification or write command, the orchestrator detects the git diff and halts with a `permission-violation` policy failure.
> - Discussion transcripts are persisted for auditability but explicitly tagged as **not** the source of truth (Axiom A1).
> - Transitioning from Discussion Mode to Implementation Mode requires:
>   1. At least one locked or approved architectural decision.
>   2. A task with defined completion criteria.

## Proposed Changes

### Domain & Policy

#### [MODIFY] [orchestrator.ts](file:///d:/my-quests/side-projects/Forge/src/main/runtimes/orchestrator.ts)
- Structurally enforce worktree invariance during read-only/discussion steps: if `!permits(binding, 'writeFiles')`, check `measureChange()`. If any files are modified, halt immediately with `permission-violation`.

#### [MODIFY] [workflowService.ts](file:///d:/my-quests/side-projects/Forge/src/main/workflows/workflowService.ts)
- Add mode transition verification:
  - `transitionToImplementation(workflowId: string)`: verifies at least 1 locked decision and task completion criteria before allowing state advance to `IMPLEMENTING`.

---

### IPC & Contracts

#### [MODIFY] [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts), [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts), [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts), [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts)
- Add `workflow:approveAndStartImplementation` channel to `IPC_CONTRACT` and preload bridge.

---

### UI & Workflow Page

#### [MODIFY] [WorkflowPage.tsx](file:///d:/my-quests/side-projects/Forge/src/renderer/src/app/workflow/WorkflowPage.tsx)
- Add prominent `ModeBadge` indicating `DISCUSSION MODE` vs `IMPLEMENTATION MODE`.
- In `AWAITING_APPROVAL` state, render the Mode Transition banner showing checklist:
  - `[x] Plan produced`
  - `[ ] Decisions locked (>= 1)`
  - `[x] Completion criteria defined`
- "Continue to Implementation" action button enabled only when preconditions are met.

---

## Verification Plan

### Automated Tests
- Unit tests in `orchestrator.test.ts`: verify orchestrator halts if a read-only discussion agent modifies the worktree.
- Service tests in `workflowService.test.ts`: verify transition to implementation fails without locked decisions, and succeeds when locked decisions and criteria exist.
- Verification suite: `npm run format:check && npm run check`.
- E2E tests: `npx playwright test` validating mode banner and transition flow.

---

Issue #42: Discussion Mode vs Implementation Mode (Structurally Enforced)

```
┌─────────────────────────────────────────────────────────────┐
│                       DISCUSSION MODE                       │
│  • Brainstorm, challenge architecture, inspect repo         │
│  • Read-only worktree permissions enforced by Orchestrator   │
│  • Worktree writes ──> Instant permission-violation HALT    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                [ Continue to Implementation ]
                               │
               (Check >= 1 locked decision: A4)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     DECISION LOCK GATE                      │
│  • Locks architectural decisions into SQLite Event Log      │
│  • Emits 'workflow.mode_transition' audit event             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     IMPLEMENTATION MODE                     │
│  • Implementation & Verification authorized to write files  │
│  • Criteria verification and ChangeSet review               │
└─────────────────────────────────────────────────────────────┘
```

# Walkthrough: Discussion Mode vs Implementation Mode (Issue #42)

Enforced two distinct operating modes structurally rather than relying on agent prompt compliance.

```
┌─────────────────────────────────────────────────────────────┐
│                       DISCUSSION MODE                       │
│  • Brainstorm, challenge architecture, inspect repo         │
│  • Read-only worktree permissions enforced by Orchestrator   │
│  • Worktree writes -> Instant permission-violation HALT     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                [ Continue to Implementation ]
                               │
               (Check >= 1 locked decision: A4)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     DECISION LOCK GATE                      │
│  • Locks architectural decisions into SQLite Event Log      │
│  • Emits 'workflow.mode_transition' audit event             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     IMPLEMENTATION MODE                     │
│  • Implementation & Verification authorized to write files  │
│  • Criteria verification and ChangeSet review               │
└─────────────────────────────────────────────────────────────┘
```

## Key Deliverables

1. **Structural Read-Only Enforcement (`src/main/runtimes/orchestrator.ts`)**:
   - For steps without `writeFiles` capability (discussion/planning roles), the orchestrator measures worktree changes via git status.
   - If unexpected modifications occur on disk, the orchestrator immediately halts the run with `permission-violation` (`HALTED_POLICY`).

2. **Decision Lock Gate (`src/main/workflows/workflowService.ts`)**:
   - Added `approveAndStartImplementation(workflowId)` which queries `decisions.listForProject(projectId)` and enforces that at least one decision is in `'locked'` or `'approved'` state (Axiom A4).
   - Advances workflow state machine (`userApproved`) to `DECISIONS_LOCKED` / `IMPLEMENTING` and records `workflow.mode_transition` in the audit event log.

3. **Workflow UI (`src/renderer/src/app/workflow/WorkflowPage.tsx`)**:
   - Added badge indicators: `DISCUSSION MODE (Read-only)` vs `IMPLEMENTATION MODE (Decision Locked)`.
   - When awaiting approval, renders the `[ Continue to Implementation ]` action button.

4. **IPC Contract & Bridge**:
   - Registered `workflow:approveAndStartImplementation` in [ipc.ts](file:///d:/my-quests/side-projects/Forge/src/shared/ipc.ts), [handlers.ts](file:///d:/my-quests/side-projects/Forge/src/main/ipc/handlers.ts), [api.ts](file:///d:/my-quests/side-projects/Forge/src/preload/api.ts), and [index.ts](file:///d:/my-quests/side-projects/Forge/src/preload/index.ts).

## Verification Results

- **Automated Tests**:
  - `src/main/runtimes/orchestrator.test.ts`: 27/27 tests passed including discussion-mode disk write violations.
  - `src/main/workflows/workflowService.test.ts`: 4/4 tests passed including decision lock precondition enforcement.
  - All 682 unit & integration tests, Playwright E2E tests, Electron smoke, and UI checks passed.
- **GitHub Actions CI**:
  - `App checks (Electron)`: PASS (1m 19s)
  - `App checks (Windows)`: PASS (1m 50s)
  - `Format, lint, types, tests`: PASS (1m 21s)


---

Issue #43: MVP Acceptance - Multi-Agent Closed Loop with Zero Copy-Paste

# Walkthrough: MVP Acceptance - Multi-Agent Closed Loop with Zero Copy-Paste (#43)

Completed the MVP acceptance test suite and formal acceptance report for Milestone M5, verifying that Forge can run a complete multi-agent engineering lifecycle on a real git repository with zero manual copy-pasting.

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

## Key Deliverables

1. **Acceptance Test Suite (`src/main/acceptance/mvpAcceptance.test.ts`)**:
   - Closed-loop verification on real git repository (`DISCOVERY` ➔ `PLANNING` ➔ `PLAN_READY` ➔ `DECISIONS_LOCKED` ➔ `IMPLEMENTING` ➔ `VERIFYING` ➔ `REVIEWING` ➔ `DONE`).
   - Clean pause when an agent raises an open question and automatic resume upon user answer.
   - Crash recovery & resume plan generation from write-ahead SQLite checkpoints.
2. **Acceptance Documentation (`docs/MVP_ACCEPTANCE.md`)**:
   - System flowchart and state lifecycle.
   - Axiom compliance matrix (A1 to A7).
   - Documented gaps and limits deferred to Milestone M6 (Polish & Scale).

## Verification Results

- **Automated Tests**:
  - `src/main/acceptance/mvpAcceptance.test.ts`: 3/3 tests passing.
  - Full test suite: 45 test files, 685 tests passing.
  - Linter, typecheck, production build, router check, docs check, electron smoke tests, UI checks, and Playwright E2E tests: **ALL PASS**.
- **GitHub Actions CI**:
  - `App checks (Electron)`: **PASS** (1m 15s)
  - `App checks (Windows)`: **PASS** (1m 41s)
  - `Format, lint, types, tests`: **PASS** (1m 15s)


---
