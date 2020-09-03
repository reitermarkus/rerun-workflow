import {Input, get as getInput} from './input'

import * as core from '@actions/core'
import * as github from '@actions/github'

import {isPresent} from 'ts-is-present'

import {
  ActionsListWorkflowRunsResponseData,
  PullsGetResponseData
} from '@octokit/types'

import {
  PullRequestsWithLabelsQuery,
  PullRequestsWithLabels
} from './generated/graphql'

enum RerunCondition {
  // Re-run when possible, i.e. not already queued and not currently running.
  WhenPossible,
  // Re-run only when completed and failed.
  WhenFailed
}

type Context = typeof github.context
type Octokit = ReturnType<typeof github.getOctokit>
type PullRequest = PullsGetResponseData
type WorkflowRun = ActionsListWorkflowRunsResponseData['workflow_runs'][0]

const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target']

function latestWorkflowRunForEvent(
  workflowRuns: WorkflowRun[],
  event: string
): WorkflowRun | null {
  return workflowRuns
    .filter(w => w.event == event)
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
    ({head_branch, head_sha}) =>
      head_branch === pullRequest.head.ref && head_sha === pullRequest.head.sha
  )

  if (matchingWorkflowRuns.length == 0) {
    core.warning('No matching workflow runs found.')
    return []
  }

  const latestWorkflowRuns = PULL_REQUEST_EVENTS.map(event =>
    latestWorkflowRunForEvent(matchingWorkflowRuns, event)
  ).filter(isPresent)

  core.info(
    `Found ${
      latestWorkflowRuns.length
    } matching workflow runs: ${JSON.stringify(
      latestWorkflowRuns.map(r => r.id).join(', ')
    )}`
  )

  return latestWorkflowRuns
}

async function rerunWorkflow(
  context: Context,
  octokit: Octokit,
  id: number
): Promise<void> {
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
    core.setFailed(
      `Failed removing '${label}' label from pull request ${number}: ${err}`
    )
  }
}

async function rerunWorkflowForPullRequest(
  context: Context,
  octokit: Octokit,
  input: Input,
  number: number,
  condition: RerunCondition
): Promise<void> {
  const pullRequestResponse = await octokit.pulls.get({
    ...context.repo,
    pull_number: number
  })
  const pullRequest = pullRequestResponse.data

  const workflowRuns = await latestWorkflowRunsForPullRequest(
    context,
    octokit,
    input.workflow,
    pullRequest
  )

  let successfulOrCancelled = 0

  for (const workflowRun of workflowRuns) {
    switch (workflowRun.status) {
      case 'queued': {
        core.info(`Workflow run ${workflowRun.id} is already queued.`)
        break
      }
      case 'in_progress': {
        core.info(`Workflow run ${workflowRun.id} is already re-running.`)
        break
      }
      case 'completed': {
        switch (condition) {
          case RerunCondition.WhenPossible: {
            rerunWorkflow(context, octokit, workflowRun.id)
            break
          }
          case RerunCondition.WhenFailed: {
            switch (workflowRun.conclusion) {
              case 'failure': {
                rerunWorkflow(context, octokit, workflowRun.id)
                break
              }
              case 'success':
              case 'cancelled': {
                successfulOrCancelled += 1

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
        core.warning(
          `Unsupported status for workflow run ${workflowRun.id}: ${workflowRun.status}`
        )
        break
      }
    }
  }

  if (input.onceLabel) {
    removeLabelFromPullRequest(context, octokit, pullRequest, input.onceLabel)
  }

  // If all workflows finished successfully or were cancelled, stop continuously retrying.
  const allSuccessfulOrCancelled = successfulOrCancelled == workflowRuns.length
  if (allSuccessfulOrCancelled) {
    if (input.continuousLabel) {
      removeLabelFromPullRequest(
        context,
        octokit,
        pullRequest,
        input.continuousLabel
      )
    }
  }
}

async function handlePullRequestEvent(
  context: Context,
  octokit: Octokit,
  input: Input
): Promise<void> {
  if (!context.payload.pull_request) {
    return
  }

  const {action, label, number} = context.payload

  if (action === 'labeled' && label.name === input.onceLabel) {
    await rerunWorkflowForPullRequest(
      context,
      octokit,
      input,
      number,
      RerunCondition.WhenPossible
    )
  }
}

async function handleRepoEvent(
  context: Context,
  octokit: Octokit,
  input: Input
): Promise<void> {
  const labels: string[] = [input.onceLabel, input.continuousLabel].filter(
    isPresent
  )

  core.info(
    `Searching for pull requests with ${labels
      .map(l => `'${l}'`)
      .join(' or ')} labels.`
  )

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
    core.info(`Pull request ${number}: ${JSON.stringify(labels)}`)

    if (input.onceLabel && labels.includes(input.onceLabel)) {
      rerunWorkflowForPullRequest(
        context,
        octokit,
        input,
        number,
        RerunCondition.WhenPossible
      )
    } else if (
      input.continuousLabel &&
      labels.includes(input.continuousLabel)
    ) {
      rerunWorkflowForPullRequest(
        context,
        octokit,
        input,
        number,
        RerunCondition.WhenFailed
      )
    }
  }
}

async function run(): Promise<void> {
  try {
    const {context} = github

    const input = getInput()

    if (!input.onceLabel && !input.continuousLabel) {
      core.setFailed(
        'One of `once-label` or `continous-label` must be specified.'
      )
      return
    }

    // core.info(`Context: ${JSON.stringify(context, undefined, 2)}`)
    // core.info(`Event Data: ${JSON.stringify(context.payload, undefined, 2)}`)

    const octokit = github.getOctokit(input.token)

    core.info(`Workflow: ${input.workflow}`)

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
      default: {
        core.warning(
          `This action does not support the '${context.eventName}' event.`
        )
        break
      }
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
