import * as core from '@actions/core'

export interface Input {
  token: string
  onceLabel: string | null
  continuousLabel: string | null
  triggerLabels: string[]
  workflow: string
}

export function get(): Input {
  const token = core.getInput('token', { required: true })
  const onceLabel = core.getInput('once-label') || null
  const continuousLabel = core.getInput('continuous-label') || null
  let triggerLabels = core.getInput('trigger-labels').split(',')
  const workflow = core.getInput('workflow', { required: true })

  if (!onceLabel && !continuousLabel && !triggerLabels) {
    throw new Error('One of `once-label`, `continous-label` or `trigger-labels` must be specified.')
  }

  if (onceLabel && continuousLabel && onceLabel == continuousLabel) {
    throw new Error('`once-label` and `continous-label` cannot have the same value.')
  }

  if (onceLabel && triggerLabels.includes(onceLabel)) {
    core.warning(`Removed \`once-label\` '${onceLabel}' from \`trigger-labels\`.`)
    triggerLabels = triggerLabels.filter(l => l !== onceLabel)
  }

  if (continuousLabel && triggerLabels.includes(continuousLabel)) {
    core.warning(`Removed \`continuous-label\` '${continuousLabel}' from \`trigger-labels\`.`)
    triggerLabels = triggerLabels.filter(l => l !== continuousLabel)
  }

  return { token, onceLabel, continuousLabel, triggerLabels, workflow }
}
