import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CustomRuntimeStore } from './customRuntimeStore'
import { EventStore } from './eventStore'
import { initialiseDatabase, type ForgeDatabase } from './index'

describe('CustomRuntimeStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let events: EventStore
  let customRuntimes: CustomRuntimeStore

  beforeEach(() => {
    const handle = initialiseDatabase(':memory:')
    db = handle.db
    close = handle.close

    events = new EventStore(db)
    customRuntimes = new CustomRuntimeStore(db, events)
  })

  afterEach(() => {
    close()
  })

  it('creates and lists custom runtimes', () => {
    const created = customRuntimes.create(
      {
        slug: 'custom:my-cli',
        name: 'My Custom CLI',
        command: 'my-agent',
        argsTemplate: '--prompt {{prompt}} --json',
        capabilities: ['repo-read', 'file-write', 'terminal'],
        permissionMode: 'developer',
        instructionFilenames: ['AGENT.md'],
        env: { AGENT_ENV: 'test' },
      },
      'user',
      '2026-08-24T00:00:00.000Z',
    )

    expect(created.id).toBeDefined()
    expect(created.slug).toBe('custom:my-cli')
    expect(created.name).toBe('My Custom CLI')
    expect(created.command).toBe('my-agent')
    expect(created.capabilities).toEqual(['repo-read', 'file-write', 'terminal'])
    expect(created.env).toEqual({ AGENT_ENV: 'test' })

    const found = customRuntimes.find(created.id)
    expect(found).toEqual(created)

    const bySlug = customRuntimes.findBySlug('custom:my-cli')
    expect(bySlug).toEqual(created)

    const list = customRuntimes.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.slug).toBe('custom:my-cli')
  })

  it('removes a custom runtime', () => {
    const created = customRuntimes.create(
      {
        slug: 'custom:to-remove',
        name: 'To Remove',
        command: 'remove-me',
        capabilities: ['repo-read'],
      },
      'user',
      '2026-08-24T00:00:00.000Z',
    )

    expect(customRuntimes.list()).toHaveLength(1)

    customRuntimes.remove(created.id, 'user', '2026-08-24T01:00:00.000Z')
    expect(customRuntimes.find(created.id)).toBeNull()
    expect(customRuntimes.list()).toHaveLength(0)
  })
})
