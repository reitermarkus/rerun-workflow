import * as core from '@actions/core'
import * as github from '@actions/github'
import { isPresent } from 'ts-is-present'

import { PullRequestsWithLabelsQuery, PullRequestsWithLabels } from './generated/graphql'

import { Octokit, PullRequest, RerunCondition, WorkflowRun } from './types'
import {
  PULL_REQUEST_EVENTS,
  latestWorkflowRunsForPullRequest,
  removeLabelFromPullRequest,
  rerunWorkflow,
} from './helpers'
import { Input, get as getInput } from './input'

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

class RerunWorkflowAction {
  input: Input

  constructor(input: Input) {
    this.input = input
  }

  async handlePullRequestEvent(octokit: Octokit): Promise<void> {
    if (!github.context.payload.pull_request) {
      return
    }

    const { action, label, number } = github.context.payload

    if (
      (action === 'labeled' && label.name === this.input.onceLabel) ||
      ((action === 'labeled' || action === 'unlabeled') && this.input.triggerLabels.includes(label.name))
    ) {
      await rerunWorkflowsForPullRequest(octokit, this.input, number, RerunCondition.Always)
    }
  }

  async handleRepoEvent(octokit: Octokit): Promise<void> {
    const labels: string[] = [this.input.onceLabel, this.input.continuousLabel].filter(isPresent)

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
      if (this.input.onceLabel && labels.includes(this.input.onceLabel)) {
        rerunWorkflowsForPullRequest(octokit, this.input, number, RerunCondition.Always)
      } else if (this.input.continuousLabel && labels.includes(this.input.continuousLabel)) {
        rerunWorkflowsForPullRequest(octokit, this.input, number, RerunCondition.OnFailure)
      }
    }
  }

  async handleWorkflowRunEvent(octokit: Octokit): Promise<void> {
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
        rerunWorkflowsForPullRequest(octokit, this.input, number, RerunCondition.Never)
      }
    }
  }
}

async function run(): Promise<void> {
  try {
    const input = getInput()

    const octokit = github.getOctokit(input.token)

    const action = new RerunWorkflowAction(input)

    const eventName = github.context.eventName
    switch (eventName) {
      case 'pull_request':
      case 'pull_request_target': {
        await action.handlePullRequestEvent(octokit)
        break
      }
      case 'schedule':
      case 'push': {
        await action.handleRepoEvent(octokit)
        break
      }
      case 'workflow_run': {
        await action.handleWorkflowRunEvent(octokit)
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
