# Agent Runtime Abstraction & Adapters

**Status:** IMPLEMENTED
**Authority:** Normative runtime architecture
**Last Updated:** 2026-09-22
**Baseline:** `main` @ `1dfb444`
**Related Architecture:** [architecture-overview.md](architecture-overview.md), [cli-and-ipc.md](cli-and-ipc.md)
**Related Decisions:** [ADR-001](../decisions/ADR-001-agents-runtimes-accounts.md), [ADR-003](../decisions/ADR-003-host-the-real-cli.md)
**Related Research:** [cli-field-guide.md](../research/cli-field-guide.md)
**Related Implementation:** `src/shared/domain/runtime.ts`, `src/main/runtimes/`

Interface members and tool names on this page are transcribed from the source. Where
this page and the code disagree, the code is correct and this page is a defect.

---

## 1. The `IAgentRuntime` contract (Axiom A6)

Defined in `src/shared/domain/runtime.ts`. Core never names a provider; it talks only
to this interface.

```typescript
export interface IAgentRuntime {
  readonly id: RuntimeId
  readonly capabilities: readonly Capability[]
  readonly simulated: boolean
  readonly supportsAccountIsolation: boolean
  readonly instructionFilenames: readonly string[]

  start(options: SessionOptions): Promise<SessionHandle>
  send(session: SessionHandle, packet: PromptPacket): Promise<void>
  events(session: SessionHandle): AsyncIterable<RuntimeEvent>
  status(session: SessionHandle): Promise<RuntimeStatus>
  cancel(session: SessionHandle, reason: string): Promise<void>
  dispose(session: SessionHandle): Promise<void>
}
```

Four details carry design weight, each recorded in the source:

- **`events` is an async iterable**, not a callback registry, so back-pressure and
  cancellation come from the language instead of each adapter inventing its own
  buffering.
