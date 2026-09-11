# PROMPT
Yes. Based on everything we clarified, I would **not** make the prompt simply “build Forge CLI.” It should instruct the coding agent to **first understand the current Forge state, then architect and execute the Native Agent + CLI + Engine foundation in controlled phases**, while keeping the long-term Lego workflow architecture intact.

Below is a self-contained prompt you can give directly to **Claude Code** for deep planning/research/architecture. It is intentionally designed so Claude can inspect the actual repository rather than hallucinating what Forge already has.

```text
# FORGE — NATIVE AGENT + CLI + GENERIC ENGINEERING CONTROL PLANE
## Master Architecture, Research & Implementation Planning Prompt

You are acting as the Principal Architect / Staff Software Engineer for the Forge project.

Your job is NOT to blindly implement features.

Your job is to deeply inspect the existing Forge repository, understand what actually exists today, identify architectural gaps, and produce a technically rigorous, implementation-ready master plan for evolving Forge into:

1. A powerful standalone Native Coding Agent ("Forge Agent")
2. A first-class Forge CLI
3. A provider-independent Agent Runtime abstraction
4. A generic Engineering Control Plane / Workflow Engine
5. A Lego-like composable workflow system
6. A platform capable of orchestrating Forge Agent, Claude Code, Codex, OpenCode, Kilo, Cline, Antigravity, local agents/models, scripts, tools, humans, and future agents.

The Native Forge Agent is NOT intended to be a clone of Claude Code.

It exists so Forge remains independently useful even when the user has:
- no Claude subscription
- no Codex subscription
- no external AI API key
- only local models
- private/offline requirements
- limited budget

Forge Agent should therefore become a genuinely capable autonomous coding agent that can use local models and Forge's own infrastructure.

However, the Forge Engine must NEVER depend on Forge Agent.

Forge Agent is one worker.
Claude Code is one worker.
Codex is one worker.
OpenCode is one worker.
Kilo is one worker.
Cline is one worker.
Antigravity is one worker.
A human can also be a worker.

The Forge Engine orchestrates them.

============================================================
## 0. CORE PRODUCT VISION
============================================================

The central architectural principle is:

"Forge does not own intelligence.
Forge owns execution, state, coordination, evidence, policy, and truth."

Agents provide intelligence.

Forge provides control.

The desired architecture is conceptually:

                         FORGE
                           |
             +-------------+-------------+
             |             |             |
             v             v             v
       Forge Agent    External Agents   Tools
        (Native)      / Adapters
             |             |
             +-------------+-------------+
                           |
                    Forge Engine
                           |
        +------------------+------------------+
        |                  |                  |
     Workflow            State             Evidence
     Engine              System             System
        |                  |                  |
     Policies          Artifacts          Verification
        |                  |                  |
        +------------------+------------------+
                           |
                         HUMAN

Forge should be able to run standalone with only:

Forge + local model

but should also be able to run:

Forge + Claude Code

Forge + Codex

Forge + Forge Agent

Forge + Claude + Codex + Forge Agent

Forge + OpenCode + Kilo + scripts

etc.

============================================================
## 1. THE ORIGINAL USER PROBLEM
============================================================

The original manual workflow was:

YOU
 |
 v
Claude Code
 |
 | brainstorm
 | research
 | architecture
 | planning
 | questions
 | implementation plan
 |
 v
copy/paste prompt
 |
 v
Antigravity
 |
 | inspect
 | implementation planning
 | coding
 | testing
 | walkthrough/summary
 |
 v
copy/paste implementation summary
 |
 v
Claude Code
 |
 | inspect actual repository
 | inspect git diff
 | review implementation
 | verify
 |
 +---- PASS ----> next task/phase
 |
 +---- FAIL ----> create correction prompt
                         |
                         v
                    Antigravity
                         |
                         v
                       repeat

This workflow was effective but extremely manual.

The human became the orchestration layer.

Forge should eliminate this repetitive orchestration work.

BUT:

This exact workflow must NOT become hardcoded into Forge.

It is merely one possible workflow.

It should eventually be expressible as a Forge workflow/graph.

Example:

Claude PLAN
    |
Human APPROVAL
    |
Antigravity IMPLEMENT
    |
Forge VERIFY
    |
Claude REVIEW
    |
 +--+--+
 |     |
PASS  FAIL
 |     |
DONE  Antigravity FIX
          |
          v
        VERIFY

This should be "Workflow #001", not Forge's architecture.

============================================================
## 2. STRATEGIC ARCHITECTURE
============================================================

Forge should conceptually contain three major layers:

------------------------------------------------------------
LAYER A — FORGE NATIVE AGENT
------------------------------------------------------------

A standalone autonomous coding agent.

Responsibilities may include:

- repository discovery
- codebase exploration
- context gathering
- planning
- reasoning
- tool calling
- file operations
- shell commands
- git operations
- test execution
- debugging
- implementation
- refactoring
- error recovery
- self-correction
- verification
- context management
- session management
- compaction
- human questions
- permissions
- safe execution
- headless operation
- local model support

The Native Agent should be powerful.

But do NOT blindly reproduce Claude Code's implementation.

Study existing coding agents for proven patterns, then design Forge's own architecture.

------------------------------------------------------------
LAYER B — AGENT RUNTIME / ADAPTER SYSTEM
------------------------------------------------------------

Forge must define a stable abstraction around an "agent worker."

Potential workers:

- Forge Agent
- Claude Code
- Codex
- OpenCode
- Kilo
- Cline
- Antigravity
- other coding agents
- custom agents
- human
- scripts
- CI jobs

The workflow engine should interact with capabilities/contracts rather than provider-specific assumptions.

Potential conceptual interface:

AgentRuntime
  start()
  send()
  observe()
  interrupt()
  resume()
  stop()
  status()
  capabilities()

Do NOT blindly use this exact interface.

Determine the correct abstraction after inspecting the repository and researching actual runtime capabilities.

------------------------------------------------------------
LAYER C — FORGE ENGINE / CONTROL PLANE
------------------------------------------------------------

This is Forge's primary differentiation.

The Engine owns:

- workflow execution
- orchestration
- state
- task lifecycle
- dependencies
- graph execution
- agent assignment
- human interaction
- permissions
- policy
- evidence
- artifacts
- verification
- retries
- recovery
- checkpoints
- execution history
- observability
- cancellation
- concurrency
- resource limits
- truth/reconciliation

The Engine must not assume that the worker is Forge Agent.

============================================================
## 3. LEGO WORKFLOW PRINCIPLE
============================================================

Forge workflows must be composable.

Do NOT create a hardcoded:

Planner -> Implementer -> Reviewer

pipeline.

Instead provide reusable primitives.

Potential primitives:

AgentNode
HumanNode
ToolNode
VerificationNode
ApprovalNode
QuestionNode
ConditionNode
ParallelNode
SequentialNode
LoopNode
JoinNode
RetryNode
TransformNode
ArtifactNode
CheckpointNode
SubWorkflowNode
EscalationNode
WaitNode
ScriptNode

These are examples, not necessarily the final API.

Determine the minimum correct primitive set.

Each node should conceptually have:

- id
- type
- input
- output
- dependencies
- capabilities
- permissions
- timeout
- retry policy
- failure policy
- state
- artifacts
- evidence
- execution metadata

The system should support arbitrary graphs.

============================================================
## 4. IMPORTANT ARCHITECTURAL SEPARATION
============================================================

Maintain strict separation between:

INTELLIGENCE
    |
    +-- Agents
    +-- Models
    +-- Reasoning

and:

CONTROL
    |
    +-- Forge Engine
    +-- Workflow
    +-- State
    +-- Policy
    +-- Evidence
    +-- Verification
    +-- Human control

and:

EXECUTION
    |
    +-- Filesystem
    +-- Shell
    +-- Git
    +-- Tests
    +-- Browser
    +-- APIs
    +-- External tools

Do not mix these responsibilities.

============================================================
## 5. CURRENT REPOSITORY IS THE SOURCE OF TRUTH
============================================================

Before proposing implementation:

1. Inspect the complete repository.
2. Inspect source structure.
3. Inspect package configuration.
4. Inspect existing architecture.
5. Inspect database/state layer.
6. Inspect current Agent implementation.
7. Inspect Ask mode.
8. Inspect UI.
9. Inspect CLI status.
10. Inspect tests.
11. Inspect documentation.
12. Inspect TODOs.
13. Inspect unfinished/planned code.
14. Inspect Git history where useful.
15. Run relevant existing tests/build/checks if practical.

NEVER assume that something exists because a document says it should exist.

Classify every important capability as:

[IMPLEMENTED]
[PARTIAL]
[PLANNED]
[EXPERIMENTAL]
[UNKNOWN]
[MISSING]

For each important claim provide:

- file/path
- symbol/class/function where applicable
- current behavior
- confidence
- architectural implications

Do not invent files, APIs, modules, or implementation details.

============================================================
## 6. EXTERNAL RESEARCH
============================================================

Research modern coding agents and orchestration systems as architectural references.

At minimum consider:

- Claude Code
- Codex
- Cline
- Kilo
- OpenCode
- October Harness
- Agent Orchestrator
- relevant local-model runtimes
- relevant agent protocols/SDKs where appropriate

Research specifically:

- agent loops
- tool architecture
- context management
- compaction
- planning
- task execution
- error recovery
- subagents
- permissions
- sandboxing
- Git/worktrees
- session persistence
- CLI/headless operation
- SDK/RPC interfaces
- MCP
- event streaming
- human interaction
- multi-agent execution
- concurrency
- verification
- provider abstraction
- local model support

Do not copy marketing claims.

Prefer source-level evidence and official technical documentation.

Clearly distinguish:

SOURCE VERIFIED
IMPLEMENTATION INFERENCE
ARCHITECTURAL RECOMMENDATION
UNKNOWN

============================================================
## 7. DO NOT PREMATURELY IMPLEMENT
============================================================

This task begins as:

AUDIT
  ->
ARCHITECTURE
  ->
DESIGN
  ->
ROADMAP
  ->
IMPLEMENTATION PLAN

Do not start coding simply because a feature sounds useful.

First determine:

- what already exists
- what should remain
- what must be refactored
- what must be deleted
- what should be deferred
- what belongs to Native Agent
- what belongs to Runtime
- what belongs to Engine
- what belongs to UI
- what belongs to infrastructure

Avoid architectural churn.

============================================================
## 8. MASTER PHASE STRUCTURE
============================================================

Create a roadmap using the following high-level phases.

You may modify the phase structure if repository evidence shows a better decomposition.

------------------------------------------------------------
PHASE 0 — REPOSITORY FORENSICS & BASELINE
------------------------------------------------------------

Goal:

Understand exactly what Forge is today.

Tasks:

0.1 Repository structure audit
0.2 Runtime architecture audit
0.3 Existing Ask mode audit
0.4 Existing model/provider architecture
0.5 Existing tool system
0.6 Existing state/persistence
0.7 Existing process management
0.8 Existing Git integration
0.9 Existing UI architecture
0.10 Existing CLI status
0.11 Existing test architecture
0.12 Existing security/policy boundaries
0.13 Existing documentation consistency
0.14 Identify dead/duplicate/experimental code
0.15 Build capability inventory

Deliverable:

FORGE-CURRENT-STATE.md

Include:

Capability
Status
Evidence
Owner
Dependencies
Risks

No implementation yet unless necessary for baseline validation.

------------------------------------------------------------
PHASE 1 — ARCHITECTURAL CONTRACTS
------------------------------------------------------------

Goal:

Define stable boundaries before expanding the system.

Tasks:

1.1 Define AgentRuntime contract
1.2 Define AgentCapabilities
1.3 Define AgentSession
1.4 Define AgentEvent
1.5 Define Tool contract
1.6 Define Workflow contract
1.7 Define Node contract
1.8 Define Artifact contract
1.9 Define Evidence contract
1.10 Define ExecutionState
1.11 Define HumanInteraction contract
1.12 Define Policy contract
1.13 Define Error/Failure model
1.14 Define cancellation semantics
1.15 Define checkpoint/resume semantics

Critical requirement:

These contracts must not depend on Claude, Codex, OpenCode, Kilo, or Forge Agent.

------------------------------------------------------------
PHASE 2 — FORGE NATIVE AGENT CORE
------------------------------------------------------------

Goal:

Build a genuinely useful autonomous coding agent.

Do NOT attempt to implement every advanced feature immediately.

First build a strong minimal agent loop.

Suggested decomposition:

2.1 Agent process/runtime
2.2 Model abstraction
2.3 Conversation/session state
2.4 System/context construction
2.5 Repository discovery
2.6 File reading/search
2.7 File editing
2.8 Shell execution
2.9 Git inspection
2.10 Test execution
2.11 Tool result handling
2.12 Agent loop
2.13 Planning mode
2.14 Implementation mode
2.15 Verification mode
2.16 Error recovery
2.17 User questions
2.18 Permission enforcement
2.19 Cancellation
2.20 Session persistence
2.21 Context management
2.22 Compaction
2.23 Long-running execution
2.24 Structured final result
2.25 Evidence collection

Important:

Do not blindly duplicate another agent's architecture.

Derive the design from Forge's requirements.

------------------------------------------------------------
PHASE 3 — FORGE CLI
------------------------------------------------------------

Goal:

Make Forge Agent and Forge Engine usable from terminal/headless environments.

Design CLI around stable concepts, not UI implementation.

Potential command families:

forge
forge init
forge agent
forge run
forge workflow
forge task
forge session
forge inspect
forge status
forge verify
forge evidence
forge logs
forge resume
forge cancel

Determine the final command structure.

CLI must support:

3.1 Interactive mode
3.2 One-shot task
3.3 Headless mode
3.4 JSON output
3.5 Streaming events
3.6 Exit codes
3.7 Session resume
3.8 Cancellation
3.9 Logs
3.10 Workflow execution
3.11 Machine-readable output
3.12 CI-friendly execution
3.13 Non-interactive permissions
3.14 Error reporting

Do not duplicate business logic between GUI and CLI.

Both must call the same Engine/Agent services.

------------------------------------------------------------
PHASE 4 — STATE + ARTIFACT + EVIDENCE SYSTEM
------------------------------------------------------------

Goal:

Make Forge capable of knowing what actually happened.

Design:

State
Artifacts
Events
Evidence
Decisions
Execution history

Examples of artifacts:

PlanArtifact
CodeChangeArtifact
GitDiffArtifact
TestResultArtifact
BuildResultArtifact
ReviewArtifact
DecisionArtifact
QuestionArtifact
ResearchArtifact
ErrorArtifact

Critical principle:

Agent claims are not truth.

Example:

Agent says:
"Tests passed."

Forge should be able to independently determine:

tests executed
command
exit code
duration
output
repository state
commit/diff
timestamp

Evidence must be first-class.

------------------------------------------------------------
PHASE 5 — VERIFICATION & RECONCILIATION
------------------------------------------------------------

Goal:

Forge independently verifies important claims.

Tasks:

5.1 Git state inspection
5.2 Diff inspection
5.3 Test execution
5.4 Build verification
5.5 Static analysis
5.6 lint/typecheck
5.7 custom verification commands
5.8 evidence aggregation
5.9 claim/evidence comparison
5.10 stale-result detection
5.11 post-change verification
5.12 failure classification
5.13 verification policy

Design:

Agent:
"I believe implementation is complete."

Forge:
"Show evidence."

------------------------------------------------------------
PHASE 6 — WORKFLOW ENGINE
------------------------------------------------------------

Goal:

Build generic workflow execution.

Core concepts:

Workflow
Run
Node
Edge
Task
Artifact
Event
State
Condition
Dependency

Tasks:

6.1 Sequential execution
6.2 Dependency graph
6.3 Conditions
6.4 Branching
6.5 Loops
6.6 Retry
6.7 Parallel execution
6.8 Join
6.9 Timeout
6.10 Cancellation
6.11 Resume
6.12 Checkpoints
6.13 Failure handling
6.14 Human gates
6.15 Questions
6.16 Escalation
6.17 Sub-workflows

Do not implement visual workflow builder first.

Build the execution model first.

------------------------------------------------------------
PHASE 7 — AGENT ORCHESTRATION
------------------------------------------------------------

Goal:

Allow workflows to dynamically assign work to agents.

Tasks:

7.1 Agent registry
7.2 Agent discovery
7.3 Capability matching
7.4 Agent selection
7.5 Agent health/status
7.6 Agent lifecycle
7.7 Agent concurrency
7.8 Agent cancellation
7.9 Agent recovery
7.10 Agent output normalization
7.11 Agent event normalization
7.12 Agent-specific capability negotiation

Example:

Workflow requires:

"coding + terminal + git"

Forge finds an agent capable of those requirements.

The workflow should not need to know which provider is used.

------------------------------------------------------------
PHASE 8 — EXTERNAL AGENT ADAPTERS
------------------------------------------------------------

Implement adapters incrementally.

Potential adapters:

8.1 Claude Code
8.2 Codex
8.3 OpenCode
8.4 Kilo
8.5 Cline
8.6 Antigravity
8.7 Generic CLI agent
8.8 Custom agent

Do NOT implement all adapters simultaneously.

First create one robust adapter as the reference implementation.

Then generalize.

Important:

Adapters must remain thin.

Provider-specific behavior belongs inside the adapter.

Generic orchestration logic belongs inside Forge Engine.

------------------------------------------------------------
PHASE 9 — HUMAN-IN-THE-LOOP SYSTEM
------------------------------------------------------------

Goal:

Humans become first-class workflow participants.

Support:

9.1 Approval
9.2 Rejection
9.3 Question
9.4 Answer
9.5 Decision
9.6 Override
9.7 Pause
9.8 Resume
9.9 Manual intervention
9.10 Escalation

Example:

Agent:
"I found two architectural options."

Forge:
"Human decision required."

Human chooses:

Option B.

Workflow continues.

Do not force human interaction into chat-only semantics.

------------------------------------------------------------
PHASE 10 — SECURITY & POLICY
------------------------------------------------------------

Goal:

Make autonomous execution safe.

Cover:

10.1 Tool permissions
10.2 Filesystem permissions
10.3 Shell permissions
10.4 Network permissions
10.5 Git permissions
10.6 Secret handling
10.7 Workspace isolation
10.8 Agent trust boundaries
10.9 Prompt injection considerations
10.10 Malicious repository content
10.11 Command confirmation
10.12 Policy engine
10.13 Resource limits
10.14 Timeouts
10.15 Kill/abort
10.16 Audit trail

Security must be architectural, not a UI checkbox.

------------------------------------------------------------
PHASE 11 — WORKTREE / PARALLEL / MULTI-AGENT EXECUTION
------------------------------------------------------------

Only after the previous layers are stable.

Support:

11.1 Git worktrees
11.2 isolated agent workspaces
11.3 parallel tasks
11.4 independent hypotheses
11.5 multi-agent review
11.6 result aggregation
11.7 merge strategy
11.8 conflict handling
11.9 task dependency graphs
11.10 concurrency limits
11.11 resource budgets

Example:

Bug
 |
 +-- Agent A investigates
 |
 +-- Agent B investigates
 |
 +-- Agent C investigates
 |
 +-- Verification
 |
 Judge
 |
 Implementation

------------------------------------------------------------
PHASE 12 — WORKFLOW DSL / CONFIGURATION
------------------------------------------------------------

Goal:

Allow users to define workflows without modifying Forge source code.

Potential representations:

YAML
JSON
TOML
TypeScript
GUI graph

Do NOT decide prematurely.

Evaluate tradeoffs.

A workflow should express:

agents
nodes
inputs
outputs
conditions
dependencies
permissions
timeouts
retry policies
verification
human gates

Example concept:

workflow:
  name: feature-development

nodes:
  - planner
  - implementer
  - verifier
  - reviewer

But this is only an example.

Design the actual schema carefully.

------------------------------------------------------------
PHASE 13 — WORKFLOW COMPOSABILITY
------------------------------------------------------------

Goal:

Make workflows Lego-like.

Support:

- reusable nodes
- reusable sub-workflows
- parameterized workflows
- workflow inputs
- workflow outputs
- composition
- templates
- conditions
- dynamic routing
- agent substitution
- capability-based assignment

Example:

"Code Review Workflow"

can be embedded inside:

"Feature Development Workflow"

which can be embedded inside:

"Release Workflow"

------------------------------------------------------------
PHASE 14 — OBSERVABILITY
------------------------------------------------------------

Goal:

Users should understand exactly what Forge is doing.

Expose:

- current task
- active agent
- current node
- tool execution
- model activity
- state transitions
- artifacts
- evidence
- failures
- retries
- decisions
- token/cost information where available
- timing
- resource consumption

CLI and UI should use the same event/state model.

------------------------------------------------------------
PHASE 15 — UI / CONTROL PLANE EXPERIENCE
------------------------------------------------------------

Only after core semantics are stable.

Evolve UI toward:

Project
|
+-- Sessions
+-- Agents
+-- Workflows
+-- Runs
+-- Tasks
+-- Artifacts
+-- Evidence
+-- Decisions
+-- Policies
+-- Logs

The UI should visualize the engine.

Do not make the UI the engine.

Potential run visualization:

Requirement
    |
Claude / Planner
    |
Human Approval
    |
Codex / Implementer
    |
Forge Verification
    |
Claude / Reviewer
    |
 PASS / FAIL
    |
 correction loop

Again:

This is visualization of a generic graph.

------------------------------------------------------------
PHASE 16 — BENCHMARKING & HARDENING
------------------------------------------------------------

Create controlled benchmarks.

Do NOT use fabricated scores.

Measure:

- task success
- correctness
- verification accuracy
- recovery rate
- long-horizon success
- tool reliability
- context efficiency
- latency
- token consumption
- cost
- failure rate
- human intervention rate
- false completion rate
- regression rate

Compare:

Forge Agent
Claude Code
Codex
OpenCode
Kilo
Cline
other relevant systems

Use the same tasks and, where possible, same models.

Separate:

SOURCE ANALYSIS

from:

RUNTIME BENCHMARK

from:

ARCHITECTURAL OPINION.

============================================================
## 9. PRIORITY MODEL
============================================================

For every task classify:

P0 — foundational / blocking
P1 — critical
P2 — important
P3 — enhancement
P4 — future / experimental

Also classify by category:

[AGENT]
[RUNTIME]
[ENGINE]
[WORKFLOW]
[STATE]
[EVIDENCE]
[VERIFICATION]
[CLI]
[SECURITY]
[ADAPTER]
[UI]
[OBSERVABILITY]
[PERFORMANCE]
[TESTING]
[DOCUMENTATION]
[RESEARCH]

Example:

P0 | AGENT | Agent loop
P0 | RUNTIME | AgentRuntime contract
P0 | STATE | Execution state
P1 | EVIDENCE | Git diff evidence
P1 | CLI | Headless execution
P1 | ENGINE | Sequential workflow
P2 | WORKFLOW | Parallel nodes

============================================================
## 10. DEPENDENCY GRAPH
============================================================

Do not provide a simple chronological TODO list.

Build an actual dependency graph.

Example:

Repository Audit
      |
      v
Architecture Contracts
      |
      +----------------+
      |                |
      v                v
Agent Runtime       State Model
      |                |
      v                |
Forge Agent            |
      |                |
      +-------+--------+
              |
              v
          Forge CLI
              |
              v
       Evidence System
              |
              v
       Verification
              |
              v
       Workflow Engine
              |
      +-------+-------+
      |               |
      v               v
Agent Registry    Human Gates
      |
      v
External Adapters
      |
      v
Parallel/Multi-Agent
      |
      v
Workflow DSL
      |
      v
Composable Workflows
```

