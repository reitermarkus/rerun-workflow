import * as input from '../src/input'

const testEnvVars = {
  INPUT_TOKEN: 'deadbeefcafebabedeadbeefcafebabedeadbeef',
  'INPUT_ONCE-LABEL': 'ci-requeue',
  'INPUT_CONTINUOUS-LABEL': 'ci-retry',
  'INPUT_TRIGGER-LABELS': 'ci-skip-something,do not merge',
  INPUT_WORKFLOW: 'ci.yml'
}

describe('input', () => {
  beforeEach(() => {
    for (const key in testEnvVars) {
      process.env[key] = testEnvVars[key as keyof typeof testEnvVars]
    }
  })

  it('correctly parses the input', () => {
    const result = input.get()!

    expect(result.token).toBe('deadbeefcafebabedeadbeefcafebabedeadbeef')
    expect(result.onceLabel).toBe('ci-requeue')
    expect(result.continuousLabel).toBe('ci-retry')
    expect(result.triggerLabels).toStrictEqual(['ci-skip-something', 'do not merge'])
    expect(result.workflow).toBe('ci.yml')
  })

  it('returns null if `once-label` is equal to `continuous-label`', () => {
    process.env['INPUT_ONCE-LABEL'] = 'my-label'
    process.env['INPUT_CONTINUOUS-LABEL'] = 'my-label'

    const result = input.get()!

    expect(result).toBe(null)
  })

  it('returns null if none of `once-label` or `continuous-label` is specified', () => {
    process.env['INPUT_ONCE-LABEL'] = undefined
    process.env['INPUT_CONTINUOUS-LABEL'] = undefined

    const result = input.get()!

    expect(result).toBe(null)
  })
})
