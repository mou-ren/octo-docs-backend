import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level test for POST /api/v1/docs/search (searchDocsHandler) — full-text
// search with permission DOWN-PUSH (P4). OpenSearch returns relevance-ordered
// candidates holding NO permission data; the DB visibility model
// (docMetaRepo.filterVisibleDocIds) intersects them with what the caller may see.
// We mock the OS client (searchDocs), the doc_meta repo, the octo identity, and
// the config gate, then call the exported handler directly (no live infra) — the
// same offline style as docsListAuthz.test.ts.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    search: {
      enabled: true,
      opensearchNode: 'http://127.0.0.1:9200',
      opensearchIndex: 'octo-doc',
      opensearchUsername: '',
      opensearchPassword: '',
      maxCandidates: 200,
      pageSizeMax: 50,
    },
    webOrigin: '',
    docView: { retainCount: 200, retainDays: 90 },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { filterVisibleDocIds: vi.fn() },
}))
const { searchDocsMock } = vi.hoisted(() => ({ searchDocsMock: vi.fn() }))
vi.mock('../src/search/osClient.js', () => ({ searchDocs: searchDocsMock }))
const { isSpaceMemberMock } = vi.hoisted(() => ({ isSpaceMemberMock: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ isSpaceMember: isSpaceMemberMock }),
}))

import { searchDocsHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
}
function req(extra: Record<string, unknown>) {
  return { uid: 'u_1', spaceId: 's_target', octoToken: 'tok', body: {}, ...extra } as never
}

beforeEach(() => {
  mockConfig.search.enabled = true
  vi.mocked(docMetaRepo.filterVisibleDocIds).mockReset()
  searchDocsMock.mockReset()
  isSpaceMemberMock.mockReset()
  isSpaceMemberMock.mockResolvedValue(true)
})

describe('POST /api/v1/docs/search — searchDocsHandler', () => {
  it('permission intersection: OS returns 5 candidates, only the 2 the caller can see are returned, IN OS RELEVANCE ORDER', async () => {
    // OS relevance order: d1 (top) .. d5.
    searchDocsMock.mockResolvedValue([
      { docId: 'd1', score: 5.0 },
      { docId: 'd2', score: 4.0, highlight: '…hit…' },
      { docId: 'd3', score: 3.0 },
      { docId: 'd4', score: 2.0 },
      { docId: 'd5', score: 1.0 },
    ])
    // DB says caller can only see d4 (owner) and d2 (share/member). Map insertion
    // order is deliberately NOT the OS order, to prove the handler re-orders by OS.
    vi.mocked(docMetaRepo.filterVisibleDocIds).mockResolvedValue(
      new Map([
        ['d4', { role: 3, title: 'Four', docType: 'doc', updatedAt: new Date(0) }],
        ['d2', { role: 1, title: 'Two', docType: 'sheet', updatedAt: new Date(0) }],
      ]),
    )
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'hello' } }), res as never)

    expect(res.statusCode).toBe(200)
    // OS was asked to search the caller's space.
    expect(searchDocsMock).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 's_target', query: 'hello' }),
    )
    // The repo received the full candidate set for intersection.
    const filterArg = vi.mocked(docMetaRepo.filterVisibleDocIds).mock.calls[0]![0]
    expect(filterArg.docIds).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(filterArg.uid).toBe('u_1')
    expect(filterArg.spaceId).toBe('s_target')

    const body = res.body as { total: number; items: Array<{ docId: string; role: string; title: string; docType: string; score: number; highlight?: string }> }
    expect(body.total).toBe(2)
    // Preserves OS relevance order: d2 (score 4) BEFORE d4 (score 2), not Map order.
    expect(body.items.map((i) => i.docId)).toEqual(['d2', 'd4'])
    expect(body.items[0]).toMatchObject({ docId: 'd2', title: 'Two', docType: 'sheet', role: 'reader', score: 4.0, highlight: '…hit…' })
    expect(body.items[1]).toMatchObject({ docId: 'd4', title: 'Four', docType: 'doc', role: 'admin', score: 2.0 })
    expect(body.items[1]!.highlight).toBeUndefined()
  })

  it('space isolation: a candidate in another space is not visible (DB intersection drops it)', async () => {
    searchDocsMock.mockResolvedValue([
      { docId: 'd_here', score: 2.0 },
      { docId: 'd_other_space', score: 1.0 },
    ])
    // filterVisibleDocIds is space-scoped in its WHERE (space_id = ?), so the
    // cross-space candidate never comes back visible.
    vi.mocked(docMetaRepo.filterVisibleDocIds).mockResolvedValue(
      new Map([['d_here', { role: 1, title: 'Here', docType: 'doc', updatedAt: new Date(0) }]]),
    )
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    const body = res.body as { total: number; items: Array<{ docId: string }> }
    expect(body.total).toBe(1)
    expect(body.items.map((i) => i.docId)).toEqual(['d_here'])
  })

  it('status: an archived/deleted candidate (status≠1) present in OS is dropped by the DB status=1 gate', async () => {
    searchDocsMock.mockResolvedValue([
      { docId: 'd_active', score: 2.0 },
      { docId: 'd_archived', score: 1.5 },
    ])
    // filterVisibleDocIds enforces status=1, so d_archived never resolves visible.
    vi.mocked(docMetaRepo.filterVisibleDocIds).mockResolvedValue(
      new Map([['d_active', { role: 2, title: 'Active', docType: 'doc', updatedAt: new Date(0) }]]),
    )
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    const body = res.body as { total: number; items: Array<{ docId: string }> }
    expect(body.items.map((i) => i.docId)).toEqual(['d_active'])
  })

  it('search disabled => 503, never touches OpenSearch', async () => {
    mockConfig.search.enabled = false
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    expect(searchDocsMock).not.toHaveBeenCalled()
  })

  it('missing q => 400', async () => {
    const res = mockRes()
    await searchDocsHandler(req({ body: {} }), res as never)
    expect(res.statusCode).toBe(400)
    expect(searchDocsMock).not.toHaveBeenCalled()
  })

  it('blank q => 400', async () => {
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: '   ' } }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('OpenSearch error => 503 (never fail-open to returning everything)', async () => {
    searchDocsMock.mockRejectedValue(new Error('opensearch unavailable'))
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'search unavailable' })
    // never reached the DB intersection.
    expect(docMetaRepo.filterVisibleDocIds).not.toHaveBeenCalled()
  })

  it('in-memory pagination over the visible (OS-ordered) set', async () => {
    searchDocsMock.mockResolvedValue(
      [1, 2, 3, 4, 5].map((n) => ({ docId: `d${n}`, score: 10 - n })),
    )
    vi.mocked(docMetaRepo.filterVisibleDocIds).mockResolvedValue(
      new Map([1, 2, 3, 4, 5].map((n) => [`d${n}`, { role: 1, title: `T${n}`, docType: 'doc', updatedAt: new Date(0) }])),
    )
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', page: 2, pageSize: 2 } }), res as never)
    const body = res.body as { total: number; items: Array<{ docId: string }> }
    expect(body.total).toBe(5)
    // page 2 of size 2 => the 3rd and 4th visible docs, in OS order.
    expect(body.items.map((i) => i.docId)).toEqual(['d3', 'd4'])
  })
})
