/**
 * OpenSearch read client for full-text doc search (P4).
 *
 * The independent octo-doc-indexer writes doc/sheet/board bodies into the
 * `octo-doc` index (fields: doc_id / space_id / doc_type / status / share_scope /
 * title / body / updated_at / ver; title & body use the ik analyzer). This module
 * only READS that index — it never writes, never touches the mapping, and holds
 * no permission data.
 *
 * The caller (route) computes the visibility CONSTRAINT in MySQL first (§5.3):
 * a small private/explicitly-granted doc_id set + an isSpaceMember boolean. Those
 * are pushed DOWN into the OS query as a filter (§5.4), so every hit is already
 * within the caller's access — OS does the pagination and no per-hit MySQL
 * re-check is needed (§6.4).
 */
import { Client } from '@opensearch-project/opensearch'
import { config } from '../config/env.js'

let client: Client | null = null

/**
 * Lazily create the singleton OpenSearch client. Deferred (not built at module
 * load) so importing this file never opens a connection — the client is only
 * constructed the first time a search actually runs (search is default-OFF).
 */
export function getOsClient(): Client {
  if (!client) {
    const { opensearchNode, opensearchUsername, opensearchPassword } = config.search
    client = new Client({
      node: opensearchNode,
      // Basic auth only when both parts are configured; otherwise omit the header
      // entirely so an unauthenticated dev cluster works with empty creds.
      ...(opensearchUsername !== '' && opensearchPassword !== ''
        ? { auth: { username: opensearchUsername, password: opensearchPassword } }
        : {}),
    })
  }
  return client
}

/** One result item: business doc_id + display metadata straight from OS `_source`, optional body highlight. */
export interface SearchItem {
  docId: string
  title: string
  docType: string
  updatedAt: number | null
  highlight?: string
}

/**
 * Minimal shape of the OpenSearch search response we read. The client's own
 * generic types are broad/loose; we narrow to exactly the fields consumed here
 * and read them defensively (any of them may be absent on an odd hit).
 */
interface OsHit {
  _id?: string
  _source?: { doc_id?: string; title?: string; doc_type?: string; updated_at?: number }
  highlight?: { body?: string[] }
}
interface OsSearchBody {
  hits?: { total?: { value?: number }; hits?: OsHit[] }
}

/**
 * Run a full-text search against the `octo-doc` index with the caller's visibility
 * constraint pushed down as a filter, and let OS paginate (§5.4 / §6.4).
 *
 *   filter:
 *     - term space_id = spaceId
 *     - term status = 1 (archived/deleted docs the indexer may still carry excluded)
 *     - optional terms doc_type (kind filter)
 *     - bool.should [ terms doc_id IN <private set>, term share_scope=1 (members only) ]
 *       with minimum_should_match=1 — a hit must be in the private set OR (for a
 *       confirmed member) an anyone_in_space doc.
 *   query: multi_match over title^2 + body (ik-analyzed) + highlight on body.
 *
 * SHORT-CIRCUIT: with an empty private set AND a non-member, the should has no real
 * branch → nothing is visible → returns { total: 0, items: [] } WITHOUT hitting OS.
 *
 * total is read from hits.total.value (track_total_hits=true so it is exact, not
 * capped at 10k). _source carries title/doc_type/updated_at, so no MySQL round-trip.
 *
 * Throws on any OpenSearch error / unavailability — the route maps that to 503
 * and never fails open to returning everything.
 */
export async function searchDocs(params: {
  spaceId: string
  query: string
  docType?: string[]
  visibleDocIds: string[]
  isSpaceMember: boolean
  from: number
  size: number
}): Promise<{ total: number; items: SearchItem[] }> {
  const visibleDocIds = (params.visibleDocIds ?? []).filter((d) => typeof d === 'string' && d !== '')
  const docTypes = (params.docType ?? []).filter((t) => typeof t === 'string' && t !== '')

  // Build the should branches for the visibility constraint (§5.4). A member with
  // no private docs still sees space-share; a non-member with no private docs sees
  // nothing.
  const should: Array<Record<string, unknown>> = []
  if (visibleDocIds.length > 0) should.push({ terms: { doc_id: visibleDocIds } })
  if (params.isSpaceMember) should.push({ term: { share_scope: 1 } })

  // No real should branch => nothing visible => skip OS entirely (§6.4).
  if (should.length === 0) return { total: 0, items: [] }

  const filter: Array<Record<string, unknown>> = [
    { term: { space_id: params.spaceId } },
    { term: { status: 1 } },
  ]
  if (docTypes.length > 0) filter.push({ terms: { doc_type: docTypes } })
  filter.push({ bool: { should, minimum_should_match: 1 } })

  const os = getOsClient()
  const res = await os.search({
    index: config.search.opensearchIndex,
    // track_total_hits so hits.total.value is the exact match count (not capped at
    // 10k), which the response `total` needs to be accurate for pagination.
    track_total_hits: true,
    body: {
      from: params.from,
      size: params.size,
      _source: ['doc_id', 'title', 'doc_type', 'updated_at'],
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: params.query,
                fields: ['title^2', 'body'],
              },
            },
          ],
          filter,
        },
      },
      highlight: {
        fields: { body: {} },
      },
    },
  })
  const body = res.body as OsSearchBody
  const total = body.hits?.total?.value ?? 0
  const hits = body.hits?.hits ?? []
  const items: SearchItem[] = []
  for (const h of hits) {
    // Prefer the stored doc_id source field; fall back to _id (the indexer uses
    // doc_id as the OS document id). Skip a hit with neither.
    const docId = h._source?.doc_id ?? h._id
    if (typeof docId !== 'string' || docId === '') continue
    const fragment = h.highlight?.body?.[0]
    items.push({
      docId,
      title: typeof h._source?.title === 'string' ? h._source.title : '',
      docType: typeof h._source?.doc_type === 'string' ? h._source.doc_type : '',
      updatedAt: typeof h._source?.updated_at === 'number' ? h._source.updated_at : null,
      ...(typeof fragment === 'string' && fragment !== '' ? { highlight: fragment } : {}),
    })
  }
  return { total, items }
}