Correct dependencies may differ after repository inspection.

============================================================

## 11. TASK FORMAT

============================================================

Every implementation task must use this structure:

TASK ID:
PHASE:
CATEGORY:
PRIORITY:
TITLE:

OBJECTIVE:

WHY IT EXISTS:

CURRENT STATE:

DESIRED STATE:

DEPENDENCIES:

SUBTASKS:

1.
2.
3.
4.

FILES / MODULES LIKELY AFFECTED:

INTERFACES / CONTRACTS:

IMPLEMENTATION NOTES:

EDGE CASES:

SECURITY CONSIDERATIONS:

TEST REQUIREMENTS:

ACCEPTANCE CRITERIA:

EVIDENCE REQUIRED:

RISKS:

ROLLBACK / MIGRATION:

DONE DEFINITION:

Do not create fake file paths.

Use actual repository paths after inspection.

============================================================

## 12. PHASE GATES

============================================================

Every phase must have a gate.

A phase is NOT complete because code was written.

A phase is complete only when:

* implementation exists
* tests pass
* architecture remains coherent
* contracts are respected
* documentation is updated
* failure paths are considered
* evidence exists
* no known critical regression remains

For each phase define:

ENTRY CONDITIONS
EXIT CONDITIONS
VALIDATION COMMANDS
EXPECTED RESULTS
KNOWN RISKS

