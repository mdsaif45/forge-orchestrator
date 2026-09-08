# North star — what Forge is aiming at

Why this exists: the target below was learned by studying a mature, working
orchestrator alongside the owner's own manual workflow, and by measuring Forge
against both. Without it written down, the same wrong turns get taken again —
this project already took one, and rebuilt a worse copy of something that already
existed.

Read this before planning a milestone. It is the destination; `docs/PLAN.md` and
the milestones are the route.

---

## The one sentence

> **The user stays in the loop. They just stop being the transport.**

Forge's README originally said the opposite — "you stay out of the message bus" —
and that framing produced a product that was slower and less capable than doing
the work by hand. Automating the *judgement* was never the win. Automating the
copy-paste, the context loss, and the window-switching is.

---

## The workflow being served

The owner's actual loop, in their own words, is the specification:

```
1  prompt the planner in plan mode
2  read the response
3  iterate until it has grip                    <- N turns, warm session, judgement
   then ask for a self-contained prompt
4  paste that into the implementer
5  it plans, or implements
6  read its summary and walkthrough
7  correct it there, OR take the summary back to the planner
8  repeat until done
```

Every step involves **watching and steering**. Any design that removes the human
from steps 3 and 7 is solving a different problem than the one that exists.

### The measured gap

```
                    manual        Forge (measured)
──────────────────  ──────────    ─────────────────────────────────────
one small task      2-3 min       7.3 min, then 15.4 min on a real repo
visibility          everything    nothing until a stage ended
mid-flight steering yes           none — the input box reached nothing
```

Forge was **~3x slower and strictly less capable** than the workflow it exists to
replace. That is the number to beat, and it is the honest baseline.

---

## The architecture that works

Learned from a mature orchestrator handling the same problem. The single
inversion that matters:

```
WRONG (what Forge built first)
  spawn the CLI headless -> parse its stdout -> re-render it in our own UI
  = a bespoke parser per provider, against undocumented formats,
    producing a transcript that is not a terminal and never feels like one

RIGHT
  launch the CLI INTERACTIVELY -> attach a real terminal to that process
                               -> learn state from the CLI's own hooks
  = the pane IS the session; adding a provider is a launch command, not a parser
```

Four properties fall out of that inversion:

```
transparency   you see the real CLI: its thinking, tool calls, and diffs,
               rendered by the tool that already does it best
control        you type into the live session; correcting an agent mid-flight
               is a write to the pty, not a new subsystem
speed          a live session is warm by construction — no cold-spawn cost
               rebuilding context on every stage
extensibility  a provider is a launch command plus a hook map. A mature
               implementation of this carries 20+ agent adapters
```

### What such a system has that Forge does not, yet

```
20+ agent adapters       claude · agy · codex · cursor · aider · cline ·
                         copilot · droid · amp · crush · continue · …
real multiplexer         tmux on Linux, ConPTY on Windows; per-client attach
                         with a faithful repaint on reconnect
hook-driven state        activity / blocked-on-permission / idle, REPORTED by
                         the CLI rather than inferred from its output
pre-launch trust         records folder trust so a fresh worktree cannot hang
                         on the dialog (Forge now does this — 5f5396b)
worktree per session      Forge has this and got it right
board view               Idle · Working · Needs You · In Review · Ready to merge
```

One detail worth keeping in view: their terminal package documents that sharing
one PTY and replaying a byte ring to late subscribers **loses the init
handshake** — which kills mouse reporting and wheel scroll. They spawn a fresh
attach per client so the runtime re-sends it by construction. That is the
difference between a pane that feels like a terminal and one that does not.

---

## Where Forge stands

```
done and verified
  worktree isolation           agents never touch the user's checkout
  pre-launch trust             a fresh worktree no longer hangs on the dialog
  per-role permissions         with a stated reason, logged per step
  session identity             derived, stable across restarts, resumable
  process exposure             a step's process is reachable for attaching
  evidence layer               Forge runs the commands itself (A3 intact)

built then superseded
  NDJSON stdout parsers        two of them; to be deleted once hooks and the
                               hosted pane replace them (#172)

not built yet
  interactive launch           the argv switch, once the pane can show it
  hosted pane                  attach to the real process, not a re-render
  hooks for state              the reporting channel --safe-mode disabled
  interjection                 typing into a live session
  warm sessions across steps    the identity exists; reuse does not
```

---

## Principles that survived contact

These held up under measurement and should not be traded away for speed:

```
A1  Forge owns truth        the event log is the record, not chat history
A3  evidence over claims    a rendered screen is not evidence; run the commands
A4  decisions lock          a locked decision changes only by approved request
A5  bounded loops           caps and terminal states, always
A6  no provider in core     core sees IAgentRuntime; CLIs live in adapters
A7  least privilege         Forge enforces permission, the prompt does not ask
```

A3 is the one under most pressure from this redesign, and the answer is fixed: a
hosted terminal shows what the agent *says*. Forge still measures the diff,
enforces scope, and runs the build and tests itself. **The pane is for the human;
the evidence layer is for the verdict.** They are not the same channel and must
never collapse into one.

---

## How to tell if we are winning

Not "does it work" — it worked before and was still unusable. The tests are:

```
1  can the user SEE what the agent is doing, as it does it?
2  can the user CORRECT it mid-flight, without restarting?
3  is it FASTER than doing the same task by hand?
4  does the terminal actually feel like a terminal?
```

All four were "no" at the point this document was written. #4 in particular was
the owner's own repeated feedback, and the honest reading of it is that a styled
log is not a terminal and no amount of styling will make it one.

---

## The mistake worth remembering

Forge passed `--safe-mode` to the CLI. That flag strips the CLI's own
customisations — **including its hooks**, which are the mechanism by which a CLI
reports what it is doing.

So Forge disabled the reporting channel, and then spent an entire milestone
rebuilding a weaker substitute by parsing stdout. Two hand-written parsers
against undocumented formats, to recover information the CLI was willing to send
all along.

The general form: **before building a mechanism, check whether the tool already
offers one.** It is the same lesson as A2, one level up — do not guess that a
capability is missing.
