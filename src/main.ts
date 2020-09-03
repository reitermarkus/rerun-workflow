import * as core from '@actions/core'
import * as github from '@actions/github'

import {Octokit} from '@octokit/core'
import {
  GetResponseTypeFromEndpointMethod,
  GetResponseDataTypeFromEndpointMethod
} from '@octokit/types'

const octokit = new Octokit()

type ListWorkFlowRunsResponse = GetResponseTypeFromEndpointMethod<
  typeof octokit.actions.listWorkflowRuns
>

type ListWorkFlowRunsResponseData = GetResponseDataTypeFromEndpointMethod<
  typeof octokit.actions.listWorkflowRuns
>

async function findWorkflowRunForPullRequest(
  context: typeof github.context,
  octokit: Octokit,
  workflow: string,
  pullRequest: {number: number; branch: string; sha: string}
): Promise<ListWorkFlowRunsResponseData | null> {
  core.info(`Searching workflows for pull request ${pullRequest.number} ...`)
  const response: ListWorkFlowRunsResponse = await octokit.actions.listWorkflowRuns(
    {
      ...context.repo,
      workflow_id: workflow,
      event: 'pull_request OR pull_request_target',
      branch: pullRequest.branch,
      per_page: 100
    }
  )

  const workflowRuns: ListWorkFlowRunsResponseData[] =
    response.data.workflow_runs

  const matchingWorkflowRuns = workflowRuns.filter(
    run =>
      run.head_branch === pullRequest.branch && run.head_sha === pullRequest.sha
  )

  core.info(
    `matchingWorkflowRuns: ${JSON.stringify(
      matchingWorkflowRuns,
      undefined,
      2
    )}`
  )

  const count = matchingWorkflowRuns.length
  if (count === 0) {
    core.warning('No matching workflow runs found.')
    return null
  } else if (count === 1) {
    core.info(`Found one matching workflow run.`)
    return matchingWorkflowRuns[0]
  } else {
    core.warning(
      `Found ${count} matching workflow runs, cannot decide which one to re-run.`
    )
    return null
  }
}

async function rerunWorkflow(
  context: typeof github.context,
  octokit: Octokit,
  workflowRun: ListWorkFlowRunsResponseData
): Promise<void> {
  const id = workflowRun.id

  if (workflowRun.status === 'queued') {
    core.info(`Workflow run ${id} is already queued.`)
  } else {
    core.info(`Re-running workflow run ${id} …`)
    await octokit.actions.reRunWorkflow({
      ...context.repo,
      run_id: id
    })
  }
}

async function run(): Promise<void> {
  try {
    const {context} = github

    const token: string = core.getInput('token', {required: true})
    const onceLabel: string = core.getInput('once-label')
    const continuousLabel: string = core.getInput('continuous-label')
    const workflow: string = core.getInput('workflow', {required: true})

    if (!onceLabel && !continuousLabel) {
      core.setFailed(
        'One of `once-label` or `continous-label` must be specified.'
      )
      return
    }

    // core.info(`Context: ${JSON.stringify(context, undefined, 2)}`)
    // core.info(`Event Data: ${JSON.stringify(context.payload, undefined, 2)}`)

    const octokit = github.getOctokit(token)

    const labels: string[] = [onceLabel, continuousLabel].filter(l => l !== '')

    core.info(`Labels: ${JSON.stringify(labels)}`)
    core.info(`Workflow: ${workflow}`)

    if (
      context.eventName === 'pull_request_target' &&
      context.payload.pull_request
    ) {
      const {action, label, number} = context.payload
      const branch = context.payload.pull_request.head.ref
      const sha = context.payload.pull_request.head.sha

      if (action === 'labeled' && label.name === onceLabel) {
        const workflowRun = await findWorkflowRunForPullRequest(
          context,
          octokit,
          workflow,
          {number, branch, sha}
        )
        if (workflowRun) {
          try {
            await rerunWorkflow(context, octokit, workflowRun)

            if (onceLabel) {
              core.info(
                `Re-run of workflow run ${workflowRun.id} successfully started. Removing '${onceLabel}' label…`
              )
              await octokit.issues.removeLabel({
                ...context.repo,
                issue_number: number,
                name: onceLabel
              })
            }
          } catch (err) {
            core.setFailed(
              `Failed re-running workflow run ${workflowRun.id}: ${err}`
            )
          }
        }
      }
    }

    const result = await octokit.graphql({
      query: `
        query pullRequests($owner: String!, $repo: String!, $labels: [String!]) {
          repository(owner: $owner, name: $repo) {
            pullRequests(labels: $labels, states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
              edges {
                node {
                  number
                }
              }
            }
          }
        }
      `,
      ...context.repo,
      labels
    })

    core.info(`Pull Requests: ${JSON.stringify(result)}`)
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
