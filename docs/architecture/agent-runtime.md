# Agent Runtime Abstraction & Adapters

**Status:** IMPLEMENTED  
**Authority:** Normative Runtime Architecture  
**Last Updated:** 2026-09-21  
**Baseline:** `main` @ `1dfb444`  
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [cli-and-ipc.md](cli-and-ipc.md)  
**Related Decisions:** [ADR-001](../decisions/ADR-001-agents-runtimes-accounts.md), [ADR-003](../decisions/ADR-003-host-the-real-cli.md)  
**Related Implementation:** `src/main/core/taskRunner.ts`, `src/main/runtimes/`  

---

## 1. The `IAgentRuntime` Contract (Axiom A6)

In accordance with **Axiom A6** (*No provider in core*), the Forge orchestration core interacts exclusively with an abstract runtime interface:

```typescript
export interface IAgentRuntime {
  readonly id: string;
  readonly capabilities: AgentCapability[];

  executeTask(
    task: AgentTaskInput,
    callbacks?: AgentExecutionCallbacks
  ): Promise<AgentTaskOutput>;

  cancelSession?(sessionId: string): Promise<void>;
  dispose?(): Promise<void>;
}
```

The core engine maps logical **Roles** (e.g., `planner`, `builder`, `reviewer`) to runtime IDs via project configuration. A runtime may be:
1. An in-process native autonomous loop.
2. A headless CLI process.
3. An interactive terminal process hosted in a pseudo-terminal (PTY).

---

## 2. The Native Forge Agent Runtime (`src/main/core/taskRunner.ts`)

Forge provides a built-in, native agent runtime (`executeDirectTask`) that requires no external CLI installation:
- **Direct Model Integration**: Interacts directly with provider chat completions (Ollama, Anthropic API, OpenAI API).
- **In-Process Tool Loop**: Executes tools natively in Node.js:
  - `readFile(path, offset, length)`
  - `writeFile(path, content)`
  - `listFiles(directory, glob)`
  - `bashRun(command, timeout)`
- **Eager Context Management**: Employs content-addressed prompt packets. If a tool output exceeds 50 KB, it is automatically spilled to `.forge/cache/` to prevent blowing model context windows.
- **Strict Role Scoping**: Tool availability is restricted at invocation time based on role permissions (e.g. `writeFile` is stripped for planners and reviewers).

---

## 3. External CLI Adapters (`src/main/runtimes/`)

For developers who prefer using established CLI agents (such as Claude Code or Antigravity), Forge implements dedicated CLI adapters.

### Why Forge Hosts the Real CLI (ADR-003)
Early prototypes attempted to spawn CLIs headlessly with `--output-format json` and parse stdout. This proved brittle and unusable:
- Stripped interactive tool confirmation dialogs.
- Broke on undocumented vendor formatting changes.
- Felt like a slow log viewer rather than a real terminal.

Under ADR-003, Forge launches the **real CLI interactively** inside a pseudo-terminal (`node-pty` / ConPTY on Windows, tmux/openpty on POSIX) and attaches an xterm.js terminal pane directly to the process.

### Adapter Catalog & Capabilities

| Runtime ID | Binary Executable | Execution Mode | Trust Handling | Hook Support |
| :--- | :--- | :--- | :--- | :--- |
| `forge-native` | In-process | Function calling loop | Inherent | Full event log |
| `claude-cli` | `claude.exe` | Interactive ConPTY / PTY | `ClaudeTrustStore` (`~/.claude.json`) | Hook events via stdio |
| `antigravity-cli` | `agy.exe` | Interactive ConPTY / PTY | Workspace settings | Hook events |
| `opencode` | `opencode` | Interactive / ACP | Directory probe | ACP protocol |

---

## 4. Session Lifecycle & Multi-Turn Steering

```
┌────────────────────────────────────────────────────────┐
│ 1. INIT & SPAWN                                        │
│    Resolve executable against PATH + PATHEXT           │
│    Pre-record folder trust into vendor config store    │
│    Spawn process in isolated worktree via node-pty     │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ 2. ATTACH & STREAM                                     │
│    Forward raw PTY byte stream to xterm.js in UI       │
│    Parse background hook events (permission / idle)    │
│    Allow user mid-flight typing and steering           │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ 3. COMPLETION / EXIT                                   │
│    Capture exit code and raw terminal transcript       │
│    Spill raw transcript to ArtifactStore               │
│    Trigger downstream verification & reconciliation    │
└────────────────────────────────────────────────────────┘
```

### Pre-Launch Trust Automation
When a CLI agent launches in a fresh git worktree (e.g. `C:\Temp\f166-8Cc765`), it typically displays an interactive security prompt: `"Do you trust this folder?"`.
Because Forge generates a fresh worktree per run, this prompt would freeze unattended automation. Forge intercepts this by pre-recording trust in the CLI's configuration before launching (e.g. injecting `hasTrustDialogAccepted: true` into `~/.claude.json`).

### Mid-Flight Steering
Because the session runs in a real PTY, the developer is not locked out while the agent works. The developer can type into the terminal to steer the agent, provide guidance, or cancel execution cleanly via standard OS signals.
