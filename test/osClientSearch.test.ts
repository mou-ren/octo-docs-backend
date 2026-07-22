import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit test for searchDocs (src/search/osClient.ts) — the visibility constraint
// down-push (§5.4) + OS pagination (§6.4). We mock the OpenSearch Client so no
// live cluster is needed and assert on the exact request body the module builds.
const { searchSpy } = vi.hoisted(() => ({ searchSpy: vi.fn() }))
vi.mock('@opensearch-project/opensearch', () => ({
  Client: vi.fn().mockImplementation(() => ({ search: searchSpy })),
}))
vi.mock('../src/config/env.js', () => ({
  config: {
    search: {
      opensearchNode: 'http://127.0.0.1:9200',
      opensearchIndex: 'octo-doc',
      opensearchUsername: '',
      opensearchPassword: '',
      maxCandidates: 200,
      pageSizeMax: 50,
    },
  },
}))

import { searchDocs } from '../src/search/osClient.js'

beforeEach(() => {
  searchSpy.mockReset()
})

function osResponse(hits: unknown[], total: number) {
  return { body: { hits: { total: { value: total }, hits } } }
}

describe('searchDocs — constraint down-push + OS pagination', () => {
  it('member + private set: filter has BOTH terms doc_id AND term share_scope=1, minimum_should_match=1', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'hello',
      visibleDocIds: ['d1', 'd2'],
      isSpaceMember: true,
      from: 0,
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as {
      track_total_hits: boolean
      body: { from: number; size: number; query: { bool: { filter: Array<Record<string, unknown>> } } }
    }
    expect(arg.track_total_hits).toBe(true)
    expect(arg.body.from).toBe(0)
    expect(arg.body.size).toBe(20)
    const filter = arg.body.query.bool.filter
    expect(filter).toContainEqual({ term: { space_id: 's1' } })
    expect(filter).toContainEqual({ term: { status: 1 } })
    const shouldClause = filter.find((f) => 'bool' in f) as { bool: { should: unknown[]; minimum_should_match: number } }
    expect(shouldClause.bool.minimum_should_match).toBe(1)
    expect(shouldClause.bool.should).toContainEqual({ terms: { doc_id: ['d1', 'd2'] } })
    expect(shouldClause.bool.should).toContainEqual({ term: { share_scope: 1 } })
  })

  it('non-member: should has ONLY terms doc_id (no share_scope branch)', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1'],
      isSpaceMember: false,
      from: 0,
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { query: { bool: { filter: Array<Record<string, unknown>> } } } }
    const shouldClause = arg.body.query.bool.filter.find((f) => 'bool' in f) as { bool: { should: unknown[] } }
    expect(shouldClause.bool.should).toEqual([{ terms: { doc_id: ['d1'] } }])
  })

  it('empty private set AND non-member => total=0 WITHOUT calling OpenSearch', async () => {
    const res = await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: [],
      isSpaceMember: false,
      from: 0,
      size: 20,
    })
    expect(res).toEqual({ total: 0, items: [] })
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('member with empty private set still searches (share_scope only)', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: [],
      isSpaceMember: true,
      from: 0,
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { query: { bool: { filter: Array<Record<string, unknown>> } } } }
    const shouldClause = arg.body.query.bool.filter.find((f) => 'bool' in f) as { bool: { should: unknown[] } }
    expect(shouldClause.bool.should).toEqual([{ term: { share_scope: 1 } }])
  })

  it('docType => terms doc_type filter branch is added', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      docType: ['doc', 'sheet'],
      visibleDocIds: ['d1'],
      isSpaceMember: false,
      from: 0,
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { query: { bool: { filter: Array<Record<string, unknown>> } } } }
    expect(arg.body.query.bool.filter).toContainEqual({ terms: { doc_type: ['doc', 'sheet'] } })
  })

  it('maps _source (title/doc_type/updated_at) + highlight, reads total from hits.total.value', async () => {
    searchSpy.mockResolvedValue(
      osResponse(
        [
          {
            _id: 'd1',
            _source: { doc_id: 'd1', title: 'Title One', doc_type: 'doc', updated_at: 1700 },
            highlight: { body: ['…frag…'] },
          },
          {
            _id: 'd2',
            _source: { doc_id: 'd2', title: 'Title Two', doc_type: 'sheet', updated_at: 1800 },
          },
        ],
        7,
      ),
    )
    const res = await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1', 'd2'],
      isSpaceMember: true,
      from: 0,
      size: 20,
    })
    expect(res.total).toBe(7)
    expect(res.items[0]).toEqual({ docId: 'd1', title: 'Title One', docType: 'doc', updatedAt: 1700, highlight: '…frag…' })
    expect(res.items[1]).toEqual({ docId: 'd2', title: 'Title Two', docType: 'sheet', updatedAt: 1800 })
    expect(res.items[1]!.highlight).toBeUndefined()
  })

  it('propagates from/size for OS-side pagination', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1'],
      isSpaceMember: true,
      from: 40,
      size: 10,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { from: number; size: number } }
    expect(arg.body.from).toBe(40)
    expect(arg.body.size).toBe(10)
  })

  it('throws on OpenSearch error (route maps to 503)', async () => {
    searchSpy.mockRejectedValue(new Error('cluster down'))
    await expect(
      searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], isSpaceMember: true, from: 0, size: 20 }),
    ).rejects.toThrow('cluster down')
  })
})
