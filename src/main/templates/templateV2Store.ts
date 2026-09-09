import {
  workflowTemplateV2Schema,
  type TemplateStatus,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { DEFAULT_TEMPLATES_V2 } from './defaultTemplatesV2'

export class TemplateV2Store {
  private readonly templates = new Map<string, WorkflowTemplateV2>()

  constructor(initialTemplates?: readonly WorkflowTemplateV2[]) {
    const list = initialTemplates ?? DEFAULT_TEMPLATES_V2
    for (const t of list) {
      this.templates.set(t.id, workflowTemplateV2Schema.parse(t))
    }
  }

  list(status?: TemplateStatus): readonly WorkflowTemplateV2[] {
    const all = [...this.templates.values()]
    if (status !== undefined) {
      return all.filter((t) => t.status === status)
    }
    return all
  }

  get(templateId: string): WorkflowTemplateV2 | null {
    return this.templates.get(templateId) ?? null
  }

  save(template: WorkflowTemplateV2): WorkflowTemplateV2 {
    const validated = workflowTemplateV2Schema.parse(template)
    this.templates.set(validated.id, validated)
    return validated
  }

  delete(templateId: string): boolean {
    return this.templates.delete(templateId)
  }
}