============================================================

## 13. IMPLEMENTATION STRATEGY

============================================================

Prefer vertical slices over building huge disconnected frameworks.

For example:

BAD:

Build entire Agent framework
Build entire Workflow framework
Build entire Evidence framework
Then try to integrate.

BETTER:

Vertical Slice #1:

User
|
Forge CLI
|
Forge Agent
|
Read files
|
Edit files
|
Run tests
|
Return evidence

Then:

Vertical Slice #2:

Workflow
|
Agent
|
Verification
|
State
|
CLI output

Then:

Vertical Slice #3:

Workflow
|
External Agent
|
Verification
|
Review

Then:

Vertical Slice #4:

Parallel agents
|
Evidence
|
Judge
|
Merge

============================================================

## 14. FIRST REFERENCE WORKFLOW

============================================================

Use the user's original workflow as the first real-world validation case.

Implement conceptually:

Requirement
|
Planning Agent
|
Human Approval
|
Implementation Agent
|
Forge Verification
|
Review Agent
|
+-- PASS --> Next Phase
|
+-- FAIL --> Correction Agent
|
v
Verification
|
v
Review

But ensure every component is replaceable.

For example:

Planner:
Claude / Codex / Forge Agent

Implementer:
Antigravity / Codex / Claude / Forge Agent

