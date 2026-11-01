import { execa } from 'execa'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig, CodexVendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { formatReviewResult, REVIEW_OUTPUT_SCHEMA } from './result.js'

// Scans stderr bottom-up for the first fatal/error line, skipping Codex header boilerplate.
function extractErrorSummary(stderr: string): string | undefined {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (/^(fatal|error):/i.test(l)) return l
  }
  // Fall back to last non-boilerplate line
  return lines.filter(l =>
    !l.startsWith('---') &&
    !/^(workdir|model|provider|approval|sandbox|reasoning|session\s+id):/i.test(l) &&
    !/^OpenAI Codex/i.test(l)
  ).at(-1)
}

// Models for API-key auth. When using ChatGPT subscription auth, omit model override.
const TIER_MODELS_API: Record<string, string> = {
  fast: 'gpt-4o-mini',
  balanced: 'o4-mini',
  thorough: 'o3',
}

const TIER_TIMEOUT_MS: Record<string, number> = {
  fast: 300_000,
  balanced: 600_000,
  thorough: 1_200_000,
}

export async function runCodexReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: CodexVendorConfig,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
): Promise<string> {
  // subscription auth has a fixed model set by ChatGPT plan; only override for api-key
  const model = vendor.auth === 'api-key'
    ? (vendor.model ?? TIER_MODELS_API[quality.tier] ?? 'o4-mini')
    : undefined
  const outputDir = mkdtempSync(join(tmpdir(), 'crosscheck-'))
  const schemaFile = join(outputDir, 'schema.json')
  const outputFile = join(outputDir, 'review.json')

  const focusNote = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}. `
    : ''
  const customNote = quality.custom_prompt ?? ''
  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS
  try {
    // Clone workflows may fetch only origin/<base>, without a local branch.
    const { stdout: base } = await execa('git', ['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`], { cwd: repoDir })
      .catch(() => execa('git', ['rev-parse', '--verify', '--end-of-options', `origin/${baseBranch}^{commit}`], { cwd: repoDir }))
    const baseSha = base.trim()
    if (!/^[a-f0-9]{40,64}$/i.test(baseSha)) throw new Error('Could not resolve the review base commit')
    const prompt = [
      `Review the pull request titled ${JSON.stringify(prTitle)}.`,
      `Review only changes in git diff ${baseSha}...HEAD.`,
      'Inspect source files for correctness, security, and regressions. Do not modify files.',
      focusNote, customNote, behaviorInstructions,
      'Return the review and verdict using the required JSON schema.',
    ].filter(Boolean).join('\n\n')
    writeFileSync(schemaFile, JSON.stringify(REVIEW_OUTPUT_SCHEMA))
    const modelArgs = model ? ['--model', model] : []
    onLog?.(`  running: codex exec (review base ${baseBranch})${model ? ` --model ${model}` : ''}`)

    const timeoutMs = TIER_TIMEOUT_MS[quality.tier] ?? 600_000
    await execa(
      'codex',
      ['exec', '--sandbox', 'read-only', '--output-schema', schemaFile, '--output-last-message', outputFile, '--color', 'never', ...modelArgs, '-'],
      {
        cwd: repoDir,
        timeout: timeoutMs,
        input: prompt,
        env: { ...process.env },
      },
    )

    return formatReviewResult(JSON.parse(readFileSync(outputFile, 'utf8')) as unknown)
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean }
    const rawStderr = execa.stderr ?? ''
    const timeoutSec = (TIER_TIMEOUT_MS[quality.tier] ?? 600_000) / 1000
    const summary = execa.timedOut
      ? `timed out after ${timeoutSec}s — PR diff may be too large (tier: ${quality.tier})`
      : (extractErrorSummary(rawStderr) ?? execa.message ?? 'unknown error')
    const thrown = Object.assign(new Error(`codex: ${summary}`), {
      exitCode: execa.exitCode,
      timedOut: execa.timedOut,
      stderr: rawStderr,
    })
    throw thrown
  } finally {
    rmSync(outputDir, { force: true, recursive: true })
  }
}

export async function checkCodexAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execa('codex', ['login', 'status'], { timeout: 10_000 })
    return { ok: true, detail: stdout.trim() || stderr.trim() }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not authenticated' }
  }
}
