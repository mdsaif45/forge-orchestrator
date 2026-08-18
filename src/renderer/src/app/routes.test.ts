import { describe, expect, it } from 'vitest'
import { ROUTES } from './routes'

describe('route table', () => {
  it('declares every route the sidebar and router derive from', () => {
    expect(ROUTES.length).toBe(8)
  })

  it('has a unique path per route', () => {
    const paths = ROUTES.map((route) => route.path)

    expect(new Set(paths).size).toBe(paths.length)
  })

  it('has a unique label per route', () => {
    const labels = ROUTES.map((route) => route.label)

    expect(new Set(labels).size).toBe(labels.length)
  })

  it('starts every path with a slash', () => {
    for (const route of ROUTES) {
      expect(route.path, route.label).toMatch(/^\//)
    }
  })

  it('includes exactly one index route', () => {
    expect(ROUTES.filter((route) => route.path === '/')).toHaveLength(1)
  })

  it('gives every route empty-state copy', () => {
    // These screens are empty for real users until a workflow runs, so the copy
    // is load-bearing rather than filler.
    for (const route of ROUTES) {
      expect(route.empty.title.length, route.label).toBeGreaterThan(0)
      expect(route.empty.description.length, route.label).toBeGreaterThan(20)
    }
  })

  it('gives every route an icon', () => {
    for (const route of ROUTES) {
      expect(route.icon, route.label).toBeTruthy()
    }
  })
})