Reviewer:
Claude / Codex / Forge Agent

Verifier:
Forge itself

The workflow must not care.

============================================================

## 15. CRITICAL DESIGN QUESTIONS

============================================================

Answer these before implementation:

1. What exactly is an Agent in Forge?

2. What exactly is an Agent Runtime?

3. What makes an Agent capable of participating in a workflow?

4. What is the difference between:
   Agent
   Model
   Runtime
   Tool
   Task
   Workflow
   Node
   Run
   Session
   Artifact
   Evidence
   Decision?

5. Where does agent memory live?

6. Where does workflow state live?

7. What is persisted?

8. How is state recovered after crash?

9. How does Forge know whether an agent actually completed work?

10. How does Forge independently verify agent claims?

11. How does a workflow pass context between agents?

12. Should context be raw conversation, structured artifacts, files, or all three?

13. How does an external CLI agent communicate events?

14. How does Forge handle an agent that does not support structured events?

15. How are permissions represented?

16. How does cancellation work?

17. What happens when an agent hangs?

18. What happens when an agent gives a wrong result?

19. What happens when two agents modify the same files?

20. How are parallel agents isolated?

21. How are their results merged?

22. How does human intervention work?

23. How does a workflow pause/resume?

24. How does Forge support local-only operation?

25. How does Forge select between local and external agents?

26. Can a workflow specify capability requirements instead of provider names?

27. Can one workflow be reused with completely different agents?

28. What is Forge's actual unique value if Claude/Codex are available?

29. What is Forge's actual unique value if no external agent is available?

30. What should Forge explicitly NOT attempt to own?

============================================================

## 16. NON-GOALS

============================================================

Do not accidentally turn Forge into:

* a Claude Code clone
* a model-training framework
* a generic chatbot
* a plugin marketplace
* a cloud-only SaaS
* an IDE replacement
* an unrestricted autonomous shell
* a hardcoded Claude -> Antigravity pipeline
* a visual workflow toy without a reliable execution engine

Forge should remain focused on engineering execution/control.

============================================================

## 17. ARCHITECTURAL QUALITY RULES

============================================================

Follow these principles:

1. Provider independence.

2. Native Agent independence.

3. Engine independence from specific agents.

4. CLI and GUI share the same core.

5. No duplicated business logic.

6. Evidence beats agent claims.

7. UNKNOWN != ASSUME.

8. Human decisions are first-class state.

9. State must survive process failure where appropriate.

10. Every autonomous operation needs cancellation.

11. Every dangerous capability needs policy.

12. Workflows must be composable.

13. Agents must be replaceable.

14. Models must be replaceable.

15. Tools must be replaceable.

16. Avoid premature abstraction.

17. Prefer explicit contracts.

18. Prefer observable state transitions.

19. Prefer deterministic orchestration over hidden magic.

20. Keep the core small.

============================================================

## 18. WHAT I EXPECT FROM YOU NOW

============================================================

Do NOT immediately implement the entire system.

Start by performing a deep repository audit.

Then produce:

### DOCUMENT 1

FORGE CURRENT STATE

Include:

* architecture
* modules
* current capabilities
* Ask mode
* agent implementation
* CLI status
* state
* persistence
* tools
* UI
* tests
* security
* gaps

### DOCUMENT 2

FORGE TARGET ARCHITECTURE

Include:

* Native Agent
* Agent Runtime
* Engine
* Workflow
* State
* Evidence
* Verification
* Adapters
* CLI
* UI
* Security

### DOCUMENT 3

FORGE MASTER ROADMAP

Use:

Phase
|
Category
|
Task
|
Subtask
|
Dependency
|
Acceptance criteria
|
Validation

### DOCUMENT 4

FORGE ARCHITECTURAL DECISIONS

For every major decision:

DECISION
CONTEXT
OPTIONS
TRADEOFFS
RECOMMENDATION
CONSEQUENCES

### DOCUMENT 5

FORGE IMPLEMENTATION BACKLOG

Produce concrete task IDs.

Example:

AGENT-001
AGENT-002
RUNTIME-001
STATE-001
CLI-001
ENGINE-001
EVIDENCE-001
VERIFY-001
WORKFLOW-001
ADAPTER-001
SECURITY-001

Each task must contain:

objective
dependencies
subtasks
affected files
implementation notes
tests
acceptance criteria
evidence
risks

### DOCUMENT 6

FORGE VALIDATION STRATEGY

Define how we will prove:

* Native Agent works
* CLI works
* external agents work
* workflow execution works
* verification works
* state recovery works
* human gates work
* parallel execution works
* security boundaries work
* workflows remain provider-independent

============================================================

## 19. FINAL OUTPUT FORMAT

============================================================

Your response should be structured exactly around:

# Executive Summary

# Current Forge Reality

# Problems / Architectural Gaps

# Target Architecture

# Core Domain Model

# Native Forge Agent Architecture

# Agent Runtime Contract

# Forge CLI Architecture

# State / Artifact / Evidence Architecture

# Verification Architecture

# Workflow Engine Architecture

# Agent Adapter Architecture

# Human-in-the-Loop Architecture

# Security Architecture

# Lego Workflow Model

# Phase Roadmap

# Dependency Graph

# Detailed Task/Subtask Backlog

# Phase Gates

