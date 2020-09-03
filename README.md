<p align="center">
  <a href="https://github.com/reitermarkus/rerun-workflow/actions"><img alt="typescript-action status" src="https://github.com/actions/reitermarkus/rerun-workflow/build-test/badge.svg"></a>
</p>


# Re-run a Pull Request Workflow

This action allows re-running a workflow when labels are added to (or removed from) a pull request.


## Inputs

| Name | Required  | Description |
|------|-----------|-------------|
| `token` | yes | A GitHub Token other than the default `GITHUB_TOKEN` needs to be specified in order to be able to re-run workflows. |
| `once-label` | no\* | When this label is added to a pull request, re-run the `workflow` once and remove the label again. |
| `continuous-label` | no\* | When this label is added to a pull request, continuously re-run the `workflow` until it succeeds or is cancelled. The action needs to be run on `workflow_run`, `push` or `schedule` events for this to work. |
| `trigger-labels` | no\* | When any of the labels in this comma-separated list is added to or removed from to a pull request, re-run the `workflow` once. |
| `workflow` | yes | File name or ID of the workflow which should be re-run. |

\* At least one of `once-label`, `continuous-label` or `trigger-labels` is required.

# Example Workflow

```yml
name: Re-run Workflow

on:
  workflow_run:
    workflows:
      - CI
    types:
      - completed
  pull_request_target:
    types:
      - labeled
      - unlabeled
  schedule:
    - cron: '*/30 * * * *'

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
          trigger-labels: ci-trigger
          workflow: ci.yml
```

## Known Issues

It is not currently possible to re-run a workflow which already completed successfully.
