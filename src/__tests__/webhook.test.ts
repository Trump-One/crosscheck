import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHmac } from 'crypto'
import { once } from 'events'
import type { AddressInfo } from 'net'
import { ConfigSchema } from '../config/schema.js'
import { createWebhookServer } from '../github/webhook.js'
import { findAvailablePort } from '../lib/port.js'

const secret = 'local-webhook-test-secret'
const received: string[] = []
const server = createWebhookServer(ConfigSchema.parse({}), secret, event => received.push(event.action), () => {})
let endpoint: string
beforeAll(async () => {
  server.listen(0)
  await once(server, 'listening')
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

async function request(body: string, event = 'pull_request', key = secret): Promise<number> {
  const signature = `sha256=${createHmac('sha256', key).update(body).digest('hex')}`
  const response = await fetch(`${endpoint}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': signature, 'x-github-event': event } })
  await response.text()
  return response.status
}

describe('webhook HTTP integration', () => {
  it('rejects invalid signatures', async () => { expect(await request('{}', 'ping', 'wrong')).toBe(401) })
  it('rejects malformed signed JSON', async () => { expect(await request('{')).toBe(400) })
  it('accepts signed ping events', async () => { expect(await request('{}', 'ping')).toBe(200) })
  it('dispatches opened/synchronize but ignores closed PRs', async () => {
    const statuses = await Promise.all(['opened', 'synchronize', 'closed'].map(action => request(JSON.stringify({ action }))))
    expect(statuses).toEqual([200, 200, 200])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect([...received].sort()).toEqual(['opened', 'synchronize'])
  })
  it('skips an occupied port', async () => {
    const occupied = (server.address() as AddressInfo).port
    expect(await findAvailablePort(occupied)).toBeGreaterThan(occupied)
  })
})