# Testing Strategy

# Benchmark Strategy

# Risks

# Architectural Decisions

# Recommended Immediate Next Step

============================================================

## 20. MOST IMPORTANT INSTRUCTION

============================================================

Do not optimize Forge around today's agents.

Design Forge so that:

today:

Forge Agent
Claude Code
Antigravity

can work.

Tomorrow:

Codex
OpenCode
Kilo
Cline
new agents

can work.

Later:

completely unknown agents

can work.

Likewise, do not optimize the workflow engine around the user's original workflow.

That workflow is merely the first validation case.

The real objective is:

```
                ANY USER
                   |
                   v
              ANY WORKFLOW
                   |
      +------------+------------+
      |            |            |
    Agent        Human        Tool
      |            |            |
      +------------+------------+
                   |
                   v
                FORGE
                   |
    +--------------+--------------+
    |              |              |
  State         Evidence       Policy
    |              |              |
    +--------------+--------------+
                   |
                   v
              REAL RESULT
```

Forge should become the system that lets users construct their own engineering workflows from reusable primitives.

Your job is to make that architecture technically real without sacrificing the standalone power of the Native Forge Agent.

============================================================

## EXECUTION MODE

============================================================

Work conservatively.

First inspect.

Then reason.

Then document.

Then propose.

Do not hallucinate.

Do not claim something is implemented unless you verify it in the repository.

Do not assign numerical scores without benchmark evidence.

Do not blindly copy Claude Code, Codex, Cline, Kilo, OpenCode, October, or Agent Orchestrator.

Study them for ideas and tradeoffs.

When uncertain, explicitly mark:

UNKNOWN

and explain what evidence is required.

The final result should be implementation-ready enough that another coding agent can take individual task IDs and execute them independently without needing to rediscover the architecture.

END OF MASTER PROMPT

````

### One change I strongly recommend to your agent workflow

Since you're using **Claude Code primarily for architecture/planning and another agent for implementation**, don't give this entire prompt to the implementation agent immediately.

Use it first with **Claude Code as the Architect/Auditor**.

The pipeline should become:

```text
YOU
 │
 ▼
Claude Code
 │
 ├── Repository audit
 ├── Architecture
 ├── Decisions
 ├── Phases
 ├── Task IDs
 └── Implementation prompt
          │
          ▼
     Implementation Agent
          │
          ├── code
          ├── tests
          └── evidence
          │
          ▼
     Claude Code
          │
          ├── inspect actual diff
          ├── verify
          ├── challenge
          └── approve/reject
````

But **the important difference now is that you're building the infrastructure that will eventually automate this exact loop.**

And I would make one naming distinction permanent:

```text
Forge Engine
    = control plane / orchestration

Forge Agent
    = native autonomous coding worker

Agent Runtime
    = contract for workers

Agent Adapter
    = bridge to external workers

Workflow
    = user-composed Lego structure
```

If those five concepts remain cleanly separated, Forge has a very strong architectural foundation.

---

## RESPONSE
# FORGE — MASTER ENGINEERING PROGRAM
## Native Agent + Universal Agent Runtime + Engineering Control Plane + Lego Workflow System

Operating in **planning, repository forensics, and technical program management mode**, I have performed an exhaustive audit of the Forge codebase (`d:\my-quests\side-projects\Forge`), executed and recorded the automated test suites, audited all 24 open GitHub issues, reconciled milestones and labels, and established the permanent implementation-ready architecture.

The permanent repository documentation has been authored directly into your project:
- 📄 [**docs/FORGE-MASTER-ENGINEERING-PROGRAM.md**](file:///d:/my-quests/side-projects/Forge/docs/FORGE-MASTER-ENGINEERING-PROGRAM.md)
- 📄 [**docs/FORGE-MASTER-TODO.md**](file:///d:/my-quests/side-projects/Forge/docs/FORGE-MASTER-TODO.md)

---

## 1. Executive Summary

Forge is evolving from an Electron-hosted multi-agent desktop application into an enterprise-grade **Engineering Control Plane and Autonomous Native Coding Agent**.

### The Absolute Architectural Principle
> **"Forge does not own intelligence. Forge owns execution, state, coordination, evidence, policy, and truth."**

Agents supply cognitive intelligence. Forge supplies deterministic governance, physical ground-truth verification, cryptographic auditability, and execution safety.

### The Five Invariant Pillars
1. **Forge Engine**: The generic control plane (state machine, DAG executor, evidence system, physical git reconciliation, policy gate).
2. **Forge Agent**: The native autonomous coding worker (ReAct loop, 15 sandboxed tools, local Ollama / API models, offline-first).
3. **Agent Runtime**: The universal capability contract (`IAgentRuntime`) that any worker must implement.
4. **Agent Adapter**: Thin translation bridges connecting external agents (Claude Code, Codex, OpenCode, Kilo, Cline, Antigravity, scripts).
5. **Workflow**: The user-composed Lego graph of executable nodes (Agent, Human, Verification, Router, Script) with dependencies and budgets.

---

## 2. Current Forge Reality

### Verified Test Suite Baseline (`npm test`)
```
+---------------------------------------------------------------------------------------------------------------+
| Test Suite                     | Files | Tests Passed | Tests Failed | Execution Time | Notes                 |
+---------------------------------------------------------------------------------------------------------------+
| src/shared/domain              | 15    | 316          | 0            | 751ms          | 100% pure Zod FSM     |
| src/main/providers             | 6     | 124          | 0            | 1.76s          | Tools & Chat streaming|
| src/main/runtimes              | 22    | 238          | 0 (2 skip)   | 20.07s         | Orchestrator & runners|
| Total Verified Core Tests      | 43    | 678          | 0            | 22.58s         | Rock-solid baseline   |
+---------------------------------------------------------------------------------------------------------------+
```

### Verified Implementation Status
- **State Machine FSM (`src/shared/domain/transitions.ts`)**: `[SOURCE VERIFIED]` 18 strictly typed states (`PROMPT_INGESTED`, `PLAN_REQUESTED`, `TASK_DISPATCHED`, `AGENT_RUNNING`, `VERIFICATION_RUNNING`, `RECONCILIATION_RUNNING`, `DONE`, `HALTED_POLICY`).
- **Physical Diff Reconciliation (`src/main/runtimes/orchestrator.ts:75-99`)**: `[SOURCE VERIFIED]` `measureChange()` calls real `git diff`; `reconcileStep()` checks claimed files against the filesystem. Any out-of-scope modification triggers an immediate `HALTED_POLICY` transition.
- **Anti-Rationalization ReAct Loop (`src/main/providers/agentLoop.ts`)**: `[SOURCE VERIFIED]` 10-round bounded ReAct loop with `requireOneOf` anti-rationalization nudges (*"Describing the change is not making it. Call write_file now."*) and reasoning buffer extraction for empty completions.
- **Tool Suite (`src/main/providers/tools.ts`)**: `[SOURCE VERIFIED]` 15 core tools including filesystem read/write, directory search, grep, bash execution, task board tools, plan mode toggles, and subagent messaging.
- **Workflow Graph V2 Schema (`src/shared/domain/workflowGraph.ts`)**: `[SOURCE VERIFIED]` Zod schema defining `WorkflowTemplateV2`, `WorkflowNode`, input slots, output contracts, and dependency edges.
- **Storage Layer (`src/main/db/schema.ts`)**: `[SOURCE VERIFIED]` Drizzle SQLite schema with append-only event log (`events`), content-addressed packet store (`packetStore.ts`), change sets, evidence artifacts, tasks, workflows, and decisions.

---

## 3. Target Forge Architecture

```
+=============================================================================================================+
|                                              USER SURFACES                                                  |
|                  +--------------------------------+--------------------------------+                        |
|                  |       Forge Desktop UI         |           Forge CLI            |                        |
|                  |       (Electron / React)       |      (Headless / Ink TUI)      |                        |
|                  +--------------------------------+--------------------------------+                        |
+===================================================||========================================================+
                                                    || (Shared IPC / Node Service API)
