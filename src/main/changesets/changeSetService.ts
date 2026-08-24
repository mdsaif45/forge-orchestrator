import { changeSetIdSchema, projectIdSchema, type ChangeSet } from '@shared/domain'
import type { ChangedFileView, ChangeSetView } from '@shared/ipc'
import type { ChangeSetStore } from '../db/changeSetStore'
import { GitService } from '../git'
import type { ProjectService } from '../projects/projectService'

export interface ChangeSetServiceOptions {
  readonly changeSets: ChangeSetStore
  readonly projects: ProjectService
}

export class ChangeSetService {
  constructor(private readonly options: ChangeSetServiceOptions) {}

  list(projectId: string): readonly ChangeSetView[] {
    const pId = projectIdSchema.parse(projectId)
    const list = this.options.changeSets.listForProject(pId)
    return list.map(toChangeSetView)
  }

  get(changeSetId: string): ChangeSetView | null {
    const csId = changeSetIdSchema.parse(changeSetId)
    const cs = this.options.changeSets.find(csId)
    return cs === null ? null : toChangeSetView(cs)
  }

  async getWorkingDiff(projectId: string): Promise<{
    readonly files: readonly ChangedFileView[]
    readonly patch: string
  }> {
    const git = await this.getGitService(projectId)
    const baseSha = (await git.headSha()) ?? 'HEAD'
    const diff = await git.diffWorktree(baseSha)

    return {
      files: diff.files.map((f) => ({
        path: f.path,
        changeType: f.changeType,
        previousPath: f.previousPath,
        insertions: f.insertions,
        deletions: f.deletions,
      })),
      patch: diff.patch,
    }
  }

  /** Every file git tracks or would track, for browsing the repository (#107). */
  async listFiles(projectId: string): Promise<{ readonly files: readonly string[] }> {
    const git = await this.getGitService(projectId)
    return { files: await git.listWorktreeFiles() }
  }

  async readFile(projectId: string, relativePath: string): Promise<{ readonly content: string }> {
    const git = await this.getGitService(projectId)
    const content = await git.readFileInWorktree(relativePath)
    return { content }
  }

  async writeFile(
    projectId: string,
    relativePath: string,
    content: string,
  ): Promise<{ readonly success: boolean }> {
    const git = await this.getGitService(projectId)
    await git.writeFileInWorktree(relativePath, content)
    return { success: true }
  }

  private async getGitService(projectId: string): Promise<GitService> {
    const pId = projectIdSchema.parse(projectId)
    const projectDetail = await this.options.projects.get(pId)
    if (projectDetail === null) {
      throw new Error(`Project ${projectId} not found`)
    }
    return new GitService({ repositoryPath: projectDetail.project.repository.absolutePath })
  }
}

function toChangeSetView(cs: ChangeSet): ChangeSetView {
  return {
    id: cs.id,
    baseSha: cs.baseSha,
    headSha: cs.headSha,
    files: cs.files.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      previousPath: f.previousPath,
      insertions: f.insertions,
      deletions: f.deletions,
    })),
    patch: cs.patch,
    authorActor: cs.authorActor,
    stepId: cs.stepId,
    taskId: cs.taskId,
    correctsChangeSetId: cs.correctsChangeSetId,
    reviewVerdict: cs.reviewVerdict,
    discrepancies: cs.discrepancies.map((d) => ({
      path: d.path,
      kind: d.kind,
      detail: d.detail,
    })),
    capturedAt: cs.capturedAt,
  }
}