- **`simulated` is declared, not inferred.** The UI once rendered a mock's replayed
  `PASS` identically to evidence Forge had actually gathered (#101) — exactly the
  substitution of a claim for a fact that A3 exists to prevent. Matching on an id prefix
  would have put a provider literal in core (A6) and would fail silently on a rename. A
  required field cannot be forgotten by a new runtime.
- **`supportsAccountIsolation` is per-provider**, because providers genuinely differ:
  Claude keeps its credential at `~/.claude/.credentials.json`, so a redirected home
  isolates it; `agy` keeps its credential in the Windows Credential Manager under one
  fixed target name, so every process reads the same identity whatever environment it
  is given. A single global assumption is wrong in both directions.
- **`instructionFilenames` is declared per runtime**, because the filename a CLI reads
  repository instructions from is provider-specific and must not be hardcoded in core.
  Forge reads the file and puts it in the packet itself, because the spawned process
  runs with its host configuration disabled so that what enters an agent's context is
  what Forge put there (A1, #133).

> An earlier revision of this page showed a three-method interface with
> `executeTask(...)` and optional `cancelSession`/`dispose`. No such interface exists.

### Capabilities and roles

```
Capability   repo-read · file-write · terminal · plan · review · test

Role                 requires
planner              repo-read, plan
implementer          repo-read, file-write
reviewer             repo-read, review
tester               repo-read, test
security-reviewer    repo-read, review
system               —   Forge performs these itself; no runtime involved
user                 —
```

Binding is capability-based, not identity-based: any runtime may hold any role it can
actually perform, which is what makes planner and implementer swappable (A6).
`canHoldRole()` and `missingCapabilities()` enforce and explain this at bind time,
rather than failing once a workflow is already running.

> The implementing role is named **`implementer`**, not "builder".

---

## 2. Native agent runtime

`NativeAgentRuntime` (`src/main/runtimes/nativeAgentRuntime.ts`) is Forge's own agent:
the model plus Forge's tool loop, with no CLI in between. Direct task execution runs
through `src/main/core/taskRunner.ts`; the loop itself is
`src/main/providers/agentLoop.ts`.

Tool definitions are in `src/main/providers/tools.ts` (`TOOL_DEFINITIONS`):

```
read_file · list_dir · search_files · write_file · edit_file · run_command
```

Tool availability is narrowed per turn rather than fixed: `agentTurn.ts` only offers
the mutating tools (`edit_file`, `write_file`) when tools are enabled and the request
actually asks for a change.

> An earlier revision listed `readFile`, `writeFile`, `listFiles` and `bashRun`. Those
> names do not exist. The same revision claimed automatic spill of tool output above
> 50 KB to `.forge/cache/`; no such path or behaviour exists on `main` — streaming
> artifact ingestion is noted in `artifactService.ts` as future work.

---

## 3. External CLI adapters

### Why Forge hosts the real CLI (ADR-003)

Early prototypes spawned CLIs headlessly with a JSON output flag and parsed stdout.
That approach stripped the interactive tool-confirmation dialogs, broke on undocumented
vendor formatting changes, and produced something closer to a slow log viewer than a
terminal. Under [ADR-003](../decisions/ADR-003-host-the-real-cli.md) Forge launches the
real CLI inside a pseudo-terminal and attaches a terminal pane to it.

### Adapters on `main`

| Adapter | Module | Notes |
| :--- | :--- | :--- |
| Native | `nativeAgentRuntime.ts` | In-process model + Forge tool loop |
| Hosted Claude | `hostedClaudeRuntime.ts` | Real `claude` CLI in a PTY; hook receiver under `<dataDir>/hooks` |
| Generic CLI | `genericCliRuntime.ts` | Data-driven adapter for detected CLIs |
| Antigravity | `antigravityCliRuntime.ts` | `agy`, with its own stream parser (`antigravityStream.ts`) |

`registerDefaultRuntimes()` (`defaultRuntimes.ts`) registers the native and hosted
Claude runtimes, then wires the generic adapter to detected CLIs.

`cliDetector.ts` carries `STANDARD_AGENT_CATALOG`, a detection catalogue of known CLI
agents (`claude`, `agy`, `cline`, `opencode`, `codex`, `aider`, `kilocode`, `cursor`,
`copilot`, `goose` and others). Being catalogued means Forge knows how to *detect* the
executable — it is not a claim that each is verified end-to-end. Measured behaviour for
the CLIs actually driven is recorded in
[cli-field-guide.md](../research/cli-field-guide.md).

### Process runners

Two runners back the adapters:

- `ptyProcessRunner.ts` — a real pseudo-terminal via `node-pty` (ConPTY on Windows).
- `pipeProcessRunner.ts` — plain piped stdio, where no terminal is needed.

Session state lives in `src/main/terminal/` (`sessionRegistry.ts`,
`terminalService.ts`). There is no `src/main/runtimes/terminalSession.ts`.

---

## 4. Session lifecycle

```
start(options)                 resolve executable on PATH (+PATHEXT on Windows)
   │                           pre-record folder trust in the vendor config
   │                           spawn in the run's worktree, host config disabled
   ▼
send(session, packet)          Forge composes the prompt packet — including any
   │                           repository instruction file it read itself
   ▼
for await (events(session))    RuntimeEvent stream; back-pressure from the language
   │                           raw transcript captured to the artifact store
   ▼
status / cancel / dispose      cancel must leave the worktree coherent (rule R8)
                               dispose is safe to call twice
```

### Pre-launch trust

A CLI launched in a fresh worktree typically asks "do you trust this folder?", which
would freeze unattended automation. `claudeTrust.ts` pre-records trust in the vendor's
configuration before launch. The module is `claudeTrust.ts`; there is no
`claudeTrustStore.ts`.

### Mid-flight steering

Because the session is a real PTY, the developer is not locked out while the agent
works: they can type into the terminal to steer or interrupt it. This is the terminal
inversion the [north star](../product/north-star.md) describes.

---

## 5. Open questions

- **Q-AR-01:** `STANDARD_AGENT_CATALOG` lists many CLIs, but only some have measured
  entries in the field guide. Which are supported versus merely detectable is not
  stated anywhere normative.
- **Q-AR-02:** Streaming artifact ingestion for large tool output is referenced in the
  source as `AGENT-002` but has no ADR and no roadmap acceptance target.
