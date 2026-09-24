# Concurrency, Child Processes & Isolation

**Status:** IMPLEMENTED  
**Authority:** Normative Concurrency Architecture  
**Last Updated:** 2026-09-22  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [agent-runtime.md](agent-runtime.md), [security-and-trust.md](security-and-trust.md)  
**Related Research:** [cli-field-guide.md](../research/cli-field-guide.md)  
**Related Implementation:** `src/main/process/processManager.ts`, `src/main/process/orphans.ts`, `src/main/terminal/sessionRegistry.ts`  

---

## 1. Process Management (`ProcessManager`)

All external execution—whether interactive CLI agents, build commands, test runners, or git probes—is managed through a central `ProcessManager` (`src/main/process/processManager.ts`).

`ProcessManager` enforces:
- **Concurrency Bounds**: Caps the maximum number of concurrent child processes to prevent host resource starvation.
- **Tree-Level Termination**: Ensures cancelling a task kills all child and grandchild processes.
- **Output Capping**: Prevents rogue chatty processes from exhausting host RAM.
- **Clean Teardown**: Guarantees zero orphaned processes when Forge shuts down.

---

## 2. Platform-Specific Terminal Multiplexing

Forge interacts with agents through real pseudo-terminals (PTYs):
- **Windows (ConPTY)**: Powered by `node-pty` using Windows Pseudo Console APIs (`conpty.dll`). 
- **POSIX (Linux / macOS)**: Powered by standard openpty / tmux wrappers.

### Measured Platform Behavioral Realities
Empirical testing on real hardware uncovered critical platform behaviors:

1. **Direct Binary vs Batch Shims**: On Windows, spawning `claude.cmd` or `npm.cmd` forces Node to invoke `cmd.exe`, which places an unmanageable shell layer between ConPTY and the process. Forge resolves `PATH` + `PATHEXT` to locate the underlying `.exe` binary directly.
2. **`CreateProcess` Does Not Search `PATH`**: Unlike shell environments, low-level OS process creation APIs do not automatically traverse `PATH`. Forge explicitly resolves all executables prior to invocation.
3. **The Timeout Must Kill the Whole Tree**: When a timeout triggers on a command like `npm test`, killing the top-level process ID terminates only the shell. Worker processes (like Vitest threads or compile daemons) continue running in the background. On Windows, Forge invokes `taskkill /PID <pid> /T /F`; on POSIX, Forge kills the process group (`process.kill(-pid, 'SIGKILL')`).
4. **Clean Exit on Application Quit**: If the user closes Forge while agents or compilers are active, `ProcessManager.killAll()` terminates every child process tree before the main Node event loop exits.

---

## 3. Worktree Isolation

Agents are never permitted to work directly within the developer's primary git checkout.

```
Primary Checkout (d:/projects/my-app)  ◄── (Untouched by agents)
       │
       ├── git worktree add .forge/worktrees/<runId> <baseSha>
       │
       ▼
Isolated Worktree (.forge/worktrees/<runId>)  ◄── (Agent edits files here)
       │
       ▼ (Diff measured, verified, tests passed)
Physical ChangeSet committed or cherry-picked
```

### Invariants of Worktree Isolation
- Every Run creates an isolated git worktree linked to the target commit SHA.
- If an agent damages files, introduces infinite loops, or crashes, the developer's working directory is completely unaffected.
- On completion or cancellation, the worktree can be committed, converted into a branch, or wiped cleanly via `git worktree remove --force`.
