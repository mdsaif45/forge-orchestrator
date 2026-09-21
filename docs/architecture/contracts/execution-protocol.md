# Contract: Execution Protocol & Agent Wire Interface

**Status:** FROZEN  
**Authority:** Canonical Protocol Specification  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [agent-runtime.md](../agent-runtime.md), [execution-model.md](../execution-model.md)  
**Related Specifications:** `docs/FORGE_RULES.md`  
**Related Implementation:** `src/shared/domain/protocol.ts`, `src/main/core/taskRunner.ts`  

---

## 1. Purpose

This contract specifies the typed interface between the Forge execution kernel (`ForgeCore`, `TaskRunner`) and any implementation of `IAgentRuntime`. It defines the input context delivered to the agent and the structured report format emitted by the agent.

---

## 2. Terminology

- **Task Input**: The immutable context bundle provided to an agent runtime at turn start.
- **Task Output**: The structured result object returned by the agent upon completion.
- **`FORGE_REPORT`**: The structured text block emitted by CLI agents in standard output.
- **Assumption Violation**: Any admitted assumption in an agent report; immediately disqualifies the run.

---

## 3. Schemas & Types

### 1. `AgentTaskInput`
```typescript
export interface AgentTaskInput {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly role: 'planner' | 'implementer' | 'reviewer' | 'tester' | 'security-reviewer' | 'system' | 'user';
  readonly prompt: string;
  readonly allowedPaths: string[];
  readonly workspaceRoot: string;
  readonly baseSha: string;
  readonly contextFiles?: Array<{
    path: string;
    content: string;
  }>;
  readonly rules?: string[];
  readonly timeoutMs?: number;
}
```

### 2. `AgentTaskOutput`
```typescript
export interface AgentTaskOutput {
  readonly status: 'completed' | 'blocked' | 'question' | 'error';
  readonly summary: string;
  readonly filesChanged: string[];
  readonly commandsRun: string[];
  readonly testsRun: boolean;
  readonly openQuestions: Array<{
    question: string;
    whyUndetermined: string;
    evidenceInspected: string[];
    options: string[];
    recommendation: string;
  }>;
  readonly assumptions: string[]; // MUST BE EMPTY
  readonly rawOutput?: string;
  readonly exitCode?: number;
}
```

### 3. Canonical `FORGE_REPORT` Wire Block
When driving an external CLI agent, the agent is instructed to conclude its final turn with a formatted markdown block:

```markdown
```FORGE_REPORT
status: completed | blocked | question
summary: concise description of changes made
filesChanged:
  - path/to/file1.ts
  - path/to/file2.ts
commandsRun:
  - npm test
testsRun: true
openQuestions: []
assumptions: []
```
```

---

## 4. Invariants & Failure Semantics

1. **Assumptions Disqualification**: The `assumptions` array **must be empty**. If an agent admits to making an assumption, Forge rejects the report and halts the run with `HALTED_POLICY` (enforcing Rule R1 and Axiom A2).
2. **Missing Fences**: If an agent replies with prose and fails to emit a valid `FORGE_REPORT` block after two consecutive turns, the step fails with `failure: 'protocol'`. Forge never synthesizes a fake success report.
3. **Physical Reconciliation**: The `filesChanged` array is treated as a claim. Forge runs `git diff` to measure the physical change set. Any path modified on disk but omitted from `filesChanged` is logged as a discrepancy. Any modified path outside `allowedPaths` halts the run with `HALTED_POLICY`.

---

## 5. Verification Evidence

- `src/main/core/taskRunner.test.ts`: Verifies `executeDirectTask` produces conforming outputs and handles discrepancies.
- `src/shared/domain/protocol.test.ts`: Tests `FORGE_REPORT` parser edge cases, invalid schemas, and assumption disqualification.
- `src/main/runtimes/exchange.test.ts`: Tests rejection of synthesized reports and malformed replies.