+===================================================vv========================================================+
|                                           FORGE ENGINE                                                      |
|                                       (Generic Control Plane)                                               |
|  +-------------------------------------------------------------------------------------------------------+  |
|  | Lego Workflow DAG Executor (Node Graph, Edges, Dependency Resolution, Join, Loop, Branch)            |  |
|  +-------------------------------------------------------------------------------------------------------+  |
|  | State & Persistence: Drizzle SQLite Event Log, WorkflowStore, StepStore, CheckpointManager            |  |
|  +-------------------------------------------------------------------------------------------------------+  |
|  | Evidence & Verification: measureChange(), reconcileStep(), Physical Git Diff, Test Runners           |  |
|  +-------------------------------------------------------------------------------------------------------+  |
|  | Policy & Safety: Role Permission Gates, Glob Sandboxing, Anti-Loop Budgets, Secret Filter             |  |
+===================================================||========================================================+
                                                    || (IAgentRuntime Contract)
+===================================================vv========================================================+
|                                        AGENT RUNTIME LAYER                                                  |
|                   +---------------------------------------------------------------+                         |
|                   | IAgentRuntime Interface: start, send, events, status, cancel  |                         |
|                   +---------------------------------------------------------------+                         |
|                                ||                                          ||                               |
|        +-----------------------vv-------+                  +---------------vv----------------------+        |
|        |          NATIVE WORKER         |                  |          EXTERNAL ADAPTERS            |        |
|        |       Forge Native Agent       |                  |                                       |        |
|        |   - Bounded ReAct Loop         |                  |   + Claude Code Adapter (CLI / PTY)   |        |
|        |   - 15 Sandboxed Tools         |                  |   + Codex / OpenCode Adapter          |        |
|        |   - Ollama / Local Models      |                  |   + Cline / Antigravity Adapter       |        |
|        |   - OpenAI / Anthropic API     |                  |   + Generic Script / CI Adapter       |        |
|        |   - Anti-Rationalization Guard |                  |   + Human Worker Gateway              |        |
|        +--------------------------------+                  +---------------------------------------+        |
+=============================================================================================================+
```

---

## 4. Architecture Conflicts Found

1. **Electron Lifecycle Coupling**: `src/main/index.ts` initializes SQLite, Git services, and IPC handlers inside the Electron app lifecycle (`app.whenReady()`). The Engine and Native Agent cannot currently run headlessly without Electron.
2. **Hardcoded FSM vs. Lego DAG V2**: While `workflowGraph.ts` defines generic nodes and edges, `orchestrator.ts` currently only drives the linear hardcoded state machine (`transitions.ts`).
3. **Context Truncation & Memory Limits**: `agentLoop.ts` does not yet have OpenCode's two-stage compaction (`compactAfterOverflow`) or Claude Code's `<persisted-output>` disk spill mechanism. Tool results exceeding 50KB risk blowing the model's context window.
4. **Turn-Level Checkpoints Missing**: While Forge reconciles changes per step, it lacks Cline's instant 1-click turn-by-turn rewind (`refs/forge/checkpoints/`).

---

## 5. Existing Issue Audit

The Forge repository currently has **24 open GitHub issues**. All 24 have been forensically audited:
- **0 issues should be silently deleted.** Historical context is preserved.
- **1 issue is obsolete and closed with evidence**: `#64` (the #20 spike was completed by ADR-001 / ADR-003).
- **1 issue is merged**: `#161` is merged into `#171` (interjections into live sessions).
- **5 issues are promoted to core architectural pillars**:
  - `#183` (stale runtime fallback) → `RUNTIME-003` (runtime resolution truth & substitution events).
  - `#174` (custom CLI dialog) → `ADAPTER-001` (`GenericCliAgentRuntime` configured from JSON data).
  - `#171` (prompts/interjections to live session) → `HUMAN-002` (interactive session steering).
  - `#164` (templates run/skip/re-run stage) → `WORKFLOW-002` (Lego DAG execution controls).
  - `#163` (human approval gate real) → `HUMAN-001` (durable human gate in FSM).

---

## 6. Issue Reconciliation Table

```
+-------------------------------------------------------------------------------------------------------------------------------------+
| Issue | Title                                             | Status | Alignment | Action         | Area     | Pri | Milestone | Deps |
+-------------------------------------------------------------------------------------------------------------------------------------+
| #183  | Stale runtime binding silently falls back         | OPEN   | 🟢 Strong | KEEP + REFRAME | runtime  | P1  | M8        | —    |
| #180  | Hosted session cannot tell provider limit spent   | OPEN   | 🟡 Reframe| KEEP + REFRAME | adapter  | P2  | M9        | —    |
| #178  | Two git-dependent tests fail intermittently       | OPEN   | 🟢 Strong | KEEP + FIX     | testing  | P1  | M0        | —    |
| #174  | Custom CLI dialog: runtime configured from data   | OPEN   | 🟢 Strong | KEEP + PROMOTE | runtime  | P1  | M8        | —    |
| #172  | Delete stdout parsers once hooks replace them     | OPEN   | 🟡 Reframe| KEEP + REFRAME | adapter  | P3  | M9        | #165 |
| #171  | Send prompts and mid-run interjections to live ses| OPEN   | 🟢 Strong | KEEP + PROMOTE | runtime  | P1  | M7        | #157 |
| #168  | Launch Antigravity CLI interactively into session | OPEN   | 🔵 Defer  | DEFER / ADAPT  | adapter  | P2  | M9        | #165 |
| #165  | EPIC M11 — Host the real CLI instead of headless  | OPEN   | 🟢 Strong | KEEP + REFRAME | runtime  | P1  | M9        | —    |
| #164  | Templates starting shape: run, skip, re-run stage | OPEN   | 🟢 Strong | KEEP + PROMOTE | workflow | P1  | M6        | —    |
| #163  | Make human approval gate real (stop auto-approve) | OPEN   | 🟢 Strong | KEEP + BLOCKER | engine   | P0  | M7        | —    |
| #162  | SPIKE: Claude CLI mid-session input research      | OPEN   | 🟡 Reframe| KEEP + RESEARCH| adapter  | P2  | M9        | —    |
| #161  | Interject: send message to running step           | OPEN   | 🟢 Strong | MERGE into #171| runtime  | P2  | M7        | #171 |
| #160  | EPIC M10 — Interactive control: steer running     | OPEN   | 🟢 Strong | KEEP + REFRAME | engine   | P1  | M7        | —    |
| #159  | Benchmark harness: wall-clock per stage vs manual | OPEN   | 🔵 Defer  | KEEP + DEFER   | testing  | P2  | M12       | —    |
| #158  | Resume real CLI sessions in both adapters         | OPEN   | 🟢 Strong | KEEP + REFRAME | adapter  | P2  | M9        | #157 |
| #157  | IAgentRuntime resumable session outlives step     | OPEN   | 🟢 Strong | KEEP + PROMOTE | runtime  | P1  | M8        | —    |
| #156  | EPIC M9 — Warm sessions: stop cold-context cost   | OPEN   | 🟢 Strong | KEEP + REFRAME | runtime  | P2  | M8        | #157 |
| #155  | Show live tool-call timeline per step             | OPEN   | 🟡 Reframe| KEEP + REFRAME | ui / cli | P2  | M3        | #153 |
| #154  | Bind workflow terminal to running step            | OPEN   | 🟢 Strong | KEEP           | ui       | P1  | M7        | #165 |
| #153  | Push runtime events to renderer over typed IPC    | OPEN   | 🟢 Strong | KEEP           | ipc      | P2  | M4        | —    |
| #149  | EPIC M8 — Live agent channel: see work happen     | OPEN   | 🟢 Strong | KEEP + REFRAME | engine   | P1  | M4        | —    |
| #138  | Agent instances need own persona identity         | OPEN   | 🟡 Reframe| KEEP + REFRAME | runtime  | P2  | M8        | —    |
| #117  | Build Tasks page or decide Tasks is not user-face | OPEN   | 🟡 Reframe| KEEP + DECISION| ui       | P3  | M7        | —    |
| #64   | Re-run authenticated leg of #20 spike             | OPEN   | 🔴 Obsolete| CLOSE (Done)   | runtime  | P3  | M0        | —    |
+-------------------------------------------------------------------------------------------------------------------------------------+
```

