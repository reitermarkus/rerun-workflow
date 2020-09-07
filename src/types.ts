import * as github from '@actions/github'
import { ActionsListWorkflowRunsResponseData, PullsGetResponseData } from '@octokit/types'

export type Octokit = ReturnType<typeof github.getOctokit>
export type PullRequest = PullsGetResponseData
export type WorkflowRun = ActionsListWorkflowRunsResponseData['workflow_runs'][0]

export enum RerunCondition {
  // Always re-run unless already queued or in progress.
  Always,
  // Re-run only when completed and failed.
  OnFailure,
  // Never re-run, only unlabel.
  Never,
}
