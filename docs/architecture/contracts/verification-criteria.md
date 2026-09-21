# Contract: Verification Criteria & Evaluator Semantics

**Status:** FROZEN  
**Authority:** Canonical Verification Contract  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [evidence-and-verification.md](../evidence-and-verification.md)  
**Related Implementation:** `src/shared/domain/criteria.ts`, `src/main/evidence/verifier.ts`  

---

## 1. Purpose

This contract defines the schemas, evaluator precedence, and verdict calculation rules for the objective completion criteria that govern task and step verification in Forge.

---

## 2. The Seven Criteria Kinds

Forge recognizes seven formal criteria kinds:

```typescript
export type CriterionKind =
  | 'build'
  | 'test'
  | 'diffScope'
  | 'noUntracked'
  | 'filePresence'
  | 'branchCheck'
  | 'custom';
```

### Schema Definitions
```typescript
export interface CriterionBase {
  readonly id: string;
  readonly description?: string;
  readonly optional?: boolean;
}

export interface BuildCriterion extends CriterionBase {
  readonly kind: 'build';
  readonly command?: string; // Overrides project default buildCmd
}

export interface TestCriterion extends CriterionBase {
  readonly kind: 'test';
  readonly command?: string; // Overrides project default testCmd
}

export interface DiffScopeCriterion extends CriterionBase {
  readonly kind: 'diffScope';
  readonly allowedPaths: string[];
}

export interface NoUntrackedCriterion extends CriterionBase {
  readonly kind: 'noUntracked';
}

export interface FilePresenceCriterion extends CriterionBase {
  readonly kind: 'filePresence';
  readonly path: string;
  readonly minBytes?: number;
}

export interface BranchCheckCriterion extends CriterionBase {
  readonly kind: 'branchCheck';
  readonly expectedBranch: string;
}

export interface CustomCriterion extends CriterionBase {
  readonly kind: 'custom';
  readonly script: string;
  readonly expectedExitCode?: number;
}
```

---

## 3. Evaluation Rules & Precedence

Each criterion produces a `CriterionVerdict`:
- `pass`: Criterion satisfied with physical evidence.
- `fail`: Criterion breached (exit code != 0, scope violation, missing file).
- `unknown`: Evaluation could not be performed (e.g. missing test command).

### Precedence Rule: Fail Outranks Unknown
When aggregating criteria into an overall step verdict:
1. If **any** non-optional criterion has `verdict === 'fail'`, the overall verdict is `fail`.
2. If any non-optional criterion has `verdict === 'unknown'` and none failed, the overall verdict is `unknown`.
3. The overall verdict is `pass` **if and only if** every non-optional criterion has `verdict === 'pass'`.

---

## 4. Verification Evidence

- `src/main/evidence/verifier.test.ts`: Verifies build/test runner execution, exit code assertions, and output logging.
- `src/shared/domain/criteria.test.ts`: Unit tests verifying the aggregation logic, ordering precedence, and optional criterion handling.
