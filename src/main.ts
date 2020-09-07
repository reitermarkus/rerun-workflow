import { Input, get as getInput } from './input'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { isPresent } from 'ts-is-present'

import { ActionsListWorkflowRunsResponseData, PullsGetResponseData } from '@octokit/types'

import { PullRequestsWithLabelsQuery, PullRequestsWithLabels } from './generated/graphql'

enum RerunCondition {
  // Always re-run unless already queued or in progress.
  Always,
  // Re-run only when completed and failed.
  OnFailure,
  // Never re-run, only unlabel.
  Never,
}

type Context = typeof github.context
type Octokit = ReturnType<typeof github.getOctokit>
type PullRequest = PullsGetResponseData
type WorkflowRun = ActionsListWorkflowRunsResponseData['workflow_runs'][0]

const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target']

function latestWorkflowRunForEvent(workflowRuns: WorkflowRun[], event: string): WorkflowRun | null {
  return workflowRuns
    .filter(w => w.event === event)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]
}

/// Returns the workflow run for the latest commit of a pull request.
async function latestWorkflowRunsForPullRequest(
  octokit: Octokit,
  workflow: string,
  pullRequest: PullRequest
): Promise<WorkflowRun[]> {
  core.info(`Searching workflows for pull request ${pullRequest.number} ...`)

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
    core.warning('No matching workflow runs found.')
    return []
  }

  const latestWorkflowRuns = PULL_REQUEST_EVENTS.map(event =>
    latestWorkflowRunForEvent(matchingWorkflowRuns, event)
  ).filter(isPresent)

  core.info(
    `Found ${latestWorkflowRuns.length} matching workflow runs: ${latestWorkflowRuns
      .map(r => r.id)
      .join(', ')}`
  )

  return latestWorkflowRuns
}

async function rerunWorkflow(octokit: Octokit, id: number): Promise<void> {
  try {
    core.info(`Re-running workflow run ${id} …`)
    await octokit.actions.reRunWorkflow({
      ...github.context.repo,
      run_id: id,
    })
    core.info(`Re-run of workflow run ${id} successfully started.`)
  } catch (err) {
    core.setFailed(`Re-running workflow run ${id} failed: ${err}`)
  }
}

async function removeLabelFromPullRequest(octokit: Octokit, pullRequest: PullRequest, label: string) {
  const { number, labels } = pullRequest

  const currentLabels = labels.map(l => l.name)

  if (!currentLabels.includes(label)) {
    return
  }

  try {
    core.info(`Removing '${label}' label from pull request ${number} …`)
    await octokit.issues.removeLabel({
      ...github.context.repo,
      issue_number: number,
      name: label,
    })
  } catch (err) {
    core.setFailed(`Failed removing '${label}' label from pull request ${number}: ${err}`)
  }
}

async function rerunWorkflowsForPullRequest(
  octokit: Octokit,
  input: Input,
  number: number,
  rerunCondition: RerunCondition
): Promise<void> {
  const pullRequest = (await octokit.pulls.get({ ...github.context.repo, pull_number: number })).data

  const workflowRuns = await latestWorkflowRunsForPullRequest(octokit, input.workflow, pullRequest)

  let reruns = 0

  for (const workflowRun of workflowRuns) {
    switch (workflowRun.status) {
      case 'queued': {
        if (rerunCondition !== RerunCondition.Never) {
          core.info(`Workflow run ${workflowRun.id} is already queued.`)
        }
        break
      }
      case 'in_progress': {
        if (rerunCondition !== RerunCondition.Never) {
          core.info(`Workflow run ${workflowRun.id} is already re-running.`)
        }
        break
      }
      case 'completed': {
        switch (rerunCondition) {
          case RerunCondition.Never: {
            break
          }
          case RerunCondition.Always: {
            rerunWorkflow(octokit, workflowRun.id)
            reruns += 1
            break
          }
          case RerunCondition.OnFailure: {
            switch (workflowRun.conclusion) {
              case 'failure': {
                rerunWorkflow(octokit, workflowRun.id)
                reruns += 1
                break
              }
              case 'success': {
                core.info(`Workflow run ${workflowRun.id} is successful.`)
                break
              }
              case 'cancelled': {
                core.info(`Workflow run ${workflowRun.id} is cancelled.`)
                break
              }
              default: {
                core.warning(
                  `Unsupported conclusion for workflow run ${workflowRun.id}: ${workflowRun.conclusion}`
                )
                break
              }
            }
          }
        }
        break
      }
      default: {
        core.warning(`Unsupported status for workflow run ${workflowRun.id}: ${workflowRun.status}`)
        break
      }
    }
  }

  // Always remove the `onceLabel`.
  if (input.onceLabel) {
    removeLabelFromPullRequest(octokit, pullRequest, input.onceLabel)
  }

  // Only try removing the `continuousLabel` if we didn't re-run any workflows this time.
  if (reruns === 0) {
    removeContinuousLabelIfSuccessfulOrCancelled(octokit, workflowRuns, pullRequest, input)
  }
}

