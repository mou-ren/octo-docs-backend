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

// Decode an xadd(key, 'MAXLEN','~',max,'*', f1,v1, f2,v2, ...) call into
// { key, maxlen, fields } for assertions.
function decodeXadd(call: XaddCall) {
  const key = call[0] as string
  // call[1]='MAXLEN', call[2]='~', call[3]=max, call[4]='*', then field/value pairs
  const maxlen = call[3]
  const fields: Record<string, string> = {}
  for (let i = 5; i + 1 < call.length; i += 2) {
    fields[call[i] as string] = call[i + 1] as string
  }
  return { key, maxlen, star: call[4], fields }
}

beforeEach(() => {
  xaddCalls.length = 0
  failXadd = false
})

describe('isSearchIndexedDoc — which docs get enqueued', () => {
  it('accepts document (doc/sheet, 4-seg) keys', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:doc1')).toBe(true)
  })
  it('accepts html (5-seg) keys', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:html:doc2')).toBe(true)
  })
  it('rejects whiteboards (no searchable body)', () => {
    expect(isSearchIndexedDoc('octo:sp1:fol1:wb:board1')).toBe(false)
  })
  it('rejects malformed names (parse failure => fail-safe drop)', () => {
    expect(isSearchIndexedDoc('not-a-doc-name')).toBe(false)
    expect(isSearchIndexedDoc('')).toBe(false)
  })
})

describe('enqueueDocIndex — producer', () => {
  it('XADDs a body signal with the flat {documentName, kind, ts} fields', async () => {
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(true)
    expect(xaddCalls).toHaveLength(1)
    const { key, star, fields } = decodeXadd(xaddCalls[0]!)
    expect(key).toBe(docIndexQueueKey())
    expect(star).toBe('*') // server-assigned id
    expect(fields.documentName).toBe('octo:sp1:fol1:doc1')
    expect(fields.kind).toBe('body')
    expect(Number(fields.ts)).toBeGreaterThan(0)
  })

  it('XADDs an acl signal for permission changes', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1', 'acl')
    expect(decodeXadd(xaddCalls[0]!).fields.kind).toBe('acl')
  })

  it('defaults kind to body', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1')
    expect(decodeXadd(xaddCalls[0]!).fields.kind).toBe('body')
  })

  it('writes the UNPREFIXED stream key that byte-matches the indexer STREAM_KEY', () => {
    // Must equal the indexer default ('doc-index'), NOT an rkey-namespaced key.
    expect(docIndexQueueKey()).toBe(config.search.indexStreamKey)
    expect(docIndexQueueKey()).toBe('doc-index')
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
