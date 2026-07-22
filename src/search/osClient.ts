/**
 * OpenSearch read client for full-text doc search (P4).
 *
 * The independent octo-doc-indexer writes doc/sheet/board bodies into the
 * `octo-doc` index (fields: doc_id / space_id / doc_type / status / share_scope /
 * title / body / updated_at / ver; title & body use the ik analyzer). This module
 * only READS that index — it never writes, never touches the mapping, and holds
 * no permission data. A search returns candidate doc_ids in OpenSearch relevance
 * order; the DB visibility model (docMetaRepo.filterVisibleDocIds) then filters
 * them to what the caller may actually see.
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

/** One candidate hit from OpenSearch: the doc_id, its relevance score, an optional body highlight. */
export interface SearchCandidate {
  docId: string
  score: number
  highlight?: string
}

/**
 * Minimal shape of the OpenSearch search response we read. The client's own
 * generic types are broad/loose; we narrow to exactly the fields consumed here
 * and read them defensively (any of them may be absent on an odd hit).
 */
interface OsHit {
  _id?: string
  _score?: number | null
  _source?: { doc_id?: string }
  highlight?: { body?: string[] }
}
interface OsSearchBody {
  hits?: { hits?: OsHit[] }
}

/**
 * Run a full-text search against the `octo-doc` index, scoped to one space and
 * to active (status=1) docs, returning candidate doc_ids in OS relevance order.
 *
 *   - multi_match over title^2 + body (ik-analyzed).
 *   - filter: term space_id = spaceId AND term status = 1 (archived/deleted docs
 *     the indexer may still carry are excluded here; the DB status=1 gate is the
 *     authoritative backstop downstream).
 *   - highlight on body (optional per-hit fragment).
 *
 * Throws on any OpenSearch error / unavailability — the route maps that to 503
 * and never fails open to returning everything.
 */
export async function searchDocs(params: {
  spaceId: string
  query: string
  size: number
}): Promise<SearchCandidate[]> {
  const os = getOsClient()
  const size = Math.max(1, Math.min(params.size, config.search.maxCandidates))
  const res = await os.search({
    index: config.search.opensearchIndex,
    body: {
      size,
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
          filter: [{ term: { space_id: params.spaceId } }, { term: { status: 1 } }],
        },
      },
      highlight: {
        fields: { body: {} },
      },
    },
  })
  const body = res.body as OsSearchBody
  const hits = body.hits?.hits ?? []
  const out: SearchCandidate[] = []
  for (const h of hits) {
    // Prefer the stored doc_id source field; fall back to _id (the indexer uses
    // doc_id as the OS document id). Skip a hit with neither.
    const docId = h._source?.doc_id ?? h._id
    if (typeof docId !== 'string' || docId === '') continue
    const fragment = h.highlight?.body?.[0]
    out.push({
      docId,
      score: typeof h._score === 'number' ? h._score : 0,
      ...(typeof fragment === 'string' && fragment !== '' ? { highlight: fragment } : {}),
    })
  }
  return out
}
