import * as core from '@actions/core'
import * as github from '@actions/github'
import { isPresent } from 'ts-is-present'

import { PullRequestsWithLabelsQuery, PullRequestsWithLabels } from './generated/graphql'

import { Octokit, PullRequest, RerunCondition, WorkflowRun } from './types'
import {
  PULL_REQUEST_EVENTS,
  getPullRequest,
  isSuccessfulOrCancelled,
  latestWorkflowRunsForPullRequest,
  pullRequestsForWorkflowRun,
  removeLabelFromPullRequest,
  rerunWorkflow,
} from './helpers'
import { Input, get as getInput } from './input'

class RerunWorkflowAction {
  input: Input

  constructor(input: Input) {
    this.input = input
  }

  async removeOnceLabel(octokit: Octokit, pullRequest: PullRequest): Promise<void> {
    if (!this.input.onceLabel) {
      return
    }

    await removeLabelFromPullRequest(octokit, pullRequest, this.input.onceLabel)
  }

  async removeContinuousLabel(octokit: Octokit, pullRequest: PullRequest): Promise<void> {
    if (!this.input.continuousLabel) {
      return
    }

    await removeLabelFromPullRequest(octokit, pullRequest, this.input.continuousLabel)
  }

  async removeContinuousLabelIfSuccessfulOrCancelled(
    octokit: Octokit,
    workflowRuns: WorkflowRun[],
    pullRequest: PullRequest
  ): Promise<void> {
    // If all workflows finished successfully or were cancelled, stop continuously retrying by removing the `continuousLabel`.
    if (workflowRuns.every(isSuccessfulOrCancelled)) {
      await this.removeContinuousLabel(octokit, pullRequest)
    }
  }

  async rerunWorkflowsForPullRequest(
    octokit: Octokit,
    number: number,
    rerunCondition: RerunCondition
  ): Promise<void> {
    const pullRequest = await getPullRequest(octokit, number)

    const workflowRuns = await latestWorkflowRunsForPullRequest(octokit, this.input.workflow, pullRequest)

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
              await rerunWorkflow(octokit, workflowRun.id)
              reruns += 1
              break
            }
            case RerunCondition.OnFailure: {
              switch (workflowRun.conclusion) {
                case 'failure': {
                  await rerunWorkflow(octokit, workflowRun.id)
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
    await this.removeOnceLabel(octokit, pullRequest)

    // Only try removing the `continuousLabel` if we didn't re-run any workflows this time.
    if (reruns === 0) {
      await this.removeContinuousLabelIfSuccessfulOrCancelled(octokit, workflowRuns, pullRequest)
    }
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
      await this.rerunWorkflowsForPullRequest(octokit, number, RerunCondition.Always)
    } else if (action === 'closed') {
      const pullRequest = await getPullRequest(octokit, number)

      await this.removeOnceLabel(octokit, pullRequest)
      await this.removeContinuousLabel(octokit, pullRequest)
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

    if (pullRequests.length) {
      core.info(`Found ${pullRequests.length} pull requests with matching labels.`)
    } else {
      core.info(`No pull requests found.`)
      return
    }

    await Promise.all(
      pullRequests.map(({ number, labels }) => async () => {
        if (this.input.onceLabel && labels.includes(this.input.onceLabel)) {
          await this.rerunWorkflowsForPullRequest(octokit, number, RerunCondition.Always)
        } else if (this.input.continuousLabel && labels.includes(this.input.continuousLabel)) {
          await this.rerunWorkflowsForPullRequest(octokit, number, RerunCondition.OnFailure)
        }
      })
    )
  }

  async handleWorkflowRunEvent(octokit: Octokit): Promise<void> {
    const { action, workflow_run: workflowRun } = github.context.payload

    if (action !== 'completed') {
      return
    }

    if (!PULL_REQUEST_EVENTS.includes(workflowRun.event)) {
      return
    }

    if (isSuccessfulOrCancelled(workflowRun)) {
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

      await Promise.all(
        pullRequests.map(number => this.rerunWorkflowsForPullRequest(octokit, number, RerunCondition.Never))
      )
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
