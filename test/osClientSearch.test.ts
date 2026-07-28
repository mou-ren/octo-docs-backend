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

describe('searchDocs — visible-set down-push + OS pagination', () => {
  it('pushes the visible doc_id set down as a terms filter (no share_scope branch)', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'hello',
      visibleDocIds: ['d1', 'd2'],
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
    // Visibility is a single terms doc_id filter now — no bool.should/share_scope.
    expect(filter).toContainEqual({ terms: { doc_id: ['d1', 'd2'] } })
    expect(filter.find((f) => 'bool' in f)).toBeUndefined()
  })

  it('requests HTML-encoded highlights (encoder:html) so body markup cannot become an XSS sink', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1'],
      from: 0,
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { highlight: { encoder: string } } }
    // Without encoder:'html', a document body containing HTML-like text would be
    // copied verbatim into the highlight fragment and could execute if the client
    // renders it as HTML. encoder:'html' makes OpenSearch encode the body first.
    expect(arg.body.highlight.encoder).toBe('html')
  })

  it('empty visible set => total=0 WITHOUT calling OpenSearch', async () => {
    const res = await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: [],
      from: 0,
      size: 20,
    })
    expect(res).toEqual({ total: 0, items: [] })
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('docType => terms doc_type filter branch is added', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      docType: ['doc', 'sheet'],
      visibleDocIds: ['d1'],
      from: 0,
      size: 20,
    })
    const arg = searchSpy.mock.calls[0]![0] as { body: { query: { bool: { filter: Array<Record<string, unknown>> } } } }
    expect(arg.body.query.bool.filter).toContainEqual({ terms: { doc_type: ['doc', 'sheet'] } })
  })

  it('maps _source (title/doc_type/updated_at/space_id) + highlight, reads total from hits.total.value', async () => {
    searchSpy.mockResolvedValue(
      osResponse(
        [
          {
            _id: 'd1',
            _source: { doc_id: 'd1', title: 'Title One', doc_type: 'doc', updated_at: 1700, space_id: 's1' },
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
      from: 0,
      size: 20,
    })
    expect(res.total).toBe(7)
    expect(res.items[0]).toEqual({ docId: 'd1', title: 'Title One', docType: 'doc', updatedAt: 1700, spaceId: 's1', highlight: '…frag…' })
    // d2's _source has no space_id → spaceId falls back to '' (defensive read).
    expect(res.items[1]).toEqual({ docId: 'd2', title: 'Title Two', docType: 'sheet', updatedAt: 1800, spaceId: '' })
    expect(res.items[1]!.highlight).toBeUndefined()
  })

  it('propagates from/size for OS-side pagination', async () => {
    searchSpy.mockResolvedValue(osResponse([], 0))
    await searchDocs({
      spaceId: 's1',
      query: 'x',
      visibleDocIds: ['d1'],
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
      searchDocs({ spaceId: 's1', query: 'x', visibleDocIds: ['d1'], from: 0, size: 20 }),
    ).rejects.toThrow('cluster down')
  })
})
