import * as github from '@actions/github'

export type Octokit = ReturnType<typeof github.getOctokit>

export type PullRequest = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data']
export type WorkflowRun = Awaited<
  ReturnType<Octokit['rest']['actions']['listWorkflowRuns']>
>['data']['workflow_runs'][0]

export enum RerunCondition {
  // Always re-run unless already queued or in progress.
  Always,
  // Re-run only when completed and failed.
  OnFailure,
  // Never re-run, only unlabel.
  Never,
}
