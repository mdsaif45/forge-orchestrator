# Developer Guide & Local Setup

**Status:** IMPLEMENTED  
**Authority:** Operational Guide  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  

---

## 1. Prerequisites

- **Node.js**: `node >= 22.0.0` (required by `package.json` engines).
- **Git**: `git >= 2.40` installed and accessible on `PATH`.
- **Operating System**: Windows 11 / Windows 10 (primary target with ConPTY) or Ubuntu Linux 22.04+.
- **C++ Build Tools** (for native addons):
  - Windows: Visual Studio Build Tools (C++ workload) or `windows-build-tools`.
  - Linux: `build-essential`, `python3`.

---

## 2. Initial Repository Setup

```bash
# Clone the repository
git clone https://github.com/mdsaif45/forge-orchestrator.git
cd forge-orchestrator

# Install dependencies and build native addons (better-sqlite3, node-pty)
npm install
npm run setup
```

If `node-pty` fails to link on Windows, rebuild it explicitly:
```bash
npm run setup:pty
```

---

## 3. Daily Development Workflows

### 1. Running the Headless CLI
Execute the Forge CLI in development mode without building:
```bash
npm run cli -- run "Add unit tests for math module" --json
```

### 2. Running the Electron Desktop App
Launch Vite development servers and Electron with Hot Module Replacement (HMR):
```bash
npm run dev
```

### 3. Running Database Migrations
If modifying SQLite schemas in `src/main/db/schema.ts`:
```bash
npm run db:generate
npm run db:check
```

---

## 4. Code Quality & Invariant Checks

Before opening a pull request, run the full verification gate:
```bash
# Full verification suite (runs format, lint, typecheck, tests, smoke, docs)
npm run check
```

Or run individual sub-gates:
```bash
npm run format:check   # Verify Prettier style
npm run lint           # Run ESLint across main, preload, renderer
npm run typecheck      # Typecheck node, web, and test tsconfigs
npm run check:docs     # Verify docs/DOMAIN.md state diagram matches transitions.ts
npm run check:router   # Verify IPC router exhaustiveness
npm run test           # Run 1,125+ unit and integration tests
```
