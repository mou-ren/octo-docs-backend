/**
 * Full-text search index queue — PRODUCER side only.
 *
 * When a document's authoritative state is persisted (collab afterStoreDocument,
 * §3.3a of the search design), we enqueue a tiny "this doc changed" signal so a
 * separate indexer can later re-read the latest body and upsert it into
 * OpenSearch. The signal deliberately carries ONLY the documentName (no body,
 * no ACL) — the consumer re-reads authoritative data by key, which keeps the
 * message small. Coalescing is a CONSUMER behavior (collapse repeated signals
 * for a doc, read once): the stream itself does not dedupe, so a burst of edits
 * appends one entry each.
 *
 * Transport: a Redis STREAM over the shared ioredis client (XADD here; the
 * indexer XREADGROUPs via a consumer group with PEL/XACK/XCLAIM/DLQ for
 * at-least-once delivery). The stream key MUST byte-match the indexer's
 * STREAM_KEY (config.search.indexStreamKey, default `${REDIS_PREFIX}:doc-index`,
 * e.g. 'octo-docs-test:doc-index'). The payload is a single JSON field
 * `payload` holding {documentName,kind,ts}; the indexer JSON.parses it. The
 * consumer / indexer / OpenSearch wiring is intentionally out of scope for this
 * module.
 *
 * Bounded: because the stream lives on the SHARED Redis (also backing epoch
 * cache, pub/sub and the connection registry), an absent/lagging consumer must
 * not grow it without limit and OOM the shared instance. Each XADD therefore
 * trims with MAXLEN ~ config.search.queueMax. This is a safety valve, not a
 * guarantee: under sustained overflow the OLDEST entries are dropped. Rollout
 * contract: deploy the consumer BEFORE flipping SEARCH_INDEX_ENABLED on.
 *
 * This is a best-effort side channel: an XADD failure must NEVER disturb the
 * collab store path, so callers fire-and-forget and every error is swallowed
 * after logging.
 */
import { getRedis } from '../db/redis.js'
import { parseDocumentName } from '../permission/documentName.js'
import { config } from '../config/env.js'

/**
 * Redis STREAM key holding pending index signals. Namespaced via REDIS_PREFIX
 * (config.search.indexStreamKey) to match every other doc-backend key on the
 * shared Redis; the indexer's STREAM_KEY env MUST be set to the same value.
 */
export function docIndexQueueKey(): string {
  return config.search.indexStreamKey
}

/**
 * Kind of change that triggered the signal:
 *  - 'body' — content changed; consumer re-reads the body and re-indexes it.
 *  - 'acl'  — permission changed (owner/member/share/status); consumer re-reads
 *    the ACL fields and partial-updates them WITHOUT touching the body.
 */
export type DocIndexKind = 'body' | 'acl'

/**
 * Whether a documentName has a searchable body worth enqueuing. Only 'document'
 * (doc / sheet) is indexed this期. Whiteboards (board) and html are EXCLUDED at
 * the producer so their body/acl events are never enqueued — the consumer would
 * skip html anyway, and board indexing is out of scope. Parse failures => not
 * indexed (best-effort gate, never throws).
 */
export function isSearchIndexedDoc(documentName: string): boolean {
  try {
    return parseDocumentName(documentName).kind === 'document'
  } catch {
    return false
  }
}

/**
 * Shape of one index signal, serialized as JSON into the stream's `payload`
 * field by enqueueDocIndex. The indexer reads obj.payload and JSON.parses it
 * back into this shape.
 */
export interface DocIndexSignal {
  /** Canonical collab key `octo:<space>:<folder>:<doc>`; consumer parses/reads by it. */
  documentName: string
  kind: DocIndexKind
  /**
   * Enqueue timestamp (ms), DIAGNOSTIC ONLY. This is the producing node's local
   * wall clock, so it skews across a fleet — do NOT use it as a correctness
   * ordering / staleness key (e.g. OpenSearch external version), or a newer write
   * carrying an older ts would be dropped as "stale". Derive ordering from the DB
   * (updated_at / permission_epoch) instead.
   */
  ts: number
}

/**
 * Push a change signal onto the index stream. Best-effort: never throws — a
 * Redis hiccup here must not fail the surrounding store. Returns true if the
 * XADD was accepted by Redis, false if it was swallowed.
 */
export async function enqueueDocIndex(
  documentName: string,
  kind: DocIndexKind = 'body',
): Promise<boolean> {
  const signal: DocIndexSignal = { documentName, kind, ts: Date.now() }
  try {
    const key = docIndexQueueKey()
    // XADD with an approximate MAXLEN trim (~) so the shared Redis can drop whole
    // macro-nodes cheaply and the stream can't grow unbounded when no consumer is
    // draining. The whole signal is JSON-serialized into a single `payload`
    // field; the indexer reads obj.payload and JSON.parses it. ts is DIAGNOSTIC
    // ONLY (see DocIndexSignal) — the indexer derives its OpenSearch version from
    // the DB, never from ts.
    await getRedis().xadd(
      key,
      'MAXLEN',
      '~',
      config.search.queueMax,
      '*',
      'payload',
      JSON.stringify(signal),
    )
    return true
  } catch (err) {
    // documentName is externally controlled (derived from client-supplied doc
    // keys), so it must NOT sit in the format-string position of console.warn —
    // Node treats the first arg as a util.format template, and a crafted key
    // containing %s/%d/%o would be interpreted as a format directive
    // (js/tainted-format-string). Keep the template a fixed literal and pass the
    // untrusted value as a separate argument.
    // eslint-disable-next-line no-console
    console.warn('[octo-docs] search index-queue enqueue failed for %s:', documentName, err)
    return false
  }
}