---

## 7. Label Strategy

Labels in `mdsaif45/forge-orchestrator` are normalized into 5 strict dimensions:
- **`type:*`**: `type:bug`, `type:feature`, `type:architecture`, `type:research`, `type:refactor`, `type:test`, `type:docs`.
- **`area:*`**: `area:engine`, `area:agent`, `area:runtime`, `area:workflow`, `area:cli`, `area:state`, `area:evidence`, `area:adapter`, `area:security`, `area:ui`.
- **`priority:*`**: `priority:P0` (Blocker), `priority:P1` (High), `priority:P2` (Medium), `priority:P3` (Low), `priority:P4` (Future).
- **`status:*`**: `status:blocked`, `status:ready`, `status:in-progress`, `status:needs-review`.
- **`provider:*`**: `provider:claude`, `provider:codex`, `provider:opencode`, `provider:kilo`, `provider:cline`, `provider:antigravity`, `provider:local`.

---

## 8. Milestone Strategy (M0 – M12)

```
M0: Architecture & Baseline Reconciled [CURRENT]
 └─► M1: Headless Forge Core (Electron Decoupling)
      └─► M2: Native Forge Agent Core 1.0
           └─► M3: Forge CLI 1.0 (Headless & Interactive TUI)
                └─► M4: State, Events, Artifacts & Evidence System
                     └─► M5: Independent Verification & Ground-Truth Reconciliation
                          └─► M6: Composable Lego Workflow Engine V2
                               └─► M7: Human Control & Interactive Sessions
                                    └─► M8: Universal Agent Runtime & Registry
                                         └─► M9: External Agent Adapters
                                              └─► M10: Workspace Isolation & Git Worktrees
                                                   └─► M11: Workflow DSL & Sub-Workflows
                                                        └─► M12: Production Hardening & Benchmarks
```

---

## 9. New Issues Required

To execute the program, the following concrete issues are established:

### Milestone 1: Headless Forge Core
- **`CORE-001`**: Extract `src/shared/domain` and `src/main/runtimes/orchestrator.ts` into headless Node.js modules runnable without Electron.
- **`CORE-002`**: Decouple SQLite storage from Electron `app.getPath('userData')` to support arbitrary `--data-dir`.
- **`CORE-003`**: Build headless configuration and environment loader.

### Milestone 2: Native Forge Agent Core 1.0
- **`AGENT-001`**: Implement prefix prompt caching static alignment in `agentTurn.ts`.
- **`AGENT-002`**: Implement `<persisted-output>` disk spilling in `agentLoop.ts` for tool results > 50KB.
- **`AGENT-003`**: Implement concurrent tool execution (`Promise.allSettled`).
- **`AGENT-004`**: Add local Ollama model auto-discovery and capability negotiation into `NativeAgentRuntime`.

### Milestone 3: Forge CLI 1.0
- **`CLI-001`**: Build `bin/forge.ts` command entrypoint (`forge run`, `forge verify`, `forge evidence`).
- **`CLI-002`**: Build interactive terminal TUI with React Ink.
- **`CLI-003`**: Implement headless NDJSON streaming for CI/CD with clean process exit codes.

### Milestone 4: State, Events, Artifacts & Evidence System
- **`STATE-001`**: Expand SQLite schema for structured artifact storage (`artifacts/`).
- **`ARTIFACT-001`**: Implement disk-spilled artifact store with byte-offset reading.
- **`EVIDENCE-001`**: Capture structured command execution evidence (exit code, stdout, stderr, durationMs).

### Milestone 5: Independent Verification & Ground-Truth Reconciliation
- **`VERIFY-001`**: Enhance `measureChange()` and `reconcileStep()` to handle untracked files, deletions, and file renames.
- **`VERIFY-002`**: Implement independent test and build runners that record authoritative `EvidenceArtifact` rows.
- **`VERIFY-003`**: Add adversarial test generator verifying boundary conditions.

