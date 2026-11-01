import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'url'
import { getLogDir } from '../lib/logger.js'
import { buildImpactReport } from '../commands/impact.js'
import { ConfigSchema } from '../config/schema.js'

vi.mock('../lib/logger.js', () => ({ getLogDir: vi.fn() }))

describe('impact native log paths', () => {
  it('uses date basenames, not the full path, in the reporting period', () => {
    vi.mocked(getLogDir).mockReturnValue(fileURLToPath(new URL('./fixtures', import.meta.url)))
    const report = buildImpactReport(ConfigSchema.parse({}).impact)
    expect(report.period).toEqual({ from: '2026-01-10', to: '2026-01-11', log_files: 2 })
    expect(report.reviews_total).toBeGreaterThan(0)
  })
})
