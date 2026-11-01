import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { ConfigSchema } from '../config/schema.js'
import { runCodexReview, checkCodexAuth } from '../reviewers/codex.js'
import { runClaudeReview, checkClaudeAuth } from '../reviewers/claude.js'
import { runFixStep } from '../reviewers/fix.js'
import { parseVerdict } from '../lib/verdict.js'
import { runWorkflow, type WorkflowContext } from '../lib/runner.js'

const { run, postComment } = vi.hoisted(() => ({ run: vi.fn(), postComment: vi.fn() }))
vi.mock('execa', () => ({ execa: run }))
vi.mock('child_process', () => ({ execSync: vi.fn(() => '') }))
vi.mock('../github/client.js', () => ({ createGithubClient: vi.fn(), postReviewComment: postComment }))
vi.mock('../lib/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

const config = ConfigSchema.parse({ quality: { tier: 'fast' }, logs: { enabled: false } })
const sha = 'a'.repeat(40)
const review = { review: '## Critical Issues\n- [P1] Restore addition in math.js:2.', verdict: 'NEEDS WORK' }
let repo: string
let outputDirectory: string | undefined

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crosscheck review 空格 '))
  outputDirectory = undefined
  run.mockReset()
  postComment.mockReset()
  run.mockImplementation(async (file: string, args: string[]) => {
    if (file === 'git') return { stdout: sha, stderr: '' }
    if (file === 'codex') {
      const output = args[args.indexOf('--output-last-message') + 1]
      outputDirectory = dirname(output)
      writeFileSync(output, JSON.stringify(review))
      return { stdout: 'incidental event output', stderr: '' }
    }
    return { stdout: JSON.stringify({ is_error: false, structured_output: review }), stderr: '' }
  })
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true })
})

describe('Codex structured reviews', () => {
  it('passes instructions via stdin, uses structured final output and cleans up', async () => {
    const text = await runCodexReview(repo, 'main', 'fix addition', config.quality, config.vendors.codex, 'Check arithmetic.')
    expect(parseVerdict(text).verdict).toBe('NEEDS WORK')
    expect(text).toContain(review.review)
    const invocation = run.mock.calls.find(call => call[0] === 'codex')
    expect(invocation?.[1]).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--output-schema', '--output-last-message', '-']))
    expect(invocation?.[2]).toMatchObject({ cwd: repo, input: expect.stringContaining('Check arithmetic.') })
    expect(invocation?.[2].input).toContain(`${sha}...HEAD`)
    expect(invocation?.[2].env.PATH).toBe(process.env.PATH)
    expect(existsSync(join(repo, '.codex', 'instructions'))).toBe(false)
    expect(outputDirectory).toBeDefined()
    expect(existsSync(outputDirectory!)).toBe(false)
  })

  it('falls back to a remote-only base branch and honors API-key models', async () => {
    run.mockRejectedValueOnce(new Error('no local staging branch'))
    await runCodexReview(repo, 'staging', 'title', config.quality, { ...config.vendors.codex, auth: 'api-key', model: 'configured-model' })
    expect(run).toHaveBeenCalledWith('git', ['rev-parse', '--verify', '--end-of-options', 'origin/staging^{commit}'], { cwd: repo })
    expect(run.mock.calls.find(call => call[0] === 'codex')?.[1]).toEqual(expect.arrayContaining(['--model', 'configured-model']))
  })

  it('rejects malformed output instead of inferring an approval', async () => {
    run.mockImplementation(async (file: string, args: string[]) => {
      if (file === 'git') return { stdout: sha, stderr: '' }
      const output = args[args.indexOf('--output-last-message') + 1]
      outputDirectory = dirname(output)
      writeFileSync(output, JSON.stringify({ review: 'No verdict supplied' }))
      return { stdout: '', stderr: '' }
    })
    await expect(runCodexReview(repo, 'main', 'title', config.quality, config.vendors.codex)).rejects.toThrow('codex:')
    expect(existsSync(outputDirectory!)).toBe(false)
  })

  it('preserves timeout context', async () => {
    run.mockImplementation(async (file: string) => {
      if (file === 'git') return { stdout: sha, stderr: '' }
      throw Object.assign(new Error('process timeout'), { timedOut: true, stderr: '' })
    })
    await expect(runCodexReview(repo, 'main', 'title', config.quality, config.vendors.codex)).rejects.toThrow('timed out after 300s')
  })
})

