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

  it('omits object properties whose values are undefined, matching standard JSON semantics', () => {
    const withUndefined = { a: 1, b: undefined, c: 'hello' }
    const withoutUndefined = { a: 1, c: 'hello' }

    expect(canonicalizeJson(withUndefined)).toBe('{"a":1,"c":"hello"}')
    expect(canonicalizeJson(withUndefined)).toBe(canonicalizeJson(withoutUndefined))
  })

  it('normalizes array elements with undefined values to null, matching JSON array semantics', () => {
    const arr = [1, undefined, 'test']
    expect(canonicalizeJson(arr)).toBe('[1,null,"test"]')
  })

  it('fails closed and throws TypeError on top-level undefined', () => {
    expect(() => canonicalizeJson(undefined)).toThrow(TypeError)
    expect(() => canonicalizeJson(undefined)).toThrow('Cannot canonicalize undefined as JSON')
  })

  it('fails closed and throws TypeError on unsupported types (functions, symbols)', () => {
    expect(() => canonicalizeJson(() => 'noop')).toThrow(TypeError)
    expect(() => canonicalizeJson(Symbol('test'))).toThrow(TypeError)

    // Properties with function/symbol are omitted in objects
    const objWithFunc = { a: 1, fn: () => 'noop', sym: Symbol('s') }
    expect(canonicalizeJson(objWithFunc)).toBe('{"a":1}')
  })

  it('fails closed and throws TypeError on NaN, Infinity, and -Infinity (never silently serializing to null)', () => {
    // Top-level
    expect(() => canonicalizeJson(NaN)).toThrow(TypeError)
    expect(() => canonicalizeJson(NaN)).toThrow('Cannot canonicalize non-finite number NaN as JSON')

    expect(() => canonicalizeJson(Infinity)).toThrow(TypeError)
    expect(() => canonicalizeJson(Infinity)).toThrow(
      'Cannot canonicalize non-finite number Infinity as JSON',
    )

    expect(() => canonicalizeJson(-Infinity)).toThrow(TypeError)
    expect(() => canonicalizeJson(-Infinity)).toThrow(
      'Cannot canonicalize non-finite number -Infinity as JSON',
    )

    // Nested in objects
    expect(() => canonicalizeJson({ val: NaN })).toThrow(TypeError)
    expect(() => canonicalizeJson({ val: Infinity })).toThrow(TypeError)
    expect(() => canonicalizeJson({ val: -Infinity })).toThrow(TypeError)

    // Nested in arrays
    expect(() => canonicalizeJson([1, NaN, 2])).toThrow(TypeError)
    expect(() => canonicalizeJson([1, Infinity, 2])).toThrow(TypeError)
    expect(() => canonicalizeJson([1, -Infinity, 2])).toThrow(TypeError)
  })

  it('fails closed on non-plain objects such as Date, Map, and Set (never silently serializing to {})', () => {
    expect(() => canonicalizeJson(new Date())).toThrow(TypeError)
    expect(() => canonicalizeJson(new Date())).toThrow(
      'Cannot canonicalize non-plain object Date as JSON',
    )

    expect(() => canonicalizeJson(new Map())).toThrow(TypeError)
    expect(() => canonicalizeJson(new Map())).toThrow(
      'Cannot canonicalize non-plain object Map as JSON',
    )

    expect(() => canonicalizeJson(new Set())).toThrow(TypeError)
    expect(() => canonicalizeJson(new Set())).toThrow(
      'Cannot canonicalize non-plain object Set as JSON',
    )

    expect(() => canonicalizeJson(new RegExp('test'))).toThrow(TypeError)

    class CustomModel {
      id = 1
    }
    expect(() => canonicalizeJson(new CustomModel())).toThrow(TypeError)
    expect(() => canonicalizeJson(new CustomModel())).toThrow(
      'Cannot canonicalize non-plain object CustomModel as JSON',
    )

    // Nested non-plain objects in objects and arrays
    expect(() => canonicalizeJson({ created: new Date() })).toThrow(TypeError)
    expect(() => canonicalizeJson([new Map()])).toThrow(TypeError)
  })

  it('accepts dictionary objects created with Object.create(null)', () => {
    const dict = Object.create(null) as Record<string, number>
    dict.b = 2
    dict.a = 1
    expect(canonicalizeJson(dict)).toBe('{"a":1,"b":2}')
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