async function removeContinuousLabelIfSuccessfulOrCancelled(
  octokit: Octokit,
  workflowRuns: WorkflowRun[],
  pullRequest: PullRequest,
  input: Input
): Promise<void> {
  if (!input.continuousLabel) {
    return
  }

  // If all workflows finished successfully or were cancelled, stop continuously retrying by removing the `continuousLabel`.
  if (
    workflowRuns.every(
      w => w.status === 'completed' && (w.conclusion === 'success' || w.conclusion === 'cancelled')
    )
  ) {
    removeLabelFromPullRequest(octokit, pullRequest, input.continuousLabel)
  }
}

async function handlePullRequestEvent(octokit: Octokit, input: Input): Promise<void> {
  if (!github.context.payload.pull_request) {
    return
  }

  const { action, label, number } = github.context.payload

  if (
    (action === 'labeled' && label.name === input.onceLabel) ||
    ((action === 'labeled' || action === 'unlabeled') && input.triggerLabels.includes(label.name))
  ) {
    await rerunWorkflowsForPullRequest(octokit, input, number, RerunCondition.Always)
  }
}

async function handleRepoEvent(octokit: Octokit, input: Input): Promise<void> {
  const labels: string[] = [input.onceLabel, input.continuousLabel].filter(isPresent)

  core.info(`Searching for pull requests with ${labels.map(l => `'${l}'`).join(' or ')} labels.`)

  // We need to get the source code of the query since the `@octokit/graphql`
  // API doesn't (yet) support passing a `DocumentNode` object.
  const query = PullRequestsWithLabels.loc!.source!.body

  const result: PullRequestsWithLabelsQuery = await octokit.graphql({
    query,
    ...github.context.repo,
    labels,
  })

  const pullRequests = result.repository!.pullRequests!.edges!.map(pr => ({
    number: pr!.node!.number,
    labels: pr!.node!.labels!.edges!.map(l => l!.node!.name),
  }))

  for (const { number, labels } of pullRequests) {
    if (input.onceLabel && labels.includes(input.onceLabel)) {
      rerunWorkflowsForPullRequest(octokit, input, number, RerunCondition.Always)
    } else if (input.continuousLabel && labels.includes(input.continuousLabel)) {
      rerunWorkflowsForPullRequest(octokit, input, number, RerunCondition.OnFailure)
    }
  }
}

async function pullRequestsForWorkflowRun(octokit: Octokit, workflowRun: WorkflowRun): Promise<number[]> {
  let pullRequests = (workflowRun.pull_requests as PullRequest[]).map(({ number }) => number)

  if (pullRequests.length === 0) {
    const headRepo = workflowRun.head_repository
    const headBranch = workflowRun.head_branch
    const headSha = workflowRun.head_sha

    pullRequests = (
      await octokit.pulls.list({
        ...github.context.repo,
        state: 'open',
        head: `${headRepo.owner.login}:${headBranch}`,
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

async function handleWorkflowRunEvent(octokit: Octokit, input: Input): Promise<void> {
  const { action, workflow_run: workflowRun } = github.context.payload

  if (action !== 'completed') {
    return
  }

  if (!PULL_REQUEST_EVENTS.includes(workflowRun.event)) {
    return
  }

  if (workflowRun.conclusion === 'success' || workflowRun.conclusion === 'cancelled') {
    const pullRequests = await pullRequestsForWorkflowRun(octokit, workflowRun)

    if (pullRequests.length === 0) {
      core.warning(`No pull requests found for workflow run ${workflowRun.id}`)
      return
    } else {
      core.info(
        `Found ${pullRequests.length} pull requests for workflow run ${workflowRun.id}: ${pullRequests.join(
          ', '
        )}`
      )
    }

    for (const number of pullRequests) {
      rerunWorkflowsForPullRequest(octokit, input, number, RerunCondition.Never)
    }
  }
}

async function run(): Promise<void> {
  try {
    const input = getInput()

    const octokit = github.getOctokit(input.token)

    const eventName = github.context.eventName
    switch (eventName) {
      case 'pull_request':
      case 'pull_request_target': {
        await handlePullRequestEvent(octokit, input)
        break
      }
      case 'schedule':
      case 'push': {
        await handleRepoEvent(octokit, input)
        break
      }
      case 'workflow_run': {
        await handleWorkflowRunEvent(octokit, input)
        break
      }
      default: {
        core.warning(`This action does not support the '${eventName}' event.`)
        break
      }
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
