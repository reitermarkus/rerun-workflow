import * as core from '@actions/core'

export interface Input {
  token: string
  onceLabel: string | null
  continuousLabel: string | null
  workflow: string
}

export function get(): Input {
  const token = core.getInput('token', {required: true})
  const onceLabel = core.getInput('once-label') || null
  const continuousLabel = core.getInput('continuous-label') || null
  const workflow = core.getInput('workflow', {required: true})

  return {token, onceLabel, continuousLabel, workflow}
}
