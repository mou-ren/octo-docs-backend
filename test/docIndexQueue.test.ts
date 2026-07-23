import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake Redis whose xadd records the call args (key + flat field/value pairs) into
// an in-memory log, so we can assert the stream key, payload fields and the
// MAXLEN trim without a live Redis. Mirrors the offline mock style in
// epoch.test.ts.
type XaddCall = unknown[]
const xaddCalls: XaddCall[] = []
let failXadd = false

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({
    async xadd(...args: unknown[]) {
      if (failXadd) throw new Error('redis down')
      xaddCalls.push(args)
      return '1-0'
    },
  }),
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

import {
  enqueueDocIndex,
  isSearchIndexedDoc,
  docIndexQueueKey,
} from '../src/search/docIndexQueue.js'
import { config } from '../src/config/env.js'

// Decode an xadd(key, 'MAXLEN','~',max,'*', 'payload', json) call into
// { key, maxlen, signal } for assertions.
function decodeXadd(call: XaddCall) {
  const key = call[0] as string
  const maxlen = call[3]
  // call[4]='*', call[5]='payload', call[6]=json
  const payloadField = call[5] as string
  const signal = JSON.parse(call[6] as string)
  return { key, maxlen, star: call[4], payloadField, signal }
}

beforeEach(() => {
  xaddCalls.length = 0
  failXadd = false
})

describe('isSearchIndexedDoc — which docs get enqueued', () => {
  it('accepts document (doc/sheet, 4-seg) keys', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:doc1')).toBe(true)
  })
  it('rejects html (5-seg) keys — html excluded at the producer this期', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:html:doc2')).toBe(false)
  })
  it('accepts whiteboards (board, :wb: key — has an extractable Yjs body)', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:wb:board1')).toBe(true)
  })
  it('rejects malformed names (parse failure => fail-safe drop)', () => {
    expect(isSearchIndexedDoc('not-a-doc-name')).toBe(false)
    expect(isSearchIndexedDoc('')).toBe(false)
  })
})

describe('enqueueDocIndex — producer', () => {
  it('XADDs a body signal as a JSON payload field with {documentName, kind, ts}', async () => {
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(true)
    expect(xaddCalls).toHaveLength(1)
    const { key, star, payloadField, signal } = decodeXadd(xaddCalls[0]!)
    expect(key).toBe(docIndexQueueKey())
    expect(star).toBe('*') // server-assigned id
    expect(payloadField).toBe('payload')
    expect(signal.documentName).toBe('octo:sp1:fol1:doc1')
    expect(signal.kind).toBe('body')
    expect(typeof signal.ts).toBe('number')
    expect(signal.ts).toBeGreaterThan(0)
  })

  it('defaults kind to body', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1')
    expect(decodeXadd(xaddCalls[0]!).signal.kind).toBe('body')
  })

  it('writes the REDIS_PREFIX-namespaced stream key (must match indexer STREAM_KEY)', () => {
    expect(docIndexQueueKey()).toBe(config.search.indexStreamKey)
    // Namespaced under the shared prefix, not a bare 'doc-index'.
    expect(docIndexQueueKey()).toBe(`${config.redis.prefix}:doc-index`)
  })

  it('trims with MAXLEN ~ queueMax on every XADD to bound shared-Redis growth', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    const call = xaddCalls[0]!
    expect(call[1]).toBe('MAXLEN')
    expect(call[2]).toBe('~')
    expect(call[3]).toBe(config.search.queueMax)
  })

  it('swallows a Redis failure, returns false, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failXadd = true
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
