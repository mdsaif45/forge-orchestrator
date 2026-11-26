# Verification Baseline & Metrics

**Status:** IMPLEMENTED
**Authority:** Implementation truth (see [documentation-policy.md](../meta/documentation-policy.md))
**Last Updated:** 2026-11-26
**Baseline Commit:** `34b85d9` (`origin/main`, PR #503 merged — M17 Phases 1A–4 complete)
**Active Working State:** `feat/m17-phase-5-migration-verification-docs` (M17 Phase 5 — `#497`)
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
| Measured Main SHA | `34b85d9` (PR #503 merged — M17 Phase 4 complete) |

---

## 2. Test Suite Metrics

Command: `npx vitest run --maxWorkers=2` across all `@forge/*` workspaces at `main` @ `34b85d9` (with M17 Phase 4 changes):

- **Full-suite bounded-worker run:** `310 passed | 2 skipped` out of `312` test files (`2,871 passed | 3 skipped` out of `2,874` tests), zero failures (including `@forge/ui` primitives/tokens/icons, `StatusStrip.test.tsx`, `ThreadContainer.test.tsx`, and `RightOverviewPanel.test.tsx`).

---

## 3. Local Gate Results

| Gate | Command | Result |
| :--- | :--- | :--- |
| Formatting | `npm run format:check` | PASS — Prettier verified across repository |
| Lint | `npx eslint packages/forge-core packages/forge-shared packages/forge-ui packages/forge-desktop scripts/ui-check.cjs scripts/smoke.cjs` | PASS — zero errors, zero warnings |
| Typecheck (node, web, test) | `npm run typecheck` | PASS — zero errors across `tsconfig.{node,web,test}.json` |
| Circular dependencies | `npm run check:cycles` | PASS — `0` circular dependencies across `498` production source files |
| Release bundle & no-dev gate | `npm run build && npm run check:no-dev-code` | PASS — `3` assets checked |
| UI & theme telemetry | `npm run check:ui` | PASS — `19/19` assertions passed |
| Electron security & bridge smoke | `npm run smoke` | PASS — `9/9` assertions passed |
| IPC router parity | `npm run check:router` | PASS — `7/7` assertions passed |
| State diagram invariant | `npm run check:docs` | PASS — `docs/DOMAIN.md: state diagram is up to date` |
| Playwright Electron E2E | `npm run test:e2e` | PASS — `13/13` tests passed |

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
| PR #503 Baseline (`main`) | 2026-11-26 | `34b85d9` | 310 passed (`--maxWorkers=2`) | 2,871 passed | 3 skipped | M17 Phases 1A–4 complete (`@forge/ui`, unified thread & drawer) |
