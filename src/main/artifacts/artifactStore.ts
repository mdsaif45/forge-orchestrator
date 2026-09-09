import { workflowArtifactSchema, type WorkflowArtifact } from '@shared/domain'

export class ArtifactStore {
  private readonly artifacts = new Map<string, WorkflowArtifact>()

  save(artifact: WorkflowArtifact): WorkflowArtifact {
    const validated = workflowArtifactSchema.parse(artifact)
    this.artifacts.set(validated.id, validated)
    return validated
  }

  get(artifactId: string): WorkflowArtifact | null {
    return this.artifacts.get(artifactId) ?? null
  }

  list(workflowId: string, nodeId?: string): readonly WorkflowArtifact[] {
    const list = [...this.artifacts.values()].filter((a) => a.workflowId === workflowId)
    if (nodeId !== undefined) {
      return list.filter((a) => a.nodeId === nodeId)
    }
    return list
  }
}
