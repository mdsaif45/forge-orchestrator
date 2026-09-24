# Troubleshooting & Operational Runbook

**Status:** IMPLEMENTED  
**Authority:** Operational Troubleshooting Guide  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  

---

## 1. Windows Git EBUSY / File Locks (Issue #178)

### Symptom
Intermittent `EBUSY: resource busy or locked` errors when deleting temporary test repositories during parallel Vitest runs on Windows.

### Cause
On Windows, file handles held briefly by search indexers (Windows Search), anti-virus scanners, or background git processes prevent immediate directory deletion via `fs.rmSync`.

### Solution
- `removeTempDir()` in `src/test/tempDir.ts` polls `rmSync` up to 50 times at 40 ms
  intervals. It polls rather than sleeping a fixed duration, so a normal run clears on
  the first attempt while a directory that genuinely cannot be removed still fails the
  test. The final attempt is deliberately unguarded so a real lock surfaces as an error
  instead of being swallowed.
- If manual cleanup fails in developer workspaces:
  ```powershell
  # Kill lingering git child processes
  taskkill /F /IM git.exe
  # Wipe test temp directories
  Remove-Item -Recurse -Force $env:TEMP\forge-test-*
  ```

---

## 2. `node-pty` Native Addon Mismatch

### Symptom
Error during startup: `The module '\\?\...node-pty.node' was compiled against a different Node.js version`.

### Cause
Electron and Node.js use different V8 ABI versions. Compiling `node-pty` for Node does not match Electron, and vice versa.

### Solution
Run the automated native setup script:
```bash
# Rebuild native modules for the current target
npm run setup:pty
```

---

## 3. CLI Agent Freezes at Trust Prompt

### Symptom
When driving Claude Code in a fresh worktree, the session hangs indefinitely producing zero bytes of output.

### Cause
Claude CLI displays an interactive folder trust prompt (`"Do you trust this folder?"`) that blocks standard input.

### Solution
Ensure `ClaudeTrustStore` has pre-recorded trust in `~/.claude.json`. Check that the parent repository is marked as trusted in Forge project settings.

---

## 4. Resetting Forge State

If a local database or worktree becomes corrupted during experimentation:
```bash
# Clear ephemeral worktrees and cache
rm -rf .forge/worktrees/*
rm -rf .forge/cache/*

# Reset local SQLite database (destructive: resets runs and event logs)
rm -rf .forge/forge.db*
```
