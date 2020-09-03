import * as input from '../src/input'

const testEnvVars = {
  INPUT_TOKEN: 'deadbeefcafebabedeadbeefcafebabedeadbeef',
  'INPUT_ONCE-LABEL': 'ci-requeue',
  'INPUT_CONTINUOUS-LABEL': 'ci-retry',
  INPUT_WORKFLOW: 'ci.yml'
}

describe('input', () => {
  beforeEach(() => {
    for (const key in testEnvVars) {
      process.env[key] = testEnvVars[key as keyof typeof testEnvVars]
    }
  })

  it('correctly parses the input', () => {
    const result = input.get()

    expect(result.token).toBe('deadbeefcafebabedeadbeefcafebabedeadbeef')
    // expect(result.onceLabel).toBe('ci-requeue')
    expect(result.continuousLabel).toBe('ci-retry')
    expect(result.workflow).toBe('ci.yml')
  })
})