### Milestone 6: Composable Lego Workflow Engine V2
- **`WORKFLOW-001`**: Implement DAG execution engine for `WorkflowTemplateV2` (`workflowGraph.ts`).
- **`WORKFLOW-002`**: Implement conditional edge routing and retry loops.
- **`WORKFLOW-003`**: Enable stage skipping, re-running, and pause/resume (resolves #164).

---

## 10. Issue Dependency Graph

```
                                 [M0: Reconciled Baseline]
                                             │
                                             ▼
                             [CORE-001: Headless Forge Core]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
         [AGENT-001: Native Agent Core]               [STATE-001: Event/Artifact Store]
                       │                                           │
                       ▼                                           ▼
            [CLI-001: Forge CLI 1.0]                  [VERIFY-001: Evidence Engine]
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                             ▼
                               [WORKFLOW-001: Lego DAG V2]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
        [HUMAN-001: Human Approval Gate]             [RUNTIME-001: Universal Runtime]
                       │                                           │
                       ▼                                           ▼
         [PARALLEL-001: Git Worktrees]               [ADAPTER-001: Generic CLI Adapter]
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                             ▼
                                [COMPOSE-001: Lego DSL]
```

---

## 11. Master Roadmap

```
PHASE 0: Baseline & Program Reconciled        [COMPLETE - 678 tests passing]
PHASE 1: Headless Forge Core Decoupling       [Weeks 1-2]
PHASE 2: Native Forge Agent Core 1.0          [Weeks 3-4]
PHASE 3: Forge CLI 1.0 (Headless & TUI)       [Weeks 5-6]
PHASE 4: State, Events & Evidence System      [Weeks 7-8]
PHASE 5: Independent Verification Engine      [Weeks 9-10]
PHASE 6: Composable Lego Workflow Engine V2   [Weeks 11-12]
PHASE 7: Human Control & Interactive Sessions [Weeks 13-14]
PHASE 8: Universal Agent Runtime & Registry   [Weeks 15-16]
PHASE 9: External Agent Adapters              [Weeks 17-18]
PHASE 10: Workspace Isolation & Git Worktrees [Weeks 19-20]
PHASE 11: Workflow DSL & Composition          [Weeks 21-22]
PHASE 12: Production Hardening & Benchmarks   [Weeks 23-24]
```

---

## 12. Master TODO Structure

Tracked canonically in [**docs/FORGE-MASTER-TODO.md**](file:///d:/my-quests/side-projects/Forge/docs/FORGE-MASTER-TODO.md):

```markdown
| ID | Issue | Area | Priority | Status | Depends On | Description | Evidence / Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| M0-001 | — | docs | P0 | DONE | — | Forensic audit & 678 tests recorded | FORGE-MASTER-ENGINEERING-PROGRAM.md |
| CORE-001 | NEW | engine | P0 | READY | M0-001 | Decouple domain/orchestrator from Electron | Vitest run in headless Node CLI |
| AGENT-001| NEW | agent | P0 | BLOCKED | CORE-001 | Align static prefix in agentTurn.ts | 90% prompt cache hit on Anthropic |
| CLI-001 | NEW | cli | P0 | BLOCKED | AGENT-001 | Build bin/forge.ts CLI entrypoint | forge --version / forge run |
```

---

## 13. Documentation Structure

```
docs/
  FORGE-MASTER-ENGINEERING-PROGRAM.md  <- Master engineering program & issue audit
  FORGE-MASTER-TODO.md                 <- Canonical cross-phase execution tracking
  ARCHITECTURE.md                      <- Macro system design & data flows
  DOMAIN.md                            <- Zod schemas, branded IDs, FSM transitions
  FORGE_RULES.md                       <- Ground-truth rules (Axioms A1-A6, Rules R1-R8)
  decisions/                           <- Architecture Decision Records (ADRs)
    ADR-001-agents-runtimes-accounts.md
    ADR-002-interactive-orchestration.md
    ADR-003-host-the-real-cli.md
    ADR-004-five-pillars-separation.md
    ADR-005-headless-core-cli-sharing.md
```

---

## 14. Architecture Decision Log (New ADRs)

### ADR-004: Permanent Separation of the Five Pillars
- **Context**: Risk of architecture collapsing into a Claude Code clone or merging Engine with Native Agent.
- **Decision**: Formally isolate: (1) Forge Engine, (2) Forge Agent, (3) Agent Runtime, (4) Agent Adapter, and (5) Workflow. The Engine must never name or import Forge Agent or any vendor adapter.
- **Consequences**: Adding new agent runtimes requires zero modifications to the core workflow engine.

### ADR-005: Headless Core & CLI / Desktop Code Sharing
- **Context**: Forge CLI and Electron Desktop must not duplicate business logic.
- **Decision**: Extract `src/main/runtimes/orchestrator.ts`, SQLite stores, and domain contracts into a headless service layer (`@forge/core`). Electron and CLI are pure transport consumers of this layer.
- **Consequences**: All bug fixes, verification checks, and state machines apply identically to terminal and GUI runs.

---

## 15. Research Matrix

```
+---------------------------------------------------------------------------------------------------------------+
| System        | Key Mechanism           | Verified Source Evidence   | Action for Forge       | Forge Strategy|
+---------------------------------------------------------------------------------------------------------------+
| Claude Code   | Prefix Prompt Caching   | src/query.ts:1-150         | [ADAPT]                | Static prefix |
| Claude Code   | Tool Output Disk Spill  | toolResultStorage.ts:1-80  | [ADAPT]                | Persist >50KB |
| Claude Code   | Adversarial Verification| verificationAgent.ts:1-120 | [ADAPT]                | Anti-rational |
| Cline         | Shadow Git Checkpoints  | checkpointManager.ts:1-200 | [ADAPT]                | refs/checkpoints|
| Kilo Code     | Worktree Subagents      | agent-manager.ts:55-74     | [ADAPT]                | Git worktrees |
| Kilo Code     | LanceDB Vector Indexing | indexing.ts:1-120          | [ADAPT / DEFER]        | Embeddings M11|
| OpenCode      | Fiber Tool Concurrency  | llm.ts:257-278             | [ADAPT]                | Promise.all   |
| OpenCode      | Live Steering           | llm.ts:390-413             | [ADAPT]                | steer vs queue|
+---------------------------------------------------------------------------------------------------------------+
```

---

## 16. Benchmark Plan

We formally reject simulated/predicted numerical leaderboards as facts.

In **Milestone 12**, Forge will execute an empirical, reproducible benchmark measuring:
1. **Task Completion Rate**: Success across 20 real-world repository tasks.
2. **Physical Diff Accuracy**: 100% required (zero hallucinated diffs permitted).
3. **Verification Precision**: Ratio of caught regressions vs false positives.
4. **Token Economics**: Input token cache reuse rate (measuring static prefix KV cache hits).
5. **Wall-Clock Latency**: Time to completion across single-agent and multi-agent runs.

---

## 17. Validation Strategy & Phase Gates

Every milestone must satisfy its phase gate before downstream work begins:
- **Gate M1 (Headless Core)**: Core Engine and Domain tests run and pass in a pure Node.js CLI environment with zero Electron imports.
- **Gate M2 (Native Agent)**: Forge Native Agent autonomously clones a test repo, edits code, runs tests, and completes a task using only a local Ollama model.
- **Gate M3 (Forge CLI)**: `forge run "prompt"` executes from terminal, streams NDJSON events, and exits with code 0 on verified task success.
- **Gate M5 (Verification)**: `measureChange()` and `reconcileStep()` successfully halt on intentional out-of-scope edits in an automated integration test.

---

## 18. First Vertical Slice: Headless Native Forge Agent

To validate the architecture with minimal code churn, we build **Vertical Slice #1**:

```
[Terminal: forge run "Inspect this repo and explain X"]
                           │
                           ▼
                 [Headless Forge Core]
                           │
                           ▼
                 [Forge Native Agent]
                           │
                 [Bounded ReAct Loop]
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
          [Local Model/API]   [15 Sandboxed Tools]
                 │                   │
                 └─────────┬─────────┘
                           │
                           ▼
             [Physical Git Diff Verification]
                           │
                           ▼
                [Terminal Result Output]
```

### Scope of Slice #1:
- `CORE-001`: Decouple domain and orchestrator from Electron.
- `AGENT-001`: Align static prefix in `agentTurn.ts`.
- `CLI-001`: Build standalone `bin/forge.ts` running tasks and streaming results.
- `EVIDENCE-001`: Output verified physical diff evidence on completion.

---

## 19. Risks & Mitigations

```
+---------------------------------------------------------------------------------------------------------------+
| Risk                                      | Impact | Mitigation                                               |
+---------------------------------------------------------------------------------------------------------------+
| Windows file locking (EBUSY) in git tests | Medium | Fix in M0-002 (#178) by enforcing unique sandbox dirs.   |
| Prompt cache invalidation across turns    | High   | Enforce bitwise identical static prefix in agentTurn.ts. |
| Model describes edit without calling tool | High   | Already mitigated in agentLoop.ts via requireOneOf nudge.|
| Large tool output blows context window    | High   | Mitigate in AGENT-002 via disk-spilled artifacts (>50KB).|
+---------------------------------------------------------------------------------------------------------------+
```

---

## 20. Open Questions (Resolved)

1. *Should Forge Agent clone Claude Code?* **NO.** Forge Agent is an independent worker optimized for local models, safety, and Forge's evidence contracts.
2. *Should Forge Engine depend on Forge Agent?* **NO.** Forge Agent is one worker; Claude Code is one worker; Antigravity is one worker. The Engine orchestrates them.
3. *Should Workflow #001 (Claude -> Antigravity -> Claude) be hardcoded?* **NO.** It is merely Template #001 in a generic Lego DAG system.
4. *Where does project tracking live?* **Directly in GitHub issues and [docs/FORGE-MASTER-TODO.md](file:///d:/my-quests/side-projects/Forge/docs/FORGE-MASTER-TODO.md).**

---

## 21. Final Recommendation: The Concrete Next Action

```
WHAT WE SHOULD BUILD FIRST:
  -> Vertical Slice #1: Headless Core Decoupling (CORE-001) + Forge CLI Entrypoint (CLI-001).

WHAT WE SHOULD NOT BUILD YET:
  -> Do NOT build complex multi-agent worktrees or external adapters until Slice #1 is verified.
  -> Do NOT build terminal TUI styling before the headless CLI engine contract is solid.

WHAT EXISTING WORK WE SHOULD PRESERVE:
  -> Preserve transitions.ts (18 states), orchestrator.ts (reconciliation engine), and agentLoop.ts.

WHAT EXISTING ISSUES SHOULD CHANGE:
  -> Close #64 (obsolete).
  -> Merge #161 into #171.
  -> Promote #183, #174, #171, #164, and #163 to core milestone issues.

THE CRITICAL PATH:
  M0 Baseline (Done) -> M1 Headless Core (CORE-001) -> M2 Native Agent (AGENT-001) -> M3 CLI (CLI-001).
```

---

### Suggested Immediate Next Step

You can now review [**docs/FORGE-MASTER-ENGINEERING-PROGRAM.md**](file:///d:/my-quests/side-projects/Forge/docs/FORGE-MASTER-ENGINEERING-PROGRAM.md) and [**docs/FORGE-MASTER-TODO.md**](file:///d:/my-quests/side-projects/Forge/docs/FORGE-MASTER-TODO.md). 

When you are ready, we will immediately execute **Vertical Slice #1: Step 1 (`CORE-001`)** by extracting the headless Forge Core and creating the standalone CLI entrypoint (`bin/forge.ts`).

---
