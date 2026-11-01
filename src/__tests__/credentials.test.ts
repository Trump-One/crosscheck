import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { detectGitHubLogin, getGithubTokenSource } from '../config/loader.js'

vi.mock('child_process', () => ({ execFileSync: vi.fn() }))

beforeEach(() => {
  vi.stubEnv('GITHUB_TOKEN', 'test-env-token')
  vi.stubEnv('GH_TOKEN', 'test-gh-token')
  vi.mocked(execFileSync).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('GitHub credentials without a platform shell', () => {
  it('reads keyring credentials without echoing environment tokens or stderr', () => {
    vi.mocked(execFileSync).mockReturnValue('test-keyring-token\r\n')
    expect(getGithubTokenSource()).toEqual({ token: 'test-keyring-token', source: 'gh-keyring' })
    expect(execFileSync).toHaveBeenCalledWith('gh', ['auth', 'token'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'ignore'],
      env: expect.objectContaining({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined }),
    }))
  })

  it('falls back to an environment token when keyring lookup fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no keyring') })
    expect(getGithubTokenSource()).toEqual({ token: 'test-env-token', source: 'env' })
  })

  it('returns null when neither keyring nor environment has credentials', () => {
    vi.stubEnv('GITHUB_TOKEN', undefined)
    vi.stubEnv('GH_TOKEN', undefined)
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not logged in') })
    expect(getGithubTokenSource()).toBeNull()
  })

  it('passes the jq expression as an argument without Unix quoting', () => {
    vi.mocked(execFileSync).mockReturnValue('tester\r\n')
    expect(detectGitHubLogin()).toBe('tester')
    expect(execFileSync).toHaveBeenCalledWith('gh', ['api', 'user', '--jq', '.login'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  })

  it('retries login detection with environment credentials if keyring fails', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('no keyring') }).mockReturnValue('tester\n')
    expect(detectGitHubLogin()).toBe('tester')
    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(execFileSync).toHaveBeenLastCalledWith('gh', expect.any(Array), expect.objectContaining({ env: process.env }))
  })
})
