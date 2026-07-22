import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fake Redis whose multi()/lpush/ltrim/exec mutate an in-memory list, so we can
// assert both the enqueued payload and the LTRIM bound without a live Redis.
// Mirrors the offline mock style in epoch.test.ts.
const lists = new Map<string, string[]>()
const execOps: Array<Array<[string, unknown[]]>> = []
let failExec = false

function makeMulti() {
  const ops: Array<[string, unknown[]]> = []
  const chain = {
    lpush(...args: unknown[]) {
      ops.push(['lpush', args])
      return chain
    },
    ltrim(...args: unknown[]) {
      ops.push(['ltrim', args])
      return chain
    },
    async exec() {
      if (failExec) throw new Error('redis down')
      for (const [op, args] of ops) {
        if (op === 'lpush') {
          const [k, v] = args as [string, string]
          const a = lists.get(k) ?? []
          a.unshift(v) // LPUSH: newest at head
          lists.set(k, a)
        } else if (op === 'ltrim') {
          const [k, start, stop] = args as [string, number, number]
          const a = lists.get(k) ?? []
          lists.set(k, a.slice(start, stop + 1))
        }
      }
      execOps.push(ops)
      return []
    },
  }
  return chain
}

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => ({ multi: makeMulti }),
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

import {
  enqueueDocIndex,
  isSearchIndexedDoc,
  docIndexQueueKey,
  type DocIndexSignal,
} from '../src/search/docIndexQueue.js'
import { config } from '../src/config/env.js'

beforeEach(() => {
  lists.clear()
  execOps.length = 0
  failExec = false
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
  it('pushes a body signal with the {documentName, kind, ts} payload', async () => {
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(true)
    const raw = lists.get(docIndexQueueKey())
    expect(raw).toHaveLength(1)
    const signal = JSON.parse(raw![0]) as DocIndexSignal
    expect(signal.documentName).toBe('octo:sp1:fol1:doc1')
    expect(signal.kind).toBe('body')
    expect(typeof signal.ts).toBe('number')
    expect(signal.ts).toBeGreaterThan(0)
  })

  it('pushes an acl signal for permission changes', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1', 'acl')
    const signal = JSON.parse(lists.get(docIndexQueueKey())![0]) as DocIndexSignal
    expect(signal.kind).toBe('acl')
  })

  it('defaults kind to body', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1')
    const signal = JSON.parse(lists.get(docIndexQueueKey())![0]) as DocIndexSignal
    expect(signal.kind).toBe('body')
  })

  it('uses the namespaced queue key', () => {
    expect(docIndexQueueKey()).toBe('octo-docs:search:body-queue')
  })

  it('LTRIMs to queueMax on every push to bound shared-Redis growth', async () => {
    await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    const key = docIndexQueueKey()
    const lastOps = execOps.at(-1)!
    const ltrim = lastOps.find(([op]) => op === 'ltrim')
    expect(ltrim).toBeDefined()
    expect(ltrim![1]).toEqual([key, 0, config.search.queueMax - 1])
  })

  it('swallows a Redis failure, returns false, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failExec = true
    const ok = await enqueueDocIndex('octo:sp1:fol1:doc1', 'body')
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
