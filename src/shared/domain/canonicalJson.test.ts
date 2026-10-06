import { describe, expect, it } from 'vitest'
import { canonicalizeJson, tryCanonicalizeJsonString } from './canonicalJson'

describe('canonicalizeJson', () => {
  it('serializes primitives identically to JSON.stringify', () => {
    expect(canonicalizeJson(null)).toBe('null')
    expect(canonicalizeJson(42)).toBe('42')
    expect(canonicalizeJson('hello')).toBe('"hello"')
    expect(canonicalizeJson(true)).toBe('true')
    expect(canonicalizeJson(false)).toBe('false')
  })

  it('sorts object keys lexicographically regardless of insertion order', () => {
    const objA = { z: 1, a: 2, m: 3 }
    const objB = { a: 2, m: 3, z: 1 }
    const objC = { m: 3, z: 1, a: 2 }

    const serializedA = canonicalizeJson(objA)
    const serializedB = canonicalizeJson(objB)
    const serializedC = canonicalizeJson(objC)

    expect(serializedA).toBe('{"a":2,"m":3,"z":1}')
    expect(serializedA).toBe(serializedB)
    expect(serializedB).toBe(serializedC)
  })

  it('recursively sorts keys in nested objects', () => {
    const nested1 = {
      user: { name: 'Alice', age: 30, address: { zip: '10001', city: 'NYC' } },
      meta: { tag: 'dev' },
    }
    const nested2 = {
      meta: { tag: 'dev' },
      user: { address: { city: 'NYC', zip: '10001' }, age: 30, name: 'Alice' },
    }

    expect(canonicalizeJson(nested1)).toBe(canonicalizeJson(nested2))
    expect(canonicalizeJson(nested1)).toBe(
      '{"meta":{"tag":"dev"},"user":{"address":{"city":"NYC","zip":"10001"},"age":30,"name":"Alice"}}',
    )
  })

  it('preserves array element ordering while canonicalizing elements within arrays', () => {
    const arr1 = [
      { b: 1, a: 2 },
      { y: 10, x: 20 },
    ]
    const arr2 = [
      { a: 2, b: 1 },
      { x: 20, y: 10 },
    ]
    const arr3 = [
      { x: 20, y: 10 },
      { a: 2, b: 1 },
    ]

    expect(canonicalizeJson(arr1)).toBe(canonicalizeJson(arr2))
    expect(canonicalizeJson(arr1)).toBe('[{"a":2,"b":1},{"x":20,"y":10}]')
    // Array ordering must NOT be sorted arbitrarily:
    expect(canonicalizeJson(arr1)).not.toBe(canonicalizeJson(arr3))
  })
})

describe('tryCanonicalizeJsonString', () => {
  it('canonicalizes JSON string payloads', () => {
    const jsonA = '{"score": 95, "verdict": "pass"}'
    const jsonB = '{"verdict": "pass", "score": 95}'

    expect(tryCanonicalizeJsonString(jsonA)).toBe(tryCanonicalizeJsonString(jsonB))
    expect(tryCanonicalizeJsonString(jsonA)).toBe('{"score":95,"verdict":"pass"}')
  })

  it('returns non-JSON string untouched', () => {
    const plain = 'Some plain text that is not JSON'
    expect(tryCanonicalizeJsonString(plain)).toBe(plain)
  })
})
