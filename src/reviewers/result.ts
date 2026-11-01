import { z } from 'zod'

const ReviewResultSchema = z.object({
  review: z.string().trim().min(1),
  verdict: z.enum(['APPROVE', 'NEEDS WORK', 'BLOCK']),
})

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    review: { type: 'string', description: 'Code review with actionable findings and file references.' },
    verdict: { type: 'string', enum: ['APPROVE', 'NEEDS WORK', 'BLOCK'] },
  },
  required: ['review', 'verdict'],
  additionalProperties: false,
} as const

export function formatReviewResult(value: unknown): string {
  const result = ReviewResultSchema.parse(value)
  return `${result.review}\n\nVERDICT: ${result.verdict}`
}

export function parseClaudeReview(stdout: string): string {
  const envelope = z.object({
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    subtype: z.string().optional(),
    structured_output: z.unknown().optional(),
  }).parse(JSON.parse(stdout) as unknown)
  if (envelope.is_error || envelope.structured_output === undefined) {
    throw new Error(envelope.result || envelope.subtype || 'Claude returned no structured review')
  }
  return formatReviewResult(envelope.structured_output)
}
