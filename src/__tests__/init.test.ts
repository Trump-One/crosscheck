import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { runInit } from '../commands/init.js'

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'Logged in; Token scopes: admin:org_hook'),
  execFileSync: vi.fn(),
}))
vi.mock('../reviewers/codex.js', () => ({ checkCodexAuth: vi.fn(async () => ({ ok: true, detail: 'test' })) }))
vi.mock('../reviewers/claude.js', () => ({ checkClaudeAuth: vi.fn(async () => ({ ok: true, detail: 'test' })) }))
vi.mock('../config/loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../config/loader.js')>(),
  getWebhookSecret: vi.fn(() => 'test-secret'),
  detectGitHubLogin: vi.fn(() => 'tester'),
}))

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'crosscheck init 空格 '))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('init config creation', () => {
  it('creates a nested config with auto-detected routing on native paths', async () => {
    const target = join(directory, 'nested folder', 'config.yml')
    await runInit(target)
    expect(existsSync(target)).toBe(true)
    const config = yaml.load(readFileSync(target, 'utf8')) as { routing: { allowed_authors: string[]; author_routes: Record<string, string> } }
    expect(config.routing.allowed_authors).toEqual(['tester'])
    expect(config.routing.author_routes).toEqual({ tester: 'claude' })
  })
})
