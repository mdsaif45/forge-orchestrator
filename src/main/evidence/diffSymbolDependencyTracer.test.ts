import { describe, expect, it } from 'vitest'
import {
  traceSymbolDependencies,
  type ModifiedSymbol,
  type SymbolConsumerMap,
} from './diffSymbolDependencyTracer'

describe('diffSymbolDependencyTracer (EVIDENCE-017)', () => {
  it('returns clean report for empty symbol set', () => {
    const report = traceSymbolDependencies([])
    expect(report.totalSymbols).toBe(0)
    expect(report.isContractSafe).toBe(true)
    expect(report.highestRiskLevel).toBe('LOW')
  })

  it('detects CRITICAL risk when an active referenced symbol is removed', () => {
    const symbols: ModifiedSymbol[] = [
      {
        name: 'validateToken',
        filePath: 'src/main/auth/token.ts',
        changeType: 'REMOVED',
        isExported: true,
      },
    ]

    const consumerMap: SymbolConsumerMap = {
      validateToken: ['src/main/server.ts', 'src/main/cli.ts'],
    }

    const report = traceSymbolDependencies(symbols, consumerMap)
    expect(report.affectedConsumersCount).toBe(2)
    expect(report.highestRiskLevel).toBe('CRITICAL')
    expect(report.isContractSafe).toBe(false)
    expect(report.contractRisks[0]?.reason).toContain('was removed; consumer will fail to resolve')
  })

  it('detects HIGH risk when an exported public symbol is modified', () => {
    const symbols: ModifiedSymbol[] = [
      {
        name: 'calculateBackoff',
        filePath: 'src/main/workflows/retry.ts',
        changeType: 'MODIFIED',
        isExported: true,
      },
    ]

    const consumerMap: SymbolConsumerMap = {
      calculateBackoff: ['src/main/workflows/executor.ts'],
    }

    const report = traceSymbolDependencies(symbols, consumerMap)
    expect(report.affectedConsumersCount).toBe(1)
    expect(report.highestRiskLevel).toBe('HIGH')
    expect(report.isContractSafe).toBe(false)
  })

  it('ignores self-referencing consumer files', () => {
    const symbols: ModifiedSymbol[] = [
      {
        name: 'helperFunc',
        filePath: 'src/main/utils.ts',
        changeType: 'MODIFIED',
        isExported: false,
      },
    ]

    const consumerMap: SymbolConsumerMap = {
      helperFunc: ['src/main/utils.ts'],
    }

    const report = traceSymbolDependencies(symbols, consumerMap)
    expect(report.affectedConsumersCount).toBe(0)
    expect(report.contractRisks.length).toBe(0)
    expect(report.highestRiskLevel).toBe('LOW')
    expect(report.isContractSafe).toBe(true)
  })

  it('handles multiple symbols and aggregates unique consumer files', () => {
    const symbols: ModifiedSymbol[] = [
      {
        name: 'symA',
        filePath: 'src/main/a.ts',
        changeType: 'ADDED',
      },
      {
        name: 'symB',
        filePath: 'src/main/b.ts',
        changeType: 'MODIFIED',
        isExported: false,
      },
    ]

    const consumerMap: SymbolConsumerMap = {
      symA: ['src/main/consumer.ts'],
      symB: ['src/main/consumer.ts', 'src/main/other.ts'],
    }

    const report = traceSymbolDependencies(symbols, consumerMap)
    expect(report.affectedConsumersCount).toBe(2)
    expect(report.affectedConsumerFiles).toEqual(['src/main/consumer.ts', 'src/main/other.ts'])
    expect(report.highestRiskLevel).toBe('MEDIUM')
  })
})
