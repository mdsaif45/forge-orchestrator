# Contract: Verification Criteria & Evaluator Semantics

**Status:** FROZEN  
**Authority:** Canonical Verification Contract  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [evidence-and-verification.md](../evidence-and-verification.md)  
**Related Implementation:** `src/shared/domain/completion.ts`, `src/main/evidence/verifier.ts`  

---

## 1. Purpose

This contract defines the schemas, evaluator precedence, and verdict calculation rules for the objective completion criteria that govern task and step verification in Forge.

---

## 2. The Seven Criteria Kinds

Forge recognizes seven formal criteria kinds defined in `src/shared/domain/enums.ts` (`criterionKindSchema`):

```typescript
export const criterionKindSchema = z.enum([
  'build',
  'tests',
  'diff-scope',
  'no-assumptions',
  'reviewer-verdict',
  'file-exists',
  'custom-command',
]);
export type CriterionKind = z.infer<typeof criterionKindSchema>;
```

### Baseline Schema (`src/shared/domain/task.ts`)
In the baseline implementation (`main` @ `1dfb444`), completion criteria are defined as:

```typescript
export const completionCriterionSchema = z.strictObject({
  kind: criterionKindSchema,
  description: z.string().min(1),
  params: z.record(z.string(), z.unknown()).readonly(),
});
export type CompletionCriterion = z.infer<typeof completionCriterionSchema>;
```

Each criterion is evaluated by `evaluate(criterion, input)` in `src/shared/domain/completion.ts`, producing an authoritative `CriterionResult`:

```typescript
export interface CriterionResult {
  readonly kind: CriterionKind;
  readonly description: string;
  readonly verdict: 'pass' | 'fail' | 'unknown';
  readonly reason: string;
  readonly evidenceId: string | null;
}
```

### Schema Consistency & Clarification
Both `main` and branch `feat/slice-2-observability-criteria` (PR #204) use the canonical `completionCriterionSchema` with `{ kind, description, params: Record<string, unknown> }`. Speculative typed interface hierarchies (`BuildCriterion`, `DiffScopeCriterion`, etc.) from early documentation drafts are not implemented.

---

## 3. Evaluation Rules & Precedence

Each criterion produces a verdict:
- `pass`: Criterion satisfied with physical evidence.
- `fail`: Criterion breached (exit code != 0, scope violation, missing file).
- `unknown`: Evaluation could not be performed (e.g. missing test command or evidence).

### Precedence Rule: Fail Outranks Unknown
When aggregating criteria into an overall step verdict in `assessCompletion`:
1. If **any** criterion has `verdict === 'fail'`, the overall verdict is `fail`.
2. If any criterion has `verdict === 'unknown'` and none failed, the overall verdict is `unknown`.
3. The overall verdict is `pass` **if and only if** every criterion has `verdict === 'pass'`.

---

## 4. Verification Evidence

- `src/main/evidence/verifier.test.ts`: Verifies build/test runner execution, exit code assertions, and output logging.
- `src/shared/domain/completion.test.ts`: Unit tests verifying the aggregation logic, ordering precedence, and evaluation rules (25 tests on `main`).

---

## 5. Amendment History

| Amendment | Type | Date | Reason & Evidence |
| :--- | :--- | :--- | :--- |
| **AMD-CRIT-001** | CORRECTION | 2026-09-22 | Corrected `CriterionKind` values from camelCase speculative names (`diffScope`, `noUntracked`, etc.) to canonical `criterionKindSchema` enum (`'build'`, `'tests'`, `'diff-scope'`, `'no-assumptions'`, `'reviewer-verdict'`, `'file-exists'`, `'custom-command'`) in `src/shared/domain/enums.ts`. |
| **AMD-CRIT-002** | CLARIFICATION | 2026-09-22 | Clarified that baseline `1dfb444` implements `completionCriterionSchema` with `{ kind, description, params }` in `src/shared/domain/task.ts` and `assessCompletion` in `src/shared/domain/completion.ts`. |
| **AMD-CRIT-003** | CORRECTION | 2026-09-25 | Corrected erratum attributing a speculative discriminated interface hierarchy (`BuildCriterion`, `DiffScopeCriterion`, etc.) to PR #204. Verified that PR #204 retains canonical `{ kind, description, params }` schema. |
