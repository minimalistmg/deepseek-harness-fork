/**
 * Egress coverage for the balance reader: the outbound platform read must go
 * through whatever proxy policy the process installed, so a deployment that
 * reaches the platform only through a proxy is not bypassed by this plugin. The
 * proxy answers 502, which the provider reports as a failure — the point of the
 * spec is where the bytes went, not what came back.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountBalanceProvider } from '../src/balance.ts'

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}

/**
 * Run one read with the proxy policy installed and report where it went.
 * @param run - the read to observe.
 * @returns the proxy's request log for that read.
 */
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}

describe('account balance egress', () => {
  it('goes through the proxy', async () => {
    const provider = new AccountBalanceProvider(() => ({
      baseURL: 'http://balance-probe.invalid',
      fxBaseURL: 'https://rates.example',
      displayCurrency: '',
      timeoutMs: 5000,
      apiKeyEnv: credentialRef('DEEPSEEK_API_KEY'),
      resolveApiKey: async () => 'probe-key',
    }))
    expect(await observe(() => provider.read())).toEqual([
      'REQ http://balance-probe.invalid/user/balance',
    ])
  })
})
