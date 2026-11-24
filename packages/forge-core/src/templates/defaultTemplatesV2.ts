import type { WorkflowTemplateV2 } from '@shared/domain'

export const DEFAULT_TEMPLATES_V2: readonly WorkflowTemplateV2[] = [
  {
    id: 'cr-sdlc',
    name: 'CR SDLC (Planning -> HLD -> LLD)',
    description:
      'Planning -> Requirements & Design (HLD) -> Low Level Design (LLD), grounded in the bound codebase via AST and tests.',
    version: 1,
    status: 'published',
    category: 'Software Engineering',
    nodes: [
      {
        id: 'agent-1',
        title: 'Requirements Analyst',
        templateId: 'requirements-analyst',
        type: 'agent',
        runtimeType: 'forge-native',
        config: {
          providerId: 'ollama',
          modelId: 'qwen2.5',
          systemPrompt:
            'You are a Principal Requirements Analyst. Analyze task requirements, identify constraints, and produce an unambiguous specification.',
          skills: ['requirements-analysis', 'repo-inspection'],
          permissionMode: 'read-only',
        },
        inputs: [
          {
            name: 'task_brief',
            kind: 'user_prompt',
            required: true,
            formHint: 'Describe the feature or change request',
          },
        ],
        outputs: [
          {
            name: 'spec',
            kind: 'final_specification',
            format: 'markdown',
            requiredH1: '# 01 Requirements Specification',
            requiredSections: [
              '1. Objective & Scope',
              '2. Functional Requirements',
              '3. Edge Cases & Constraints',
            ],
          },
        ],
        position: { x: 80, y: 120 },
      },
      {
        id: 'agent-2',
        title: 'Solution Architect',
        templateId: 'solution-architect',
        type: 'agent',
        runtimeType: 'cli-agent',
        config: {
          systemPrompt:
            'You are a Principal Solution Architect. Design a technical approach for implementing the specification, detailing components, interfaces, and architecture decisions.',
          skills: ['system-architecture', 'decision-proposals'],
          permissionMode: 'developer',
        },
        inputs: [
          {
            name: 'spec',
            kind: 'final_specification',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'hld',
            kind: 'solution_architecture',
            format: 'markdown',
            requiredH1: '# 02 Solution Architecture',
            requiredSections: [
              '1. Architecture Overview',
              '2. Component Diagram (Text Form)',
              '3. Key Design Decisions',
            ],
          },
        ],
        position: { x: 420, y: 240 },
      },
      {
        id: 'agent-3',
        title: 'Implementation Planner',
        templateId: 'implementation-planner',
        type: 'agent',
        runtimeType: 'forge-native',
        config: {
          providerId: 'ollama',
          modelId: 'qwen2.5',
          systemPrompt:
            'Break down the architecture into discrete, ordered code modification steps and test targets.',
          skills: ['implementation-planning'],
          permissionMode: 'developer',
        },
        inputs: [
          {
            name: 'architecture',
            kind: 'solution_architecture',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'plan',
            kind: 'implementation_plan',
            format: 'markdown',
            requiredH1: '# 03 Implementation Plan',
            requiredSections: ['1. File Changes by Component', '2. Verification Steps'],
          },
        ],
        position: { x: 760, y: 120 },
      },
      {
        id: 'gate-1',
        title: 'Approve Blueprint & Lock Decisions',
        type: 'user_gate',
        runtimeType: 'human',
        config: {
          skills: [],
          permissionMode: 'read-only',
        },
        inputs: [
          {
            name: 'plan',
            kind: 'implementation_plan',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'approved_plan',
            kind: 'approved_plan',
            format: 'markdown',
            requiredSections: [],
          },
        ],
        position: { x: 1080, y: 240 },
      },
      {
        id: 'agent-4',
        title: 'Implementation Agent',
        templateId: 'implementation-agent',
        type: 'agent',
        runtimeType: 'cli-agent',
        config: {
          systemPrompt:
            'Implement the approved plan inside the isolated git worktree. Modify only necessary files, follow established idioms, and avoid extraneous refactorings.',
          skills: ['code-implementation', 'ast-editing'],
          permissionMode: 'developer',
        },
        inputs: [
          {
            name: 'approved_plan',
            kind: 'approved_plan',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'diff',
            kind: 'code_diff',
            format: 'diff',
            requiredSections: [],
          },
        ],
        position: { x: 1400, y: 120 },
      },
      {
        id: 'verify-1',
        title: 'Verification Engine (Build & Test)',
        type: 'verification',
        runtimeType: 'forge-engine',
        config: {
          skills: [],
          permissionMode: 'read-only',
        },
        inputs: [
          {
            name: 'diff',
            kind: 'code_diff',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'test_evidence',
            kind: 'verification_results',
            format: 'json',
            requiredSections: [],
          },
        ],
        position: { x: 1720, y: 240 },
      },
      {
        id: 'agent-5',
        title: 'Code Reviewer',
        templateId: 'code-reviewer',
        type: 'agent',
        runtimeType: 'forge-native',
        config: {
          providerId: 'ollama',
          modelId: 'qwen2.5',
          systemPrompt:
            'Audit the diff against the original architecture decisions and test results. Check for security regressions, edge cases, and code hygiene.',
          skills: ['code-audit', 'security-review'],
          permissionMode: 'read-only',
        },
        inputs: [
          {
            name: 'diff',
            kind: 'code_diff',
            required: true,
          },
          {
            name: 'verification',
            kind: 'verification_results',
            required: true,
          },
        ],
        outputs: [
          {
            name: 'review',
            kind: 'review_report',
            format: 'markdown',
            requiredH1: '# 05 Code Review Report',
            requiredSections: [
              '1. Executive Summary',
              '2. Verification Evidence',
              '3. Verdict (PASS / REVISE)',
            ],
          },
        ],
        position: { x: 2040, y: 120 },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'agent-1',
        sourceHandle: 'spec',
        target: 'agent-2',
        targetHandle: 'spec',
      },
      {
        id: 'e2',
        source: 'agent-2',
        sourceHandle: 'hld',
        target: 'agent-3',
        targetHandle: 'architecture',
      },
      {
        id: 'e3',
        source: 'agent-3',
        sourceHandle: 'plan',
        target: 'gate-1',
        targetHandle: 'plan',
      },
      {
        id: 'e4',
        source: 'gate-1',
        sourceHandle: 'approved_plan',
        target: 'agent-4',
        targetHandle: 'approved_plan',
      },
      {
        id: 'e5',
        source: 'agent-4',
        sourceHandle: 'diff',
        target: 'verify-1',
        targetHandle: 'diff',
      },
      {
        id: 'e6',
        source: 'agent-4',
        sourceHandle: 'diff',
        target: 'agent-5',
        targetHandle: 'diff',
      },
      {
        id: 'e7',
        source: 'verify-1',
        sourceHandle: 'test_evidence',
        target: 'agent-5',
        targetHandle: 'verification',
      },
    ],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'design-doc',
    name: 'Design Document creation (copy)',
    description: 'Collaborative architectural RFC design with adversarial critique and review.',
    version: 2,
    status: 'published',
    category: 'Architecture',
    nodes: [
      {
        id: 'd-1',
        title: 'Requirements Analyst',
        type: 'agent',
        runtimeType: 'forge-native',
        config: {
          skills: ['requirements'],
          permissionMode: 'read-only',
        },
        inputs: [{ name: 'goal', kind: 'user_prompt', required: true }],
        outputs: [
          {
            name: 'reqs',
            kind: 'requirements',
            format: 'markdown',
            requiredSections: [],
          },
        ],
        position: { x: 80, y: 150 },
      },
      {
        id: 'd-2',
        title: 'Requirements Critic',
        type: 'agent',
        runtimeType: 'forge-native',
        config: {
          skills: ['adversarial-critique'],
          permissionMode: 'read-only',
        },
        inputs: [{ name: 'reqs', kind: 'requirements', required: true }],
        outputs: [
          {
            name: 'critique',
            kind: 'critique_report',
            format: 'markdown',
            requiredSections: [],
          },
        ],
        position: { x: 420, y: 80 },
      },
      {
        id: 'd-3',
        title: 'Solution Architect',
        type: 'agent',
        runtimeType: 'cli-agent',
        config: {
          skills: ['architecture'],
          permissionMode: 'developer',
        },
        inputs: [
          { name: 'reqs', kind: 'requirements', required: true },
          { name: 'critique', kind: 'critique_report', required: true },
        ],
        outputs: [
          {
            name: 'design',
            kind: 'solution_architecture',
            format: 'markdown',
            requiredSections: [],
          },
        ],
        position: { x: 760, y: 150 },
      },
    ],
    edges: [
      { id: 'de-1', source: 'd-1', target: 'd-2' },
      { id: 'de-2', source: 'd-1', target: 'd-3' },
      { id: 'de-3', source: 'd-2', target: 'd-3' },
    ],
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
]
