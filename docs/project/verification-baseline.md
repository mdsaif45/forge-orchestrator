# Verification Baseline & Metrics

**Status:** IMPLEMENTED  
**Authority:** Physical Implementation Truth  
**Last Updated:** 2026-09-21  
**Baseline Commit:** `1dfb444` (`origin/main`)  

---

## 1. Test Suite Verification Metrics

All metrics recorded directly from Vitest execution against `origin/main` commit `1dfb444` on a Windows 11 host (Node v22.20.0):

```
Test Files:  96 passed | 2 skipped (98 total)
Tests:       1,125 passed | 3 skipped (1,128 total)
Duration:    49.05 seconds
Transform:   25.23 seconds
Setup:       7.18 seconds
Import:      72.21 seconds
Environment: 36.77 seconds
```

---

## 2. Toolchain Gate Results

| Gate / Command | Script | Target | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Unit & Integration Tests** | `npm test` | `vitest run` | **PASS (100%)** | 1,125 passed, 0 failed |
| **Code Formatting** | `npm run format:check` | `prettier --check .` | **PASS (100%)** | All files use Prettier style |
| **ESLint Static Analysis** | `npm run lint` | `eslint .` | **PASS (100%)** | Zero lint errors or warnings |
| **TypeScript Typecheck** | `npm run typecheck` | `tsc` (node, web, test) | **PASS (100%)** | Zero type errors across 3 targets |
| **State Diagram Invariant** | `npm run check:docs` | `generate-state-diagram.mjs` | **PASS (100%)** | `docs/DOMAIN.md: state diagram is up to date` |
| **IPC Router Parity** | `npm run check:router` | `scripts/router-check.mjs` | **PASS (100%)** | All IPC channels mapped to handlers |
| **Preload Smoke Test** | `npm run smoke` | `scripts/smoke.cjs` | **PASS (100%)** | ContextBridge methods match contract |

---

## 3. Continuous Integration Matrix

Forge enforces five mandatory status checks on all pull requests targeting `main`:

```
┌────────────────────────────────────────────────────────────┐
│                    GITHUB ACTIONS CI                       │
│                                                            │
│  Job 1: Format & Lint       prettier + eslint              │
│  Job 2: Typecheck           tsc node, web, test            │
│  Job 3: Test Matrix (Linux) Node 22 on ubuntu-latest       │
│  Job 4: Test Matrix (Win)   Node 22 on windows-latest      │
│  Job 5: Package Smoke       Electron bundle preflight      │
└────────────────────────────────────────────────────────────┘
```

All five checks must report green before branch merge protection allows PR merge.
