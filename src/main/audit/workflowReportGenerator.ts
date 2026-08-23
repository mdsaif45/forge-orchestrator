import type { WorkflowDetailView, DecisionView, OpenQuestionView } from '@shared/ipc'

export interface WorkflowReportData {
  readonly workflow: WorkflowDetailView
  readonly projectName: string
  readonly decisions?: readonly DecisionView[]
  readonly questions?: readonly OpenQuestionView[]
}

/**
 * Generates a self-contained, human-readable Markdown audit report for a completed or active workflow.
 */
export function generateWorkflowReportMarkdown(data: WorkflowReportData): string {
  const { workflow, projectName, decisions = [], questions = [] } = data

  const lines: string[] = []

  lines.push(`# Forge Workflow Audit Report`)
  lines.push(``)
  lines.push(`**Project:** ${projectName}`)
  lines.push(`**Workflow ID:** \`${workflow.id}\``)
  lines.push(`**Task ID:** \`${workflow.taskId}\``)
  lines.push(`**Template:** \`${workflow.templateId}\``)
  lines.push(`**Final State:** \`${workflow.state}\``)
  lines.push(
    `**Iterations:** ${String(workflow.iteration)} / ${String(workflow.limits.maxIterations)}`,
  )
  lines.push(`**Started At:** ${workflow.startedAt}`)
  lines.push(`**Finished At:** ${workflow.finishedAt ?? 'In Progress'}`)
  if (workflow.haltReason !== null && workflow.haltReason.trim() !== '') {
    lines.push(`**Halt Reason:** ${workflow.haltReason}`)
  }
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  // 1. Locked Decisions
  lines.push(`## 1. Architectural Decisions`)
  if (decisions.length === 0) {
    lines.push(`*No decisions were recorded for this workflow.*`)
  } else {
    for (const d of decisions) {
      lines.push(`- **[${d.status.toUpperCase()}]** \`${d.id}\`: **${d.statement}**`)
      lines.push(`  - Rationale: ${d.rationale}`)
      if (d.lockedAt !== null) {
        lines.push(`  - *Locked at ${d.lockedAt}*`)
      }
    }
  }
  lines.push(``)

  // 2. Questions & Clarifications
  lines.push(`## 2. Clarifications & Questions`)
  if (questions.length === 0) {
    lines.push(`*No user clarification questions were raised.*`)
  } else {
    for (const q of questions) {
      lines.push(`- **Question (\`${q.id}\`):** ${q.question}`)
      lines.push(`  - Answer: ${q.answer ?? '*Pending answer*'}`)
    }
  }
  lines.push(``)

  // 3. Execution Timeline
  lines.push(`## 3. Step Execution Timeline`)
  if (workflow.steps.length === 0) {
    lines.push(`*No steps have executed yet.*`)
  } else {
    lines.push(`| # | Step ID | Role | State | Verdict | Started | Finished |`)
    lines.push(`|---|---------|------|-------|---------|---------|----------|`)
    workflow.steps.forEach((step, idx) => {
      const verdictStr = step.verdict ?? '-'
      const startedStr = step.startedAt ?? '-'
      const finishedStr = step.finishedAt ?? '-'
      lines.push(
        `| ${String(idx + 1)} | \`${step.id}\` | \`${step.role}\` | \`${step.state}\` | ${verdictStr} | ${startedStr} | ${finishedStr} |`,
      )
    })
  }

  lines.push(``)
  lines.push(`---`)
  lines.push(
    `*Report generated automatically by Forge Orchestrator at ${new Date().toISOString()}*`,
  )

  return lines.join('\n')
}
