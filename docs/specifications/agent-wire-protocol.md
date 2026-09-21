# Specification: Agent Wire Protocol & Report Format

**Status:** IMPLEMENTED  
**Authority:** Normative Specification  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Contract:** [execution-protocol.md](../architecture/contracts/execution-protocol.md)  
**Related Implementation:** `src/shared/domain/protocol.ts`, `src/main/runtimes/exchange.ts`  

---

## 1. Overview

This specification defines the communication protocol between Forge and external agent runtimes (such as Claude Code or custom LLM runners) that emit structured reports in prose output streams.

---

## 2. The `FORGE_REPORT` Specification

At the conclusion of each execution turn, an agent runtime must output a markdown block demarcated by ````FORGE_REPORT```:

````markdown
```FORGE_REPORT
status: completed | blocked | question
summary: Detailed human-readable explanation of actions taken
filesChanged:
  - relative/path/to/modified-file.ts
commandsRun:
  - npm run test
testsRun: true
openQuestions: []
assumptions: []
```
````

### Field Definitions

1. **`status`** (Required):
   - `completed`: The agent finished all assigned instructions within scope.
   - `blocked`: The agent encountered an insurmountable technical barrier.
   - `question`: The agent requires human guidance on an ambiguous requirement.
2. **`summary`** (Required): High-level description of changes made and rationales.
3. **`filesChanged`** (Required): List of repository-relative paths modified during this turn.
4. **`commandsRun`** (Required): List of bash/shell commands executed during this turn.
5. **`testsRun`** (Required): Boolean (`true` | `false`) declaring whether the agent executed tests.
6. **`openQuestions`** (Optional): Structured questions adhering to Rule R2.
7. **`assumptions`** (Mandatory Empty): Must be an empty list (`[]`).

---

## 3. Parser & Fallback Rules

- **Fence Parsing**: The parser extracts the content between the ````FORGE_REPORT``` and closing ```` ``` ```` delimiters.
- **Prose Fallback Rejection**: If an agent outputs prose with no `FORGE_REPORT` block, Forge issues a correction prompt. If the second response is still malformed, the step fails immediately with `failure: 'protocol'`.
- **Zero Fabrication**: Forge never synthesizes a fake report from unstructured agent text (Axiom A3).
