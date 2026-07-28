import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level test for POST /api/v1/docs/search (searchDocsHandler) — full-text
// search with permission DOWN-PUSH (P4, §5.3/§5.4/§6.4). MySQL computes the
// visibility CONSTRAINT (a small private/explicitly-granted doc_id set +
// isSpaceMember), which the handler pushes DOWN into the OpenSearch query as a
// filter; OS then does the full-text match AND pagination. There is NO per-hit
// MySQL re-check — hits are already within the constraint.
// We mock the OS client (searchDocs), the doc_meta repo (listVisibleDocIdSet), the
// octo identity, and the config gate, then call the exported handler directly (no
// live infra) — the same offline style as docsListAuthz.test.ts.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    search: {
      enabled: true,
      opensearchNode: 'http://127.0.0.1:9200',
      opensearchIndex: 'octo-doc',
      opensearchUsername: '',
      opensearchPassword: '',
      pageSizeMax: 50,
    },
    webOrigin: '',
    docView: { retainCount: 200, retainDays: 90 },
  },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: { listVisibleDocIdSet: vi.fn() },
}))
const { searchDocsMock } = vi.hoisted(() => ({ searchDocsMock: vi.fn() }))
vi.mock('../src/search/osClient.js', async (importActual) => {
  // Keep the real VisibleTermsTooLargeError class (route uses instanceof) while
  // stubbing searchDocs itself.
  const actual = await importActual<typeof import('../src/search/osClient.js')>()
  return { ...actual, searchDocs: searchDocsMock }
})
const { isSpaceMemberMock } = vi.hoisted(() => ({ isSpaceMemberMock: vi.fn() }))
vi.mock('../src/auth/octoIdentity.js', () => ({
  getOctoIdentity: () => ({ isSpaceMember: isSpaceMemberMock }),
}))

import { searchDocsHandler } from '../src/api/routes/docs.js'
import { VisibleTermsTooLargeError } from '../src/search/osClient.js'
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
  vi.mocked(docMetaRepo.listVisibleDocIdSet).mockReset()
  vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue([])
  searchDocsMock.mockReset()
  searchDocsMock.mockResolvedValue({ total: 0, items: [] })
  isSpaceMemberMock.mockReset()
  isSpaceMemberMock.mockResolvedValue(true)
})

describe('POST /api/v1/docs/search — searchDocsHandler', () => {
  it('member: passes isSpaceMember=true to listVisibleDocIdSet so space-share is folded into the visible set, then pushes that set to OS', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d_priv1', 'd_priv2'])
    searchDocsMock.mockResolvedValue({
      total: 1,
      items: [
        { docId: 'd_priv1', title: 'One', docType: 'doc', updatedAt: 1000, spaceId: 's_target', highlight: '…hit…' },
      ],
    })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'hello' } }), res as never)

    expect(res.statusCode).toBe(200)
    // MySQL computed the full visible set for this caller + space, WITH the member flag.
    const listArg = vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0]
    expect(listArg).toMatchObject({ uid: 'u_1', spaceId: 's_target', isSpaceMember: true })
    // Only the resolved doc_id set is pushed to OS — no isSpaceMember/share_scope.
    const osArg = searchDocsMock.mock.calls[0]![0]
    expect(osArg).toMatchObject({
      spaceId: 's_target',
      query: 'hello',
      visibleDocIds: ['d_priv1', 'd_priv2'],
    })
    expect(osArg.isSpaceMember).toBeUndefined()

    const body = res.body as { total: number; items: Array<{ docId: string; title: string; docType: string; updatedAt: number; spaceId?: string; highlight?: string; role?: unknown; score?: unknown }> }
    expect(body.total).toBe(1)
    expect(body.items[0]).toMatchObject({ docId: 'd_priv1', title: 'One', docType: 'doc', updatedAt: 1000, spaceId: 's_target', highlight: '…hit…' })
    // §6.3: no role, no score in the response.
    expect(body.items[0]!.role).toBeUndefined()
    expect(body.items[0]!.score).toBeUndefined()
  })

  it('non-member: passes isSpaceMember=false to listVisibleDocIdSet (space-share excluded from the set)', async () => {
    isSpaceMemberMock.mockResolvedValue(false)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d_priv1'])
    searchDocsMock.mockResolvedValue({ total: 0, items: [] })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)

    expect(res.statusCode).toBe(200)
    const listArg = vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0]
    expect(listArg).toMatchObject({ isSpaceMember: false })
    const osArg = searchDocsMock.mock.calls[0]![0]
    expect(osArg.visibleDocIds).toEqual(['d_priv1'])
    expect(osArg.isSpaceMember).toBeUndefined()
  })

  it('empty visible set => the set pushed to OS is empty and total=0 (searchDocs short-circuits without hitting OS)', async () => {
    // The no-OS-call short-circuit lives INSIDE searchDocs (osClient), covered by
    // its own unit test (osClientSearch.test.ts). At the route level searchDocs is
    // mocked, so here we assert the route pushes the empty visible set down.
    isSpaceMemberMock.mockResolvedValue(false)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue([])
    searchDocsMock.mockResolvedValue({ total: 0, items: [] })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ total: 0, items: [] })
    const osArg = searchDocsMock.mock.calls[0]![0]
    expect(osArg.visibleDocIds).toEqual([])
  })

  it('pagination params (from/size) are passed to OS', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 42, items: [] })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', page: 3, pageSize: 10 } }), res as never)

    const osArg = searchDocsMock.mock.calls[0]![0]
    // page 3, size 10 => from = (3-1)*10 = 20, size = 10.
    expect(osArg.from).toBe(20)
    expect(osArg.size).toBe(10)
    // total is taken straight from OS hits.total.value.
    expect((res.body as { total: number }).total).toBe(42)
  })

  it('pageSize is clamped to config.search.pageSizeMax', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 0, items: [] })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', pageSize: 9999 } }), res as never)
    expect(searchDocsMock.mock.calls[0]![0].size).toBe(mockConfig.search.pageSizeMax)
  })

  it('docType filter is passed to BOTH the MySQL constraint and OS', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockResolvedValue({ total: 0, items: [] })
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x', docType: ['doc', 'sheet'] } }), res as never)
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(docMetaRepo.listVisibleDocIdSet).mock.calls[0]![0].docType).toEqual(['doc', 'sheet'])
    expect(searchDocsMock.mock.calls[0]![0].docType).toEqual(['doc', 'sheet'])
  })

  it('search disabled => 503, never touches OpenSearch or the DB', async () => {
    mockConfig.search.enabled = false
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    expect(searchDocsMock).not.toHaveBeenCalled()
    expect(docMetaRepo.listVisibleDocIdSet).not.toHaveBeenCalled()
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
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockRejectedValue(new Error('opensearch unavailable'))
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    expect(res.body).toEqual({ error: 'search unavailable' })
  })

  it('visible set too large => 503 with a distinct terms_limit_exceeded reason', async () => {
    isSpaceMemberMock.mockResolvedValue(true)
    vi.mocked(docMetaRepo.listVisibleDocIdSet).mockResolvedValue(['d1'])
    searchDocsMock.mockRejectedValue(new VisibleTermsTooLargeError(70000, 65536))
    const res = mockRes()
    await searchDocsHandler(req({ body: { q: 'x' } }), res as never)
    expect(res.statusCode).toBe(503)
    // Distinct reason so a client narrows the query instead of blindly retrying.
    expect(res.body).toEqual({ error: 'search unavailable', reason: 'terms_limit_exceeded' })
  })
})
