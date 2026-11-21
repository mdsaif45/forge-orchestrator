/**
 * EVIDENCE-017: Changeset AST-Aware Critical Symbol Dependency Trace Auditing.
 *
 * Traces modified and removed symbols against downstream file consumers, evaluates
 * public contract break risks, and categorizes blast-radius risk levels.
 */

export type SymbolChangeType = 'ADDED' | 'MODIFIED' | 'REMOVED'

export type ContractRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface ModifiedSymbol {
  name: string
  filePath: string
  changeType: SymbolChangeType
  isExported?: boolean | undefined
}

export type SymbolConsumerMap = Record<string, string[]>

export interface ContractRisk {
  symbolName: string
  sourceFile: string
  consumerFile: string
  riskLevel: ContractRiskLevel
  reason: string
}

export interface SymbolTraceReport {
  totalSymbols: number
  affectedConsumersCount: number
  affectedConsumerFiles: string[]
  contractRisks: ContractRisk[]
  highestRiskLevel: ContractRiskLevel
  isContractSafe: boolean
  summary: string
}

export function traceSymbolDependencies(
  modifiedSymbols: ModifiedSymbol[],
  consumerMap: SymbolConsumerMap = {},
): SymbolTraceReport {
  if (modifiedSymbols.length === 0) {
    return {
      totalSymbols: 0,
      affectedConsumersCount: 0,
      affectedConsumerFiles: [],
      contractRisks: [],
      highestRiskLevel: 'LOW',
      isContractSafe: true,
      summary: 'Zero modified symbols submitted. Contract surface is unaffected.',
    }
  }

  const affectedConsumersSet = new Set<string>()
  const contractRisks: ContractRisk[] = []
  let highestRisk: ContractRiskLevel = 'LOW'

  const rankRisk = (level: ContractRiskLevel): number => {
    switch (level) {
      case 'CRITICAL':
        return 4
      case 'HIGH':
        return 3
      case 'MEDIUM':
        return 2
      case 'LOW':
        return 1
    }
  }

  for (const sym of modifiedSymbols) {
    const trimmedName = sym.name.trim()
    if (!trimmedName) {
      continue
    }

    const consumers = consumerMap[trimmedName] ?? []
    const isExported = sym.isExported ?? true

    for (const consumerFile of consumers) {
      // Ignore self-references in the same file
      if (consumerFile === sym.filePath) {
        continue
      }

      affectedConsumersSet.add(consumerFile)

      let riskLevel: ContractRiskLevel
      let reason: string

      if (sym.changeType === 'REMOVED') {
        riskLevel = 'CRITICAL'
        reason = `Referenced symbol "${trimmedName}" was removed; consumer will fail to resolve.`
      } else if (sym.changeType === 'MODIFIED') {
        if (isExported) {
          riskLevel = 'HIGH'
          reason = `Public interface symbol "${trimmedName}" was modified; requires downstream verification.`
        } else {
          riskLevel = 'MEDIUM'
          reason = `Internal symbol "${trimmedName}" was modified with cross-file references.`
        }
      } else {
        riskLevel = 'LOW'
        reason = `New symbol "${trimmedName}" introduced.`
      }

      if (rankRisk(riskLevel) > rankRisk(highestRisk)) {
        highestRisk = riskLevel
      }

      contractRisks.push({
        symbolName: trimmedName,
        sourceFile: sym.filePath,
        consumerFile,
        riskLevel,
        reason,
      })
    }
  }

  const affectedConsumerFiles = Array.from(affectedConsumersSet).sort()
  const isContractSafe =
    highestRisk === 'LOW' || (highestRisk === 'MEDIUM' && contractRisks.length <= 3)

  const summary = `Symbol trace evaluated ${String(modifiedSymbols.length)} symbol(s) across ${String(affectedConsumerFiles.length)} downstream file(s). Highest risk: ${highestRisk}.`

  return {
    totalSymbols: modifiedSymbols.length,
    affectedConsumersCount: affectedConsumerFiles.length,
    affectedConsumerFiles,
    contractRisks,
    highestRiskLevel: highestRisk,
    isContractSafe,
    summary,
  }
}
