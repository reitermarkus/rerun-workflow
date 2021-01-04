import * as core from '@actions/core'
import * as github from '@actions/github'
import { isPresent } from 'ts-is-present'

import { Octokit, PullRequest, WorkflowRun } from './types'

export const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target']

export async function getPullRequest(octokit: Octokit, number: number): Promise<PullRequest> {
  const response = await octokit.pulls.get({ ...github.context.repo, pull_number: number })
  return response.data
}

export function isSuccessfulOrCancelled(workflowRun: WorkflowRun): boolean {
  const { status, conclusion } = workflowRun
  return status === 'completed' && (conclusion === 'success' || conclusion === 'cancelled')
}

function latestWorkflowRunForEvent(workflowRuns: WorkflowRun[], event: string): WorkflowRun | null {
  return workflowRuns
    .filter(w => w.event === event)
    .sort((a, b) => {
      const updatedA = a.updated_at
      const updatedB = b.updated_at

      return updatedA && updatedB ? Date.parse(updatedB) - Date.parse(updatedA) : 0
    })[0]
}

/// Returns the workflow run for the latest commit of a pull request.
export async function latestWorkflowRunsForPullRequest(
  octokit: Octokit,
  workflow: string,
  pullRequest: PullRequest
): Promise<WorkflowRun[]> {
  core.info(`Searching workflows for pull request ${pullRequest.number}…`)

  const response = await octokit.actions.listWorkflowRuns({
    ...github.context.repo,
    // Workflow ID can be a string or a number.
    workflow_id: workflow as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    event: PULL_REQUEST_EVENTS.join(' OR '),
    branch: pullRequest.head.ref,
    per_page: 100,
  })

  const workflowRuns = response.data.workflow_runs

  const matchingWorkflowRuns = workflowRuns.filter(
    ({ head_branch, head_sha }) => head_branch === pullRequest.head.ref && head_sha === pullRequest.head.sha
  )

  if (matchingWorkflowRuns.length === 0) {
    core.warning(`No matching workflow runs found for pull request ${pullRequest.number}.`)
    return []
  }

  const latestWorkflowRuns = PULL_REQUEST_EVENTS.map(event =>
    latestWorkflowRunForEvent(matchingWorkflowRuns, event)
  ).filter(isPresent)

  core.info(
    `Found ${latestWorkflowRuns.length} matching workflow runs for pull request ${
      pullRequest.number
    }: ${latestWorkflowRuns.map(r => r.id).join(', ')}`
  )

  return latestWorkflowRuns
}

export async function pullRequestsForWorkflowRun(
  octokit: Octokit,
  workflowRun: WorkflowRun
): Promise<number[]> {
  let pullRequests = (workflowRun.pull_requests as PullRequest[]).map(({ number }) => number)

  if (pullRequests.length === 0) {
    const headRepo = workflowRun.head_repository
    const headBranch = workflowRun.head_branch
    const headSha = workflowRun.head_sha
    const headRepoOwner = headRepo.owner?.login

    if (!headRepoOwner) return []

    pullRequests = (
      await octokit.pulls.list({
        ...github.context.repo,
        state: 'open',
        head: `${headRepoOwner}:${headBranch}`,
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      })
    ).data
      .filter(pr => pr.head.sha === headSha)
      .map(({ number }) => number)
  }

  return pullRequests
}

export async function rerunWorkflow(octokit: Octokit, id: number): Promise<void> {
  try {
    core.info(`Triggering re-run for workflow run ${id}…`)
    await octokit.actions.reRunWorkflow({
      ...github.context.repo,
      run_id: `${id}` as any,
    })
    core.info(`Re-run of workflow run ${id} successfully started.`)
  } catch (err) {
    core.setFailed(`Re-running workflow run ${id} failed: ${err}`)
  }
}

export async function removeLabelFromPullRequest(octokit: Octokit, pullRequest: PullRequest, label: string) {
  const { number, labels } = pullRequest

  const currentLabels = labels.map(l => l.name)

  if (!currentLabels.includes(label)) {
    return
  }

  try {
    core.info(`Removing '${label}' label from pull request ${number}…`)
    await octokit.issues.removeLabel({
      ...github.context.repo,
      issue_number: number,
      name: label,
    })
  } catch (err) {
    core.setFailed(`Failed removing '${label}' label from pull request ${number}: ${err}`)
  }
}
