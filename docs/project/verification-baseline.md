# Verification Baseline & Metrics

**Status:** IMPLEMENTED
**Authority:** Implementation truth (see [documentation-policy.md](../meta/documentation-policy.md))
**Last Updated:** 2026-09-26
**Baseline Commit:** `7b91d670295436fcf138ca48cb4ef6edfa6068f8` (`origin/main`, PR #207 merged)  
**Active Working State:** `feat/verify-003-adversarial-verifier`  
**Related:** [current-state.md](current-state.md)  

Every number here was produced by running the command shown on the physical repository.
Nothing on this page is estimated. When a figure cannot be measured, it is marked `UNKNOWN`
rather than guessed.

---

## 1. Measurement environment

Metrics in §2 and §3 were measured locally against the current repository state.
This is **not** the CI environment, and the two differ in Node major version — recorded
here because a green local run on a different runtime is weaker evidence than a green CI run.

| Property | Value |
| :--- | :--- |
| Host OS | Windows 11 |
| Node (local measurement) | v24.20.0 |
| Node (CI, authoritative) | 22 — see §4 |
| Package version | `0.3.0-alpha.1` |
| Measured Main SHA | `7b91d670295436fcf138ca48cb4ef6edfa6068f8` |
| Measured Branch | `feat/verify-003-adversarial-verifier` |

---

## 2. Test suite metrics

Command: `npx vitest run`

```
Test Files   99 passed | 2 skipped (101)
Tests      1173 passed | 3 skipped (1176)
Duration     ~59 s
```

Per-file assertion counts cited in [current-state.md](current-state.md) were extracted
from `vitest run` at this baseline.

---

## 3. Local gate results

Each gate below was executed at the baseline commit on the host described in §1.

| Gate | Command | Result |
| :--- | :--- | :--- |
| Formatting | `npm run format:check` | PASS — all matched files use Prettier style |
| Lint | `npm run lint` | PASS — zero errors, zero warnings across repository |
| Typecheck (node, web, test) | `npm run typecheck` | PASS — zero errors across all three tsconfig projects |
| Unit & integration tests | `npm test` | PASS — 1173 passed, 0 failed, 3 skipped across 99 test files |
| State diagram invariant | `npm run check:docs` | PASS — `docs/DOMAIN.md: state diagram is up to date` |
| Build | `npm run build` | NOT RUN in this documentation pass |
| IPC router parity | `npm run check:router` | NOT RUN in this documentation pass |
| Preload smoke | `npm run smoke` | NOT RUN in this documentation pass |
| Design system | `npm run check:ui` | NOT RUN in this documentation pass |
| End-to-end | `npm run test:e2e` | NOT RUN in this documentation pass |

Gates marked `NOT RUN` require an Electron binary and a display, which this
documentation-only change does not affect. They run in CI on every pull request (§4).
They are recorded as not run rather than assumed green.

---

## 4. Continuous integration

Source of truth: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). CI
defines **three** jobs, all on Node 22.

```
CI (push to main · pull_request · workflow_dispatch)
│
├── static     ubuntu-latest   format:check → lint → typecheck → test → build → check:router
│
├── app        ubuntu-latest   build → smoke → check:ui → test:e2e   (xvfb, Electron binary)
│              plus: chrome-sandbox ownership fix, so process isolation stays ON
│
└── windows    windows-latest  build → smoke → check:ui → test:e2e
```

Notes measured from the workflow file:

- `.npmrc` sets `ignore-scripts`, so the `static` job installs no native binaries and
  never fetches Electron. It builds `node-pty` explicitly via `npm run setup:pty`
  because there is no linux-x64 prebuild.
- The `app` job repairs `chrome-sandbox` ownership (`root:root`, mode `4755`) rather
  than passing `--no-sandbox`, which would disable the very isolation the smoke checks
  verify.
- Concurrency is grouped per ref with `cancel-in-progress: true`.

> An earlier revision of this document described a five-job CI matrix with a separate
> "Format & Lint" and "Typecheck" job. That did not match `ci.yml` and is corrected
> here.

---

## 5. Branch protection

`main` is protected and rejects direct pushes; all work lands through pull requests.
The exact set of required status checks configured on GitHub was **not** read as part
of this documentation pass and is recorded as `UNKNOWN` rather than inferred from the
job list above.

---

## 6. Benchmarks

No performance benchmarks are currently recorded in the repository. `UNKNOWN` — this
is a genuine gap, not an omission from this page.

---

## 7. Historical Baselines

| Baseline Ref | Date | Commit SHA | Test Files | Passed Tests | Skipped Tests | Context |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PR #203 Baseline | 2026-09-22 | `1dfb444` | 96 passed | 1,125 passed | 3 skipped | State & persistence (STATE-001) merged to `main` |
| PR #204 Baseline | 2026-09-25 | `5987501` | 97 passed | 1,142 passed | 3 skipped | Criteria evaluation (CRIT-001) merged to `main` |

