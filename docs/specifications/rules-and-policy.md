# Specification: Policy Engine & Ruleset Hierarchy

**Status:** IMPLEMENTED  
**Authority:** Normative Specification  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [security-and-trust.md](../architecture/security-and-trust.md)  
**Canonical Ruleset:** [`docs/FORGE_RULES.md`](../FORGE_RULES.md)  
**Related Implementation:** `src/shared/domain/policyEngine.ts`, `src/shared/domain/forgeRules.ts`  

---

## 1. Scope Inheritance Hierarchy

Rules govern agent behavior and execution constraints across six nested scopes:

```
Global ──> Workspace ──> Project ──> Workflow ──> Agent ──> Task
```

### Inheritance Invariants
1. **Most-Specific Scope Wins**: If a more specific scope (e.g. `Project` or `Task`) defines a rule with the same `key` as a broader scope (e.g. `Global`), the more specific value overrides the broader rule.
2. **Defaults Are Permanent**: A project rule may override a default rule's value, but the default cannot be dropped entirely. If an override is deleted, the system rule is restored immediately.
3. **Defaults are Code Constants**: The eight core rules are compiled TypeScript constants in `src/shared/domain/forgeRules.ts`, verified against `docs/FORGE_RULES.md`. They do not depend on database seed state.

---

## 2. The Canonical Ruleset (R1 – R8)

The authoritative global rules are defined in [`docs/FORGE_RULES.md`](../FORGE_RULES.md). Every agent running in Forge inherits these rules:

- **R1 — Never guess**: Do not assume implementation-critical facts. Probe repo, config, and history. If still ambiguous, raise an `OpenQuestion` and stop.
- **R2 — Probe before asking**: Questions must include an evidence trail (`whyUndetermined`, `evidenceInspected`, `options`, `recommendation`).
- **R3 — Respect locked decisions**: `LOCKED` decisions are binding. Modifying them requires an approved Architectural Change Request.
- **R4 — Stay in scope**: Modify only paths matching `allowedPaths`. Never touch lockfiles, migrations, or unrelated modules without explicit authorization.
- **R5 — Report facts, structured**: Reply with a valid `FORGE_REPORT` block. `assumptions` must be empty.
- **R6 — Verification is not yours to declare**: The agent does not declare completion; Forge measures diffs and executes tests independently.
- **R7 — Never exfiltrate secrets**: Never read, echo, log, or transmit `.env` files, keys, or credentials.
- **R8 — Stop cleanly**: When halting or blocked, leave the working tree in a coherent state.

---

## 3. Effective Policy Resolution

`PolicyEngine.resolvePolicy(context)` merges rules across scopes:

```typescript
export interface EffectivePolicy {
  readonly rules: Record<string, ResolvedRule>;
  readonly allowedPaths: string[];
  readonly forbiddenPaths: string[];
  readonly bannedCommands: string[];
  readonly maxIterations: number;
}
```

- When multiple rules define path patterns, `forbiddenPaths` outranks `allowedPaths`.
- Any command matching `bannedCommands` is blocked before process execution.

---

## 4. Verification Evidence

- `src/main/projects/projects.test.ts`: Verifies rule persistence, scope overriding, restoration of defaults, and heading synchronization with `docs/FORGE_RULES.md`.
- `src/shared/domain/policy.test.ts`: Verifies scope inheritance and resolution ordering.
- `src/shared/domain/policyEngine.test.ts`: Verifies effective policy evaluation against simulated tool calls.
