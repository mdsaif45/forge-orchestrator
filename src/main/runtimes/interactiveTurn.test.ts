import { describe, expect, it } from 'vitest'
import {
  blockingPrompt,
  isPromptReady,
  promptKeystrokes,
  turnLooksComplete,
} from './interactiveTurn'

/**
 * Screens below are trimmed from real emulator output captured against the
 * installed CLI, not invented. A rule written against an imagined screen proves
 * only that it matches my recollection.
 */
const BOOTING = 'Claude Code v2.1.209\nWelcome back\nTips for getting started'
const READY = '────────\n❯ Try "edit <filepath> to..."\n────────\n? for shortcuts'
const WORKING =
  '❯ Read data.txt and tell me the number inside it.\n● Searching for 1 pattern…\nesc to interrupt'
const ANSWERED =
  '❯ Read data.txt and tell me the number inside it.\n  Searched for 1 pattern, read 1 file\n● 42\n────────\n❯ \n? for shortcuts'
const TRUST_DIALOG =
  'Quick safety check: Is this a project you created or one you trust?\n 1. Yes, I trust this folder  2. No, exit'
const PERMISSION_DIALOG =
  'Bash command\n  Read data.txt\nDo you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow\n   3. No'

describe('isPromptReady', () => {
  it('is false while the CLI is still booting', () => {
    // Typing here sends characters into whatever is on screen. During a fresh
    // worktree's trust dialog they were swallowed entirely and the run appeared
    // to hang (#166).
    expect(isPromptReady(BOOTING)).toBe(false)
  })

  it('is true once the prompt box paints', () => {
    expect(isPromptReady(READY)).toBe(true)
  })
})

describe('blockingPrompt', () => {
  it('recognises the startup trust dialog', () => {
    expect(blockingPrompt(TRUST_DIALOG)).toBe('trust')
  })

  it('recognises a permission request', () => {
    expect(blockingPrompt(PERMISSION_DIALOG)).toBe('permission')
  })

  it('reports nothing for an ordinary working screen', () => {
    expect(blockingPrompt(WORKING)).toBeNull()
    expect(blockingPrompt(ANSWERED)).toBeNull()
  })
})

describe('turnLooksComplete', () => {
  it('is false while the agent is still working', () => {
    // The busy indicator is the reliable negative. Calling this complete would
    // truncate the agent mid-thought and report a partial answer as the whole one.
    expect(turnLooksComplete(WORKING)).toBe(false)
  })

  it('is true once the session returns to an idle prompt', () => {
    expect(turnLooksComplete(ANSWERED)).toBe(true)
  })

  it('is false while the CLI is still booting', () => {
    expect(turnLooksComplete(BOOTING)).toBe(false)
  })

  it('does not mistake a permission dialog for a finished turn', () => {
    // The dialog is not the busy indicator, so a naive "is the prompt box back"
    // check would call this done and read the dialog text as the answer.
    expect(blockingPrompt(PERMISSION_DIALOG)).not.toBeNull()
  })
})

describe('promptKeystrokes', () => {
  it('sends the text wrapped in bracketed paste, pauses, then submits', () => {
    // Not decoration: without these markers a prompt over ~1200 characters
    // arrived at the model as only its last fragment, because the CLI's input
    // still captured it as a paste by arrival speed alone but had no marker
    // saying where that paste began. Measured against the real CLI — see
    // `docs/CLI-FIELD-GUIDE.md`.
    const keys = promptKeystrokes('do the thing')
    expect(keys.map((k) => k.text)).toEqual(['\x1b[200~do the thing\x1b[201~', '\r'])
    expect(keys[0]?.pauseMs).toBeGreaterThan(0)
  })

  it('flattens newlines so a multi-line packet is not submitted in fragments', () => {
    // A prompt packet is multi-line by construction. Sent raw, each newline is a
    // submit, and the agent receives the first line as the whole instruction.
    const keys = promptKeystrokes('line one\nline two\r\nline three')
    expect(keys[0]?.text).toBe('\x1b[200~line one line two line three\x1b[201~')
    expect(keys[0]?.text).not.toContain('\n')
  })

  it('sends the prompt as one write rather than per character', () => {
    // Measured: the TUI does not echo per keystroke under ConPTY, so typing
    // character by character bought latency and nothing else.
    expect(promptKeystrokes('abcdef')).toHaveLength(2)
  })
})
