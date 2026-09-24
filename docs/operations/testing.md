# Testing Strategy & Quality Gates

**Status:** IMPLEMENTED  
**Authority:** Operational Testing Guide  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444` (1,125 passing tests)  

---

## 1. Testing Philosophy

Forge enforces an evidence-based testing philosophy:
1. **Physical Git Invariants**: Tests create real, temporary git repositories on disk, initialize commits, create worktrees, and run real `git diff` commands. We do not mock git.
2. **Deterministic Timeouts**: Process termination tests assert that child process trees are killed cleanly within configured timeout windows.
3. **Zero Test Regressions**: All 1,125 tests must report green in CI. No tests may be weakened, commented out, or skipped without an approved ADR.

---

## 2. Test Suites & Commands

### Running Tests with Vitest
```bash
# Run all 96 test files once
npm test

# Run tests in watch mode during development
npm run test:watch

# Run a specific test suite
npx vitest run src/main/core/taskRunner.test.ts

# Run with test coverage
npm run test:coverage
```

### End-to-End Testing
```bash
# Run Playwright end-to-end tests
npm run test:e2e
```

---

## 3. Specialized Gate Checks

| Script | What It Proves | Failure Implication |
| :--- | :--- | :--- |
| `npm run check:docs` | Verifies `docs/DOMAIN.md` state diagram matches `src/shared/domain/transitions.ts`. | State machine diagram is out of sync with code. Run `npm run docs:diagram`. |
| `npm run check:router` | Compiles IPC router and verifies every channel has a typed handler and preload method. | Missing IPC handler or dead IPC channel. |
| `npm run check:no-dev-code`| Asserts no debug artifacts or temporary bypass flags exist in production bundle. | Dev flags accidentally committed. |
| `npm run smoke` | Boots Electron in headless smoke mode to test native addon initialization. | Native binary ABI mismatch or crash on startup. |