describe('Claude structured reviews', () => {
  it('uses supported print/JSON flags and retains subscription auth', async () => {
    const text = await runClaudeReview(repo, 'main', 'title', config.quality, config.vendors.claude, 2)
    expect(parseVerdict(text).verdict).toBe('NEEDS WORK')
    const [, args, options] = run.mock.calls[0]
    expect(args).not.toContain('--bare')
    expect(args).not.toContain('--output-last-message')
    expect(args).toEqual(expect.arrayContaining(['--print', '--output-format', 'json', '--json-schema', '--permission-mode', 'dontAsk']))
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]).required).toEqual(['review', 'verdict'])
    expect(options).toMatchObject({ cwd: repo, input: expect.stringContaining('main') })
  })

  it('honors an explicitly configured model', async () => {
    await runClaudeReview(repo, 'main', 'title', config.quality, { ...config.vendors.claude, model: 'custom-model' }, 2)
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'custom-model']))
  })

  it('rejects missing structured output', async () => {
    run.mockResolvedValue({ stdout: JSON.stringify({ result: 'unstructured prose' }), stderr: '' })
    await expect(runClaudeReview(repo, 'main', 'title', config.quality, config.vendors.claude, 2)).rejects.toThrow('unstructured prose')
  })

  it('reports nonzero JSON budget errors concisely', async () => {
    run.mockRejectedValue({ stdout: JSON.stringify({ errors: ['Reached maximum budget ($2)'] }), stderr: '' })
    await expect(runClaudeReview(repo, 'main', 'title', config.quality, config.vendors.claude, 2)).rejects.toThrow('claude: Reached maximum budget ($2)')
  })
})

describe('authentication and fix invocation', () => {
  it('does not mistake an installed but logged-out Claude CLI for authentication', async () => {
    run.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false }), stderr: '' })
    expect((await checkClaudeAuth()).ok).toBe(false)
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], expect.any(Object))
  })
  it('recognizes Claude subscription authentication', async () => {
    run.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' })
    expect(await checkClaudeAuth()).toEqual({ ok: true, detail: 'claude.ai' })
  })
  it('reads Codex authentication details written to stderr', async () => {
    run.mockResolvedValue({ stdout: '', stderr: 'Logged in using ChatGPT\n' })
    expect(await checkCodexAuth()).toEqual({ ok: true, detail: 'Logged in using ChatGPT' })
  })
  it('runs the Claude fix CLI in the checkout and supports npm command shims', async () => {
    run.mockResolvedValue({ stdout: '<file path="math.js">export const add = (a, b) => a + b\n</file>', stderr: '' })
    expect(await runFixStep(repo, 'main', 'title', 'Fix arithmetic', '', config)).toEqual({ appliedCount: 1 })
    expect(readFileSync(join(repo, 'math.js'), 'utf8')).toContain('a + b')
    expect(run).toHaveBeenCalledWith('claude', expect.any(Array), expect.objectContaining({ cwd: repo, input: expect.stringContaining('Fix arithmetic') }))
  })
})

describe('review workflow integration', () => {
  it.each(['codex', 'claude'] as const)('posts the structured %s verdict through the existing workflow', async vendor => {
    const context: WorkflowContext = {
      owner: 'owner', repoName: 'repo', prNumber: 1, tmpDir: repo, token: 'test-token', config,
      origin: 'claude', reviewStart: Date.now(), log: () => {}, onPhaseChange: () => {}, crosscheckShas: new Set(),
      pr: { title: 'Fix addition', body: '', head: { ref: 'feature', sha, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, html_url: 'https://github.com/owner/repo/pull/1', user: { login: 'tester' } },
      steps: [{ name: 'review', type: 'review', reviewer: vendor, max_rounds: 1 }],
    }
    const result = await runWorkflow(context)
    expect(result.verdict).toBe('NEEDS WORK')
    expect(postComment).toHaveBeenCalledWith(undefined, 'owner', 'repo', 1, expect.stringContaining('⚠️ **NEEDS WORK**'), vendor, config.brand)
  })
})
