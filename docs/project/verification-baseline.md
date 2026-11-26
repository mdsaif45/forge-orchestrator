# Verification Baseline & Metrics

**Status:** IMPLEMENTED
**Authority:** Implementation truth (see [documentation-policy.md](../meta/documentation-policy.md))
**Last Updated:** 2026-11-26
**Baseline Commit:** `cfb0f4c` (`origin/main`, PR #488 merged — M0–M16 complete)
**Active Working State:** `docs/sync-m12-m16-progress-and-monorepo-truth`
**Related:** [current-state.md](current-state.md)

Every metric below was produced directly from repository commands run on the active host. No estimates or extrapolated figures are included.

---

## 1. Measurement Environment

| Property | Value |
| :--- | :--- |
| Host OS | Windows 11 |
| Node (local measurement) | v24.20.0 |
| Node (CI, authoritative) | 22 — see §4 |
| Package version | `0.3.0-alpha.1` |
| Measured Main SHA | `cfb0f4c` (PR #488 merged) |

---

## 2. Test Suite Metrics

Command: `npm test` (`vitest run`) across all `@forge/*` workspaces at `main` @ `cfb0f4c`:

- **Full-suite parallel run:** `300 passed | 2 skipped` out of `303` test files (`2,848 passed | 3 skipped | 1 failed` out of `2,852` tests), where the 1 failure was a parallel load timing race in `packages/forge-runtimes/src/process/process.test.ts` (`LOG-002` log rotation).
- **Focused re-run of `packages/forge-runtimes/src/process/process.test.ts`:** `1 passed (1)` file, `42 passed (42)` tests (`Duration: 26.74s`).

---

## 3. Local Gate Results

| Gate | Command | Result |
| :--- | :--- | :--- |
| Formatting (modified docs) | `npx prettier --check README.md "docs/**/*.md"` | Run in docs sync verification pass |
| Lint | `npx eslint packages/` | PASS — zero errors, zero warnings across `packages/` |
| Typecheck (node, web, test) | `npm run typecheck` | PASS — zero errors across `tsconfig.{node,web,test}.json` |
| Circular dependencies | `npm run check:cycles` | PASS — `0` circular dependencies across `450` production source files |
| IPC router parity | `npm run check:router` | PASS — `7/7` assertions passed |
| State diagram invariant | `npm run check:docs` | PASS — `docs/DOMAIN.md: state diagram is up to date` |
| Process suite re-check | `npx vitest run packages/forge-runtimes/src/process/process.test.ts` | PASS — `42/42` tests passed |
| Build / Smoke / UI / E2E | `npm run build`, `smoke`, `check:ui`, `test:e2e` | NOT RE-RUN in docs-only pass; executed on CI |

---

## 4. Continuous Integration

Source of truth: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). CI defines **three** jobs on Node 22:

```
CI (push to main · pull_request · workflow_dispatch)
│
├── static     ubuntu-latest   format:check → lint → typecheck → test → build → check:router
│
├── app        ubuntu-latest   build → smoke → check:ui → test:e2e   (xvfb, Electron binary)
│
└── windows    windows-latest  build → smoke → check:ui → test:e2e
```

---

## 5. Branch Protection

`main` is protected and requires passing CI status checks via pull requests.

---

## 6. Historical Baselines

| Baseline Ref | Date | Commit SHA | Test Files | Passed Tests | Skipped Tests | Context |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PR #203 Baseline | 2026-09-22 | `1dfb444` | 96 passed | 1,125 passed | 3 skipped | State & persistence (`STATE-001`) merged to `main` |
| PR #204 Baseline | 2026-09-25 | `5987501` | 97 passed | 1,142 passed | 3 skipped | Criteria evaluation (`CRIT-001`) merged to `main` |
| PR #208 Baseline | 2026-09-28 | `391630e` | 99 passed | 1,173 passed | 3 skipped | Adversarial verifier (`VERIFY-003`) merged to `main` |
| PR #221 Baseline | 2026-10-15 | `6f7df99` | 108 passed | 1,518 passed | 3 skipped | Artifact lineage recovery (`WORK-003`) merged to `main` |
| PR #227 Baseline | 2026-10-20 | `07d3c4b` | 115 passed | 1,667 passed | 3 skipped | Gate authorization (`Slice 5B-1C A`) merged to `main` |
| PR #488 Baseline (`main`) | 2026-11-26 | `cfb0f4c` | 300 passed (1 race in parallel, passed isolated) | 2,848+ passed | 3 skipped | M0–M16 complete (`@forge/*` monorepo, DSL, canvas, cloud sync) |
