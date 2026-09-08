import { describe, expect, it } from 'vitest'
import { asksForChange } from './agentTurn'

/**
 * Which requests are held to actually changing something.
 *
 * Two regressions came from this one predicate, in opposite directions, and
 * both reached the app:
 *
 * - applied to every turn, "hi" and "tell me about project" were told to edit
 *   files nobody had mentioned, and the model spent a round explaining that no
 *   edit was needed
 * - written by a script that turned its word-boundary escapes into literal
 *   backspace bytes, it then matched nothing at all, so a genuine change
 *   request silently skipped the enforcement it appeared to have
 *
 * The second is why these assert on the exported predicate rather than trusting
 * the pattern by reading it: a regex that looks right in a diff and matches
 * nothing at runtime is exactly what happened.
 */

const user = (content: string) => [{ role: 'user', content }]

describe('asksForChange', () => {
  it('recognises a request to change something', () => {
    expect(asksForChange(user('can you update more content in README file'))).toBe(true)
    expect(asksForChange(user('fix the typo in docs/PLAN.md'))).toBe(true)
    expect(asksForChange(user('add a Testing section'))).toBe(true)
    expect(asksForChange(user('refactor this function'))).toBe(true)
    expect(asksForChange(user('rename the variable'))).toBe(true)
  })

  it('leaves a plain question alone', () => {
    // The reported regression: these were nudged to edit files.
    expect(asksForChange(user('hi'))).toBe(false)
    expect(asksForChange(user('tell me about project'))).toBe(false)
    expect(asksForChange(user('just tell me about project'))).toBe(false)
    expect(asksForChange(user('what does this repository do'))).toBe(false)
    expect(asksForChange(user('list the features'))).toBe(false)
  })

  it('does not match a verb buried inside another word', () => {
    // What the word boundaries are for. Without them "readme" contains no verb
    // but "updated" and "changelog" would drag unrelated words in.
    expect(asksForChange(user('what is in the CHANGELOG'))).toBe(false)
    expect(asksForChange(user('explain the addressing scheme'))).toBe(false)
  })

  it('reads the latest user message, not the whole thread', () => {
    // An earlier edit request is finished business; treating it as still owed
    // would nudge every later question in the conversation.
    const thread = [
      { role: 'user', content: 'update the README' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'thanks, what else is in there?' },
    ]
    expect(asksForChange(thread)).toBe(false)
  })

  it('reports no request when there is no user message', () => {
    expect(asksForChange([{ role: 'system', content: 'update everything' }])).toBe(false)
    expect(asksForChange([])).toBe(false)
  })
})
