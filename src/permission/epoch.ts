/**
 * permission_epoch read / bump (§4.5).
 *
 * Authoritative value lives in DB (doc_meta.permission_epoch). Redis is a read
 * cache only — on miss we fall back to DB (P2-E: Redis must never be the only
 * store, or a Redis restart would silently "restore" revoked permissions).
 *
 * currentEpoch hot path: Redis hit returns immediately. Redis miss -> DB
 * fallback is coalesced per {doc} via singleflight + a process-local short-TTL
 * cache, to prevent an epoch-read stampede when Redis is down/flushed (§4.1).
 *
 * Any change to doc_member (add/remove/role change/owner transfer/invite
 * accepted) bumps the doc's epoch +1 and broadcasts an invalidation event.
 */
import { docMetaRepo } from '../db/repos/docMetaRepo.js'
import { getRedis, rkey } from '../db/redis.js'
import { Singleflight, TtlCache } from '../util/singleflight.js'

const REDIS_EPOCH_TTL_SECONDS = 30
const LOCAL_TTL_MS = 2_000

const sf = new Singleflight<number>()
const localCache = new TtlCache<number>(LOCAL_TTL_MS)

function epochKey(documentName: string): string {
  return rkey('epoch', documentName)
}

/** Redis pub/sub channel for permission invalidation events (§4.5 step 3). */
export function epochInvalidateChannel(): string {
  return rkey('epoch-invalidate')
}

export interface InvalidateEvent {
  documentName: string
  uid?: string // when known, nodes target this {doc, uid} connection precisely
}

/**
 * currentEpoch(documentName) — §4.1 step 3.
 * Throws if the authoritative source cannot be confirmed (fail-closed: caller
 * maps the throw to 4401). Throws NotFound-style error if the doc is unknown.
 */
export async function currentEpoch(documentName: string): Promise<number> {
  const local = localCache.get(documentName)
  if (local !== undefined) return local

  // Redis cache first.
  const redis = getRedis()
  const cached = await redis.get(epochKey(documentName))
  if (cached !== null) {
    const n = Number(cached)
    if (!Number.isNaN(n)) {
      localCache.set(documentName, n)
      return n
    }
  }

  // Miss -> DB fallback, coalesced per {doc}.
  return sf.do(documentName, async () => {
    const epoch = await docMetaRepo.getEpochByDocumentName(documentName)
    if (epoch === null) {
      // Doc does not exist: cannot confirm authoritative epoch => fail-closed.
      throw new Error(`epoch: document not found: ${documentName}`)
    }
    // Best-effort warm the cache; failure here must not block.
    try {
      await redis.set(epochKey(documentName), String(epoch), 'EX', REDIS_EPOCH_TTL_SECONDS)
    } catch {
      /* cache warm best-effort */
    }
    localCache.set(documentName, epoch)
    return epoch
  })
}

/**
 * Bump a document's epoch in DB (authoritative), refresh caches and broadcast
 * an invalidation event (§4.5). Call this inside member/invite mutations.
 *
 * If a transaction already performed the DB +1 (e.g. invite accept), pass the
 * known new epoch and documentName via `publishInvalidation` instead.
 */
export async function bumpEpoch(docId: string, documentName: string, uid?: string): Promise<number> {
  const newEpoch = await docMetaRepo.bumpEpoch(docId)
  await refreshAndPublish(documentName, newEpoch, uid)
  return newEpoch
}

/** Update caches to the known new epoch and publish the invalidation event. */
export async function refreshAndPublish(
  documentName: string,
  newEpoch: number,
  uid?: string,
): Promise<void> {
  const redis = getRedis()
  try {
    await redis.set(epochKey(documentName), String(newEpoch), 'EX', REDIS_EPOCH_TTL_SECONDS)
  } catch {
    /* best-effort */
  }
  localCache.set(documentName, newEpoch)
  const event: InvalidateEvent = uid ? { documentName, uid } : { documentName }
  try {
    await redis.publish(epochInvalidateChannel(), JSON.stringify(event))
  } catch {
    /* broadcast best-effort; beforeHandleMessage recheck is the backstop */
  }
}

/** Invalidate local + Redis cache for a doc (called on receiving an event). */
export async function invalidateEpochCache(documentName: string): Promise<void> {
  localCache.delete(documentName)
  try {
    await getRedis().del(epochKey(documentName))
  } catch {
    /* best-effort */
  }
}
