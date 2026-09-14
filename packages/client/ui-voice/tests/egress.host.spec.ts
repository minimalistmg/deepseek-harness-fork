/**
 * Egress coverage for the polish provider: the outbound `generateContent` call
 * must go through whatever proxy policy the process installed, so a deployment
 * that reaches Gemini only through a proxy is not bypassed by this plugin. The
 * proxy answers 502, which the provider degrades to the raw transcript — the
 * point of the spec is where the bytes went, not what came back.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { VoicePolishProvider } from '../src/polish.ts'

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
 * Run one polish with the proxy policy installed and report where it went.
 * @param run - the polish to observe.
 * @returns the proxy's request log for that polish.
 */
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}

describe('voice polish egress', () => {
  it('goes through the proxy', async () => {
    const p = new VoicePolishProvider(() => ({
      baseURL: 'http://voice-polish-probe.invalid',
      model: 'probe-model',
      prompt: 'probe',
      maxOutputTokens: 2048,
      temperature: 0.2,
      timeoutMs: 8000,
      apiKeyEnv: credentialRef('GEMINI_API_KEY'),
      resolveApiKey: async () => 'probe-key',
    }))
    expect(await observe(() => p.polish('probe'))).toEqual([
      'REQ http://voice-polish-probe.invalid/v1beta/models/probe-model:generateContent',
    ])
  })
})
