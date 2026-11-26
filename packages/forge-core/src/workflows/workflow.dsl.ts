import { z } from 'zod'
import {
  artifactFormatSchema,
  edgeConditionSchema,
  loopPolicySchema,
  nodePositionSchema,
  nodeTypeSchema,
  roleSchema,
  runtimeTypeSchema,
  templateStatusSchema,
} from '@shared/domain'

export const dslParameterTypeSchema = z.enum(['string', 'number', 'boolean', 'string[]'])
export type DslParameterType = z.infer<typeof dslParameterTypeSchema>

export const dslParameterSpecSchema = z.strictObject({
  type: dslParameterTypeSchema,
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  description: z.string().optional(),
})
export type DslParameterSpec = z.infer<typeof dslParameterSpecSchema>

export const dslSlotSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1).default('artifact'),
  required: z.boolean().default(true),
  formHint: z.string().optional(),
  description: z.string().optional(),
})
export type DslSlotAst = z.infer<typeof dslSlotSchema>

export const dslOutputSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1).default('artifact'),
  format: artifactFormatSchema.default('markdown'),
  required: z.boolean().optional(),
  requiredH1: z.string().optional(),
  requiredSections: z.array(z.string()).default([]),
  description: z.string().optional(),
})
export type DslOutputAst = z.infer<typeof dslOutputSchema>

export const dslNodeConfigSchema = z.strictObject({
  agentExecutable: z.string().optional(),
  argsTemplate: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).default([]),
  permissionMode: z.enum(['read-only', 'developer', 'full-access']).default('developer'),
  role: roleSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export type DslNodeConfigAst = z.infer<typeof dslNodeConfigSchema>

export const dslNodeSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  type: nodeTypeSchema.default('agent'),
  runtimeType: runtimeTypeSchema.default('forge-native'),
  templateId: z.string().optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  config: dslNodeConfigSchema.optional(),
  inputs: z.array(dslSlotSchema).default([]),
  outputs: z.array(dslOutputSchema).default([]),
  position: nodePositionSchema.optional(),
})
export type DslNodeAst = z.infer<typeof dslNodeSchema>

export const dslEdgeSchema = z.strictObject({
  id: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  isFeedback: z.boolean().default(false),
  isDefault: z.boolean().optional(),
  condition: edgeConditionSchema.optional(),
})
export type DslEdgeAst = z.infer<typeof dslEdgeSchema>

export const workflowDslDocumentSchema = z.strictObject({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().min(1).default('Declarative Forge workflow graph'),
  version: z.number().int().positive().default(1),
  status: templateStatusSchema.default('draft'),
  category: z.string().min(1).default('Custom'),
  parameters: z.record(z.string().min(1), dslParameterSpecSchema).default({}),
  loopPolicy: loopPolicySchema.optional(),
  nodes: z.array(dslNodeSchema).min(1),
  edges: z.array(dslEdgeSchema).default([]),
})
export type WorkflowDslDocument = z.infer<typeof workflowDslDocumentSchema>
export type WorkflowDslDocumentInput = z.input<typeof workflowDslDocumentSchema>
