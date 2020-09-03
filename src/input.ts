import * as core from '@actions/core'

export interface Input {
  token: string
  onceLabel: string | null
  continuousLabel: string | null
  triggerLabels: string[]
  workflow: string
}

export function get(): Input | null {
  const token = core.getInput('token', {required: true}) || null
  const onceLabel = core.getInput('once-label') || null
  const continuousLabel = core.getInput('continuous-label') || null
  let triggerLabels = core.getInput('trigger-labels').split(',')
  const workflow = core.getInput('workflow', {required: true})

  if (!token) {
    core.setFailed('A `token` must be specified.')
    return null
  }

  if (!onceLabel && !continuousLabel && !triggerLabels) {
    core.setFailed('One of `once-label` or `continous-label` must be specified.')
    return null
  }

  if (onceLabel == continuousLabel) {
    core.setFailed('`once-label` and `continous-label` cannot have the same value.')
    return null
  }

  if (onceLabel && triggerLabels.includes(onceLabel)) {
    core.warning(`Removed \`once-label\` '${onceLabel}' from \`trigger-labels\`.`)
    triggerLabels = triggerLabels.filter(l => l !== onceLabel)
  }

  if (continuousLabel && triggerLabels.includes(continuousLabel)) {
    core.warning(`Removed \`continuous-label\` '${continuousLabel}' from \`trigger-labels\`.`)
    triggerLabels = triggerLabels.filter(l => l !== continuousLabel)
  }

  return {token, onceLabel, continuousLabel, triggerLabels, workflow}
}
