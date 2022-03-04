<p align="center">
  <a href="https://github.com/reitermarkus/rerun-workflow/actions"><img alt="rerun-workflow build-test status" src="https://github.com/reitermarkus/rerun-workflow/workflows/build-test/badge.svg"></a>
</p>


# Re-run Workflow Action

This action allows re-running a workflow when labels are added to (or removed from) a pull request.


## Inputs

| Name | Required  | Description |
|------|-----------|-------------|
| `token` | yes | A GitHub Token other than the default `GITHUB_TOKEN` needs to be specified in order to be able to re-run workflows. |
| `once-label` | no\* | When this label is added to a pull request, re-run the `workflow` once and remove the label again. |
| `continuous-label` | no\* | When this label is added to a pull request, continuously re-run the `workflow` until it succeeds or is cancelled. The action needs to be run on `workflow_run`, `push` or `schedule` events for this to work. |
| `trigger-labels` | no\* | When any of the labels in this comma-separated list is added to or removed from a pull request, re-run the `workflow` once. |
| `workflow` | yes | File name or ID of the workflow which should be re-run. |

\* At least one of `once-label`, `continuous-label` or `trigger-labels` is required.


## Example Workflow

```yml
name: Re-run Workflow

on:
  # Check open pull requests for relevant labels and re-run the
  # corresponding workflows if necessary.
  # (Only recommended for testing.)
  push:

  # Check open pull requests for relevant labels and re-run the
  # corresponding workflows if necessary.
  schedule:
    - cron: '*/30 * * * *'

  # Remove relevant labels when a pull request is closed or trigger
  # a re-run when a relevant labels ia added or removed.
  pull_request_target:
    types:
      - closed
      - labeled
      - unlabeled

  # Check open pull requests for relevant labels and re-run the
  # corresponding workflows if necessary.
  workflow_dispatch:

  # Remove relevant labels when a workflow run finishes successfully.
  workflow_run:
    workflows:
      - CI
    types:
      - completed

jobs:
  rerun-workflow:
    runs-on: ubuntu-latest
    steps:
      - name: Re-run pull request workflows
        uses: reitermarkus/rerun-workflow@v1
        with:
          token: ${{ secrets.MY_GITHUB_TOKEN }}
          once-label: ci-requeue
          continuous-label: ci-retry
          trigger-labels: ci-trigger-1,ci-trigger-2
          workflow: ci.yml
```


## Known Issues

- It is not currently possible to re-run a workflow which already completed successfully.

24850
