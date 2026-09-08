# ADR-002 — Forge is an interactive control plane, not a batch runner

Status: **proposed** · Date: 2026-08-31 · Supersedes the "stay out of the message bus" framing in `README.md`

---

## Context

Measured, driving the packaged app against a real repository with real CLIs:

```
manual loop (owner, by hand)   2-3 min   sees thinking + tool calls, corrects mid-flight
Forge (audit run, measured)    7.3 min   sees nothing until a stage ends, cannot intervene
```

Forge is roughly **3x slower and strictly less capable** than the workflow it exists to
replace. That is not a polish gap, and no number of small fixes closes it, because the
gap is in the product's shape rather than its finish.

The owner's actual loop:

```
1  prompt Claude in plan mode
2  read the response
3  iterate until it has grip           <- N turns, warm session, human judgement
   then ask for a self-contained prompt
4  paste into Antigravity
5  Antigravity plans or implements
6  read its summary + walkthrough
7  correct it there, or take the summary back to Claude
8  repeat until done
```

Every step involves watching and steering. Forge supports neither.

### Where the time goes

From `audit-out/timeline.jsonl`, one complete run:

```
Stage 1  PLANNING       claude-cli       130.3s
Stage 2  REVIEW GATE    human-gate        25.1s   auto-approved; nobody read it
Stage 3  SANDBOX CODE   antigravity-cli   20.1s
Stage    VERIFICATION   Forge Engine       ~0s
Stage 4  CODE AUDIT     claude-cli       255.7s   never requested
                                         ──────
                                          461.7s
```

Two structural causes:

1. **Every stage is a cold spawn.** `ClaudeCliRuntime` passes no `--resume`; each stage
   re-reads the repository and rebuilds context from nothing. The manual loop keeps one
   warm session across steps 1-3, which is most of its speed advantage.
2. **Forge runs stages nobody asked for.** The unrequested CODE AUDIT is 55% of the
   runtime.

### Where the transparency went

```
claudeCliRuntime.ts:244   onStdout: (chunk) => {
                            // Accumulated, deliberately NOT emitted as a chunk.
```

The working agent's stdout is buffered until the step finishes. Its thinking, tool
calls, and file reads never reach the renderer.

```
WorkflowPage.tsx:903   <RealTerminal projectId={...} runtimeId={step.runtimeId} />
```

The "Live CLI Terminal" spawns **its own separate CLI session**. It is a decoy: it
shows a fresh idle banner in the repository while the real agent runs unobserved. This
is the single most misleading element in the app, because it looks like transparency
and conveys nothing.

```
grep "sendInput|pause|interject" orchestrator.ts handlers.ts   ->   0 results
```

There is no mechanism to speak to a running step. The one human gate auto-approves
(`approve: () => Promise.resolve(true)`), so even the designed pause is inert.

---

## The premise was wrong

`README.md` states the goal as keeping the user *"out of the message bus"*. The owner's
workflow says something different, and it is the more useful goal:

> **The user wants to stay in the loop. They do not want to be the transport.**

Those are different products. Automating the judgement is not the win; automating the
copy-paste, the context loss, and the window-switching is.

---

## Decision

Forge becomes an interactive control plane built on three capabilities that do not
exist today.

### 1. Live channel — see what the agent is doing, as it does it

Every adapter switches to the CLI's streaming NDJSON transport and forwards each event
to the renderer as it arrives.

```
claude   -p --output-format stream-json --verbose
agy      --output-format=stream-json
```

Both were measured on this machine. The Claude CLI's stream carries `assistant`
messages, tool invocations, `rate_limit_event`, `usage`, and a terminal `result`.

The domain already models this. `RuntimeEvent` defines `chunk`, `tool`, `state`,
`result`, `usage`, and `error`; only `MockAgentRuntime` has ever emitted `tool`. The
pipes are designed and unconnected — this is wiring, not new architecture.

### 2. Warm sessions — stop paying for cold context every stage

Both CLIs resume, measured end to end:

```
claude   -p --resume <session_id>        "remember 7" -> new turn -> answered "7"
agy      --conversation <conversation_id> "remember 7" -> new turn -> answered "7"
```

`IAgentRuntime` gains an explicit notion of a session that outlives one step, so a
planner's context carries into the next planning turn instead of being rebuilt.

### 3. Interjection — correct an agent mid-flight

`agy --input-format stream-json` reads **one NDJSON message per line from stdin and
runs a turn for each**, which is a persistent bidirectional channel rather than a
one-shot invocation. Combined with (1), the terminal pane stops being a decoy and
becomes the actual conversation: the user types, the running agent receives it.

This is the owner's step 3 case 2 — *"multiple prompt iteration until it has grip"* —
which currently has no equivalent in Forge at all.

### 4. Templates stop being mandatory pipelines

The five-stage template runs stages the user did not ask for. Templates become a
starting shape the user can run partially, skip within, or drive one stage at a time.
The human gate stops auto-approving.

---

## What this explicitly does not change

```
A1 Forge owns truth        the event log is still the record
A3 evidence over claims    streaming shows the work; verification still checks it
A4 decisions lock          unchanged
A5 bounded loops           unchanged
A6 no provider in core     unchanged; the catalog from ADR-001 still holds
A7 least privilege         unchanged; worktree isolation stays
```

Streaming does **not** weaken A3. Watching an agent claim something is not evidence;
Forge still runs the commands. It weakens only the assumption that the user should not
be watching.

---

## Consequences

Positive:

- the app becomes usable for the workflow it was built to serve
- most of the 3x slowdown is recoverable without vendor changes
- the decoy terminal becomes the real one
- `chunk` / `tool` / `usage` stop being dead types in the domain

Negative:

- `exchange()` currently consumes the event stream to build one report; it must forward
  events while still producing that report, which is a real rewrite of the turn loop
- streaming formats are undocumented vendor surface and can drift; each adapter needs a
  contract test against the installed CLI
- an interjectable step complicates the state machine: a step can now change while
  running, and the write-ahead checkpoint must stay honest about that

Deferred, deliberately:

- whether `--safe-mode` should stay (ADR-001 left this open; a live channel makes the
  question sharper, because "runs same as it is" is now literally observable)
