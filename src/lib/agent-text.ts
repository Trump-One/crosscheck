import { execa } from 'execa'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CLAUDE_AUTOMATION_ARGS } from './claude-cli.js'

export async function runTextAgent(agent: 'claude' | 'codex', prompt: string, timeout: number): Promise<string> {
  let output: string
  if (agent === 'claude') {
    const { stdout } = await execa('claude', [
      '--print', '--output-format', 'text', ...CLAUDE_AUTOMATION_ARGS, '--tools', '',
    ], { input: prompt, timeout, env: { ...process.env } })
    output = stdout.trim()
  } else {
    const directory = mkdtempSync(join(tmpdir(), 'crosscheck-text-'))
    try {
      const outputFile = join(directory, 'response.md')
      await execa('codex', [
        'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
        '--output-last-message', outputFile, '--color', 'never', '-',
      ], { cwd: directory, input: prompt, timeout, env: { ...process.env } })
      output = readFileSync(outputFile, 'utf8').trim()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  if (!output) throw new Error(`${agent} returned an empty response`)
  return output
}
