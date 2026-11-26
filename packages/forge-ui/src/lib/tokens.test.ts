import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FORGE_CONTROL_HEIGHTS,
  FORGE_ELEVATION_TOKENS,
  FORGE_SURFACES,
  FORGE_TYPOGRAPHY_CLASSES,
  FORGE_Z_LAYERS,
} from './tokens'

describe('@forge/ui token and stylesheet contracts', () => {
  const stylesDir = resolve(import.meta.dirname, '../styles')
  const tokensCss = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')
  const typographyCss = readFileSync(resolve(stylesDir, 'typography.css'), 'utf8')
  const spacingCss = readFileSync(resolve(stylesDir, 'spacing.css'), 'utf8')
  const designSystemCss = readFileSync(resolve(stylesDir, 'design-system.css'), 'utf8')

  it('defines all documented control heights and elevation tokens in tokens.css', () => {
    for (const cssVar of Object.values(FORGE_CONTROL_HEIGHTS)) {
      const name = cssVar.slice('var('.length, -1)
      expect(tokensCss).toContain(`${name}:`)
    }
    for (const cssVar of Object.values(FORGE_ELEVATION_TOKENS)) {
      const name = cssVar.slice('var('.length, -1)
      expect(tokensCss).toContain(`${name}:`)
    }
    for (const cssVar of Object.values(FORGE_Z_LAYERS)) {
      const name = cssVar.slice('var('.length, -1)
      expect(tokensCss).toContain(`${name}:`)
    }
  })

  it('defines every typography class and surface helper in stylesheets', () => {
    for (const cls of Object.values(FORGE_TYPOGRAPHY_CLASSES)) {
      expect(typographyCss).toContain(`.${cls}`)
    }
    for (const cls of Object.values(FORGE_SURFACES)) {
      expect(designSystemCss).toContain(`.${cls}`)
    }
    expect(spacingCss).toContain('.forge-grid-cards')
    expect(spacingCss).toContain('.forge-grid-split')
  })

  it('keeps dark baseline plus light and azure theme blocks in tokens.css', () => {
    expect(tokensCss).toContain('--color-canvas: #131315;')
    expect(tokensCss).toContain('--color-accent: #f97316;')
    expect(tokensCss).toContain("[data-theme='light']")
    expect(tokensCss).toContain("[data-theme='azure']")
  })
})
