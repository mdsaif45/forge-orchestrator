import { describe, expect, it } from 'vitest'
import { SqliteFts5SearchRankerSupervisor } from './sqliteFts5SearchRankerSupervisor'

describe('SqliteFts5SearchRankerSupervisor', () => {
  it('tokenizes text into lowercase tokens', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor()
    const tokens = supervisor.tokenize('Workflow Step: 42_failed-now!')
    expect(tokens).toEqual(['workflow', 'step', '42_failed-now'])
  })

  it('indexes documents and calculates token counts', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor()
    const doc = supervisor.indexDocument({
      docId: 'doc-1',
      runId: 'run-100',
      eventType: 'STEP_COMPLETED',
      title: 'Compile TypeScript',
      body: 'Successfully compiled 400 source files in workspace.',
    })

    expect(doc.docId).toBe('doc-1')
    expect(doc.tokensCount).toBe(9)
    expect(supervisor.getDocumentCount()).toBe(1)
    expect(supervisor.getDocument('doc-1')).toBeDefined()
  })

  it('ranks title matches higher than body matches when titleWeight > bodyWeight', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor({
      titleWeight: 3.0,
      bodyWeight: 1.0,
    })

    supervisor.indexDocument({
      docId: 'title-match',
      runId: 'run-1',
      eventType: 'LOG',
      title: 'Database connection retry attempt',
      body: 'General diagnostic status message.',
    })

    supervisor.indexDocument({
      docId: 'body-match',
      runId: 'run-2',
      eventType: 'LOG',
      title: 'General diagnostic status message',
      body: 'Encountered database timeout during fetch.',
    })

    const results = supervisor.search('database')
    expect(results.totalMatches).toBe(2)
    expect(results.matches[0]?.docId).toBe('title-match')
    expect(results.matches[0]?.score).toBeGreaterThan(results.matches[1]?.score ?? 0)
  })

  it('supports wildcard prefix matching with * operator', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor()
    supervisor.indexDocument({
      docId: 'doc-checkpoint',
      runId: 'run-1',
      eventType: 'CHECKPOINT',
      title: 'Created checkpoint alpha',
      body: 'State serialized to disk snapshot.',
    })

    const results = supervisor.search('check*')
    expect(results.totalMatches).toBe(1)
    expect(results.matches[0]?.docId).toBe('doc-checkpoint')
    expect(results.matches[0]?.matchedTerms).toContain('checkpoint')
  })

  it('filters matches by runId and eventType', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor()
    supervisor.indexDocument({
      docId: 'doc-a',
      runId: 'run-1',
      eventType: 'ERROR',
      title: 'Fatal crash',
      body: 'Stack trace in worker',
    })
    supervisor.indexDocument({
      docId: 'doc-b',
      runId: 'run-2',
      eventType: 'INFO',
      title: 'Fatal warning',
      body: 'Information log in worker',
    })

    const filtered = supervisor.search('fatal', { runId: 'run-1', eventType: 'ERROR' })
    expect(filtered.totalMatches).toBe(1)
    expect(filtered.matches[0]?.docId).toBe('doc-a')
  })

  it('generates highlighted snippets with <mark> tags', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor({ snippetRadiusChars: 15 })
    supervisor.indexDocument({
      docId: 'doc-snippet',
      runId: 'run-1',
      eventType: 'EVIDENCE',
      title: 'Verification summary',
      body: 'Initial setup followed by catastrophic failure in cluster during synchronization.',
    })

    const result = supervisor.search('catastrophic')
    expect(result.matches[0]?.bodySnippet).toContain('<mark>catastrophic</mark>')
  })

  it('removes documents and updates inverted index cleanly', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor()
    supervisor.indexDocument({
      docId: 'doc-del',
      runId: 'run-1',
      eventType: 'TEST',
      title: 'Delete me',
      body: 'Temporary record',
    })

    expect(supervisor.getDocumentCount()).toBe(1)
    const removed = supervisor.removeDocument('doc-del')
    expect(removed).toBe(true)
    expect(supervisor.getDocumentCount()).toBe(0)

    const searchAfter = supervisor.search('delete')
    expect(searchAfter.totalMatches).toBe(0)
  })

  it('returns empty result for non-matching or empty queries', () => {
    const supervisor = new SqliteFts5SearchRankerSupervisor()
    const result = supervisor.search('   ')
    expect(result.totalMatches).toBe(0)
    expect(result.matches).toHaveLength(0)
  })
})
