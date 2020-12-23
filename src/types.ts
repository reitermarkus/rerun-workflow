import * as github from '@actions/github'
import { components as OCTOKIT_OPENAPI_TYPES } from '@octokit/openapi-types'

export type Octokit = ReturnType<typeof github.getOctokit>

export type PullRequest = OCTOKIT_OPENAPI_TYPES['schemas']['pull-request']
export type WorkflowRun = OCTOKIT_OPENAPI_TYPES['schemas']['workflow-run']

export enum RerunCondition {
  // Always re-run unless already queued or in progress.
  Always,
  // Re-run only when completed and failed.
  OnFailure,
  // Never re-run, only unlabel.
  Never,
}
