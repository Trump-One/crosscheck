import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync, rmSync } from 'fs'
import { dirname } from 'path'
import { runTextAgent } from '../lib/agent-text.js'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('execa', () => ({ execa: run }))

let temporaryDirectory: string | undefined
beforeEach(() => { run.mockReset(); temporaryDirectory = undefined })
afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe('noninteractive text helpers', () => {
  it('passes large Claude prompts through stdin without disabling subscription auth', async () => {
    const prompt = 'context\n'.repeat(10000)
    run.mockResolvedValue({ stdout: '  instructions\n' })
    expect(await runTextAgent('claude', prompt, 120000)).toBe('instructions')
    const [agent, args, options] = run.mock.calls[0]
    expect(agent).toBe('claude')
    expect(args).not.toContain('--bare')
    expect(args).not.toContain(prompt)
    expect(args).toEqual(expect.arrayContaining(['--tools', '', '--output-format', 'text']))
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'user', '--strict-mcp-config', '--disable-slash-commands']))
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: {} })
    expect(options).toMatchObject({ input: prompt, timeout: 120000 })
  })
  it('uses codex exec outside Git and reads only the final response', async () => {
    run.mockImplementation(async (_agent: string, args: string[]) => {
      const output = args[args.indexOf('--output-last-message') + 1]
      temporaryDirectory = dirname(output)
      writeFileSync(output, 'TITLE: useful draft\n---\nBody\n')
      return { stdout: 'non-final event output' }
    })
    expect(await runTextAgent('codex', 'draft prompt', 180000)).toBe('TITLE: useful draft\n---\nBody')
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']))
    expect(run.mock.calls[0][1]).not.toContain('-q')
    expect(run.mock.calls[0][2]).toMatchObject({ input: 'draft prompt', timeout: 180000 })
    expect(existsSync(temporaryDirectory!)).toBe(false)
  })
  it('cleans up temporary files when Codex fails', async () => {
    run.mockImplementation(async (_agent: string, args: string[]) => {
      temporaryDirectory = dirname(args[args.indexOf('--output-last-message') + 1])
      throw new Error('CLI failed')
    })
    await expect(runTextAgent('codex', 'prompt', 1000)).rejects.toThrow('CLI failed')
    expect(existsSync(temporaryDirectory!)).toBe(false)
  })
  it('rejects empty helper output', async () => {
    run.mockResolvedValue({ stdout: '\n' })
    await expect(runTextAgent('claude', 'prompt', 1000)).rejects.toThrow('empty response')
  })
})
