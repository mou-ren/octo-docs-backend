/**
 * Full-text search index queue — PRODUCER side only.
 *
 * When a document's authoritative state is persisted (collab afterStoreDocument,
 * §3.3a of the search design), we enqueue a tiny "this doc changed" signal so a
 * separate indexer can later re-read the latest body and upsert it into
 * OpenSearch. The queue deliberately carries ONLY the documentName (no body,
 * no ACL) — the consumer re-reads authoritative data by key, which keeps the
 * message small. Coalescing is a CONSUMER behavior (pop the latest signal for a
 * doc, read once): the LIST itself does not dedupe, so a burst of edits appends
 * one entry each.
 *
 * Transport: a plain Redis LIST over the shared ioredis client (LPUSH here at the
 * head; the consumer BRPOPs from the tail => FIFO). No new infrastructure, no
 * BullMQ. The consumer / indexer / OpenSearch wiring is intentionally out of
 * scope for this module.
 *
 * Bounded: because the LIST lives on the SHARED Redis (also backing epoch cache,
 * pub/sub and the connection registry), an absent/lagging consumer must not grow
 * it without limit and OOM the shared instance. Each push therefore LTRIMs to the
 * newest `config.search.queueMax` entries. This is a safety valve, not a
 * guarantee: under sustained overflow the OLDEST signals are dropped. Rollout
 * contract: deploy the consumer BEFORE flipping SEARCH_INDEX_ENABLED on.
 *
 * This is a best-effort side channel: a push failure must NEVER disturb the
 * collab store path, so callers fire-and-forget and every error is swallowed
 * after logging.
 */
import { getRedis, rkey } from '../db/redis.js'
import { parseDocumentName } from '../permission/documentName.js'
import { config } from '../config/env.js'

/** Redis LIST key holding pending index signals. Consumer BRPOPs the tail. */
export function docIndexQueueKey(): string {
  return rkey('search', 'body-queue')
}

/**
 * Kind of change that triggered the signal:
 *  - 'body' — content changed; consumer re-reads the body and re-indexes it.
 *  - 'acl'  — permission changed (owner/member/share/status); consumer re-reads
 *    the ACL fields and partial-updates them WITHOUT touching the body.
 */
export type DocIndexKind = 'body' | 'acl'

/**
 * Whether a documentName has a row in the search index (so an event about it is
 * worth enqueuing). 'document' (doc / sheet) and 'html' are indexed; whiteboards
 * carry no searchable text and are never indexed, so ACL/body events for them
 * are dropped. Parse failures => not indexed (best-effort gate, never throws).
 */
export function isSearchIndexedDoc(documentName: string): boolean {
  try {
    const kind = parseDocumentName(documentName).kind
    return kind === 'document' || kind === 'html'
  } catch {
    return false
  }
}

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
 * Push a change signal onto the index queue. Best-effort: never throws — a Redis
 * hiccup here must not fail the surrounding store. Returns true if the push was
 * accepted by Redis, false if it was swallowed.
 */
export async function enqueueDocIndex(
  documentName: string,
  kind: DocIndexKind = 'body',
): Promise<boolean> {
  const signal: DocIndexSignal = { documentName, kind, ts: Date.now() }
  try {
    const key = docIndexQueueKey()
    // LPUSH then LTRIM to the newest queueMax in one round-trip: the LTRIM caps
    // growth on the shared Redis when no consumer is draining (0 .. max-1 keeps
    // the head, dropping the oldest tail entries under overflow).
    await getRedis()
      .multi()
      .lpush(key, JSON.stringify(signal))
      .ltrim(key, 0, config.search.queueMax - 1)
      .exec()
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
