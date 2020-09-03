import {Input, get as getInput} from './input'

import * as core from '@actions/core'
import * as github from '@actions/github'

import {isPresent} from 'ts-is-present'

import {ActionsListWorkflowRunsResponseData, PullsGetResponseData} from '@octokit/types'

import {PullRequestsWithLabelsQuery, PullRequestsWithLabels} from './generated/graphql'

enum RerunCondition {
  // Always re-run unless already queued or in progress.
  Always,
  // Re-run only when completed and failed.
  OnFailure,
  // Never re-run, only unlabel.
  Never
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
  context: Context,
  octokit: Octokit,
  workflow: string,
  pullRequest: PullRequest
): Promise<WorkflowRun[]> {
  core.info(`Searching workflows for pull request ${pullRequest.number} ...`)

  const response = await octokit.actions.listWorkflowRuns({
    ...context.repo,
    // Workflow ID can be a string or a number.
    workflow_id: workflow as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    event: PULL_REQUEST_EVENTS.join(' OR '),
    branch: pullRequest.head.ref,
    per_page: 100
  })

  const workflowRuns = response.data.workflow_runs

  const matchingWorkflowRuns = workflowRuns.filter(
    ({head_branch, head_sha}) => head_branch === pullRequest.head.ref && head_sha === pullRequest.head.sha
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

async function rerunWorkflow(context: Context, octokit: Octokit, id: number): Promise<void> {
  try {
    core.info(`Re-running workflow run ${id} …`)
    await octokit.actions.reRunWorkflow({
      ...context.repo,
      run_id: id
    })
    core.info(`Re-run of workflow run ${id} successfully started.`)
  } catch (err) {
    core.setFailed(`Re-running workflow run ${id} failed: ${err}`)
  }
}

async function removeLabelFromPullRequest(
  context: Context,
  octokit: Octokit,
  pullRequest: PullRequest,
  label: string
) {
  const {number, labels} = pullRequest

  const currentLabels = labels.map(l => l.name)

  if (!currentLabels.includes(label)) {
    return
  }

  try {
    core.info(`Removing '${label}' label from pull request ${number} …`)
    await octokit.issues.removeLabel({
      ...context.repo,
      issue_number: number,
      name: label
    })
  } catch (err) {
    core.setFailed(`Failed removing '${label}' label from pull request ${number}: ${err}`)
  }
}

async function rerunWorkflowsForPullRequest(
  context: Context,
  octokit: Octokit,
  input: Input,
  number: number,
  rerunCondition: RerunCondition
): Promise<void> {
  const pullRequest = (await octokit.pulls.get({...context.repo, pull_number: number})).data

  const workflowRuns = await latestWorkflowRunsForPullRequest(context, octokit, input.workflow, pullRequest)

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
            rerunWorkflow(context, octokit, workflowRun.id)
            reruns += 1
            break
          }
          case RerunCondition.OnFailure: {
            switch (workflowRun.conclusion) {
              case 'failure': {
                rerunWorkflow(context, octokit, workflowRun.id)
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
    removeLabelFromPullRequest(context, octokit, pullRequest, input.onceLabel)
  }

  // Only try removing the `continuousLabel` if we didn't re-run any workflows this time.
  if (reruns === 0) {
    removeContinuousLabelIfSuccessfulOrCancelled(context, octokit, workflowRuns, pullRequest, input)
  }
}

async function removeContinuousLabelIfSuccessfulOrCancelled(
  context: Context,
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
    removeLabelFromPullRequest(context, octokit, pullRequest, input.continuousLabel)
  }
}

async function handlePullRequestEvent(context: Context, octokit: Octokit, input: Input): Promise<void> {
  if (!context.payload.pull_request) {
    return
  }

  const {action, label, number} = context.payload

  if (!(action === 'labeled' || action === 'unlabeled')) {
    return
  }

  if ((action === 'labeled' && label.name === input.onceLabel) || input.triggerLabels.includes(label.name)) {
    await rerunWorkflowsForPullRequest(context, octokit, input, number, RerunCondition.Always)
  }
}

async function handleRepoEvent(context: Context, octokit: Octokit, input: Input): Promise<void> {
  const labels: string[] = [input.onceLabel, input.continuousLabel].filter(isPresent)

  core.info(`Searching for pull requests with ${labels.map(l => `'${l}'`).join(' or ')} labels.`)

  // We need to get the source code of the query since the `@octokit/graphql`
  // API doesn't (yet) support passing a `DocumentNode` object.
  const query = PullRequestsWithLabels.loc!.source!.body

  const result: PullRequestsWithLabelsQuery = await octokit.graphql({
    query,
    ...context.repo,
    labels
  })

  const pullRequests = result.repository!.pullRequests!.edges!.map(pr => ({
    number: pr!.node!.number,
    labels: pr!.node!.labels!.edges!.map(l => l!.node!.name)
  }))

  for (const {number, labels} of pullRequests) {
    if (input.onceLabel && labels.includes(input.onceLabel)) {
      rerunWorkflowsForPullRequest(context, octokit, input, number, RerunCondition.Always)
    } else if (input.continuousLabel && labels.includes(input.continuousLabel)) {
      rerunWorkflowsForPullRequest(context, octokit, input, number, RerunCondition.OnFailure)
    }
  }
}

async function pullRequestsForWorkflowRun(
  context: Context,
  octokit: Octokit,
  workflowRun: WorkflowRun
): Promise<number[]> {
  let pullRequests = (workflowRun.pull_requests as PullRequest[]).map(({number}) => number)

  if (pullRequests.length === 0) {
    const headRepo = workflowRun.head_repository
    const headBranch = workflowRun.head_branch
    const headSha = workflowRun.head_sha

    pullRequests = (
      await octokit.pulls.list({
        ...context.repo,
        state: 'open',
        head: `${headRepo.owner.login}:${headBranch}`,
        sort: 'updated',
        direction: 'desc',
        per_page: 100
      })
    ).data
      .filter(pr => pr.head.sha === headSha)
      .map(({number}) => number)
  }

  return pullRequests
}

async function handleWorkflowRunEvent(context: Context, octokit: Octokit, input: Input): Promise<void> {
  const {action, workflow_run: workflowRun} = context.payload

  if (action !== 'completed') {
    return
  }

  if (!PULL_REQUEST_EVENTS.includes(workflowRun.event)) {
    return
  }

  if (workflowRun.conclusion === 'success' || workflowRun.conclusion === 'cancelled') {
    const pullRequests = await pullRequestsForWorkflowRun(context, octokit, workflowRun)

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
      rerunWorkflowsForPullRequest(context, octokit, input, number, RerunCondition.Never)
    }
  }
}

async function run(): Promise<void> {
  try {
    const {context} = github

    const input = getInput()

    if (!input) {
      return
    }

    const octokit = github.getOctokit(input.token)

    switch (context.eventName) {
      case 'pull_request':
      case 'pull_request_target': {
        await handlePullRequestEvent(context, octokit, input)
        break
      }
      case 'schedule':
      case 'push': {
        await handleRepoEvent(context, octokit, input)
        break
      }
      case 'workflow_run': {
        await handleWorkflowRunEvent(context, octokit, input)
        break
      }
      default: {
        core.warning(`This action does not support the '${context.eventName}' event.`)
        break
      }
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
