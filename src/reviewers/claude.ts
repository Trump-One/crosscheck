import { execa } from 'execa'
import type { QualityConfig, VendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { parseClaudeReview, REVIEW_OUTPUT_SCHEMA } from './result.js'
import { CLAUDE_AUTOMATION_ARGS } from '../lib/claude-cli.js'

const TIER_MODELS: Record<string, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  thorough: 'claude-opus-4-7',
}

const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

export async function runClaudeReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: VendorConfig,
  perReviewBudget: number,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
): Promise<string> {
  const model = vendor.model ?? TIER_MODELS[quality.tier] ?? 'claude-sonnet-4-6'
  const effort = EFFORT_MAP[vendor.effort] ?? 'medium'
  const focusLine = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}.`
    : ''
  const customLine = quality.custom_prompt ?? ''

  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS

  const prompt = [
    `You are reviewing a pull request titled: "${prTitle}".`,
    `The branch \`${baseBranch}\` is the base. Review only the changes introduced in this PR.`,
    focusLine,
    customLine,
    behaviorInstructions,
  ].filter(Boolean).join('\n')

  const args = [
    '--print',
    '--model', model,
    '--effort', effort,
    '--max-budget-usd', String(perReviewBudget),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(REVIEW_OUTPUT_SCHEMA),
    ...CLAUDE_AUTOMATION_ARGS,
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep,Bash',
    '--allowedTools', 'Read,Glob,Grep,Bash(git diff *),Bash(git log *),Bash(git show *)',
  ]

  onLog?.(`  running: claude --print --model ${model} --effort ${effort}`)

  try {
    const { stdout } = await execa('claude', args, {
      cwd: repoDir,
      input: prompt,
      timeout: 180_000,
      env: { ...process.env },
    })
    return parseClaudeReview(stdout)
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean }
    const rawStderr = execa.stderr?.trim() ?? ''
    let summary = (rawStderr.split('\n').filter(Boolean).at(-1)) ?? execa.message ?? 'unknown error'
    if (!rawStderr && execa.stdout) {
      try {
        const result = JSON.parse(execa.stdout) as { result?: string; errors?: string[]; subtype?: string }
        summary = result.result || result.errors?.join('; ') || result.subtype || summary
      } catch { /* retain the process error for non-JSON output */ }
    }
    const thrown = Object.assign(new Error(`claude: ${summary}`), {
      exitCode: execa.exitCode,
      timedOut: execa.timedOut,
      stderr: rawStderr,
    })
    throw thrown
  }
}

export async function checkClaudeAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execa('claude', ['auth', 'status', '--json'], { timeout: 10_000 })
    const auth = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string }
    return { ok: auth.loggedIn === true, detail: auth.loggedIn === true ? (auth.authMethod ?? 'authenticated') : 'not authenticated — run: claude auth login' }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not found' }
  }
}
