/**
 * P4 端到端集成验证:真连 MySQL + 真连 OpenSearch,直接跑真实的
 * docMetaRepo.listVisibleDocIdSet(真 SQL 权限约束) + searchDocs(真 OS 查询/分页),
 * 覆盖多权限场景。只 seed 带 e2e_ 前缀的数据,结束后精确清理。
 *
 * 在 octo_octo-net 内用 tsx 跑,连 mysql / search-opensearch 别名。
 * 认证边界不测(单测已覆盖);这里测真实 DB 权限 SQL + OS ik 检索 + 分页链路。
 */
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { searchDocs, getOsClient } from '../src/search/osClient.js'
import { query } from '../src/db/pool.js'

const SP = 'e2e_space'
const SP2 = 'e2e_space2'
const USER = 'e2e_user'
const OTHER = 'e2e_other'
const KW = '销售报表'
const BODY = '本季度销售报表显示销售额显著增长'

// doc_id -> {场景, space, owner, share_scope, status, member?}
// osStatus 覆盖 OS 里写入的 status(默认=status);用于模拟 indexer 未同步的陈旧副本。
const DOCS = [
  { doc_id: 'e2e_own',       space: SP,  owner: USER,  share_scope: 0, status: 1, member: null, desc: 'owner私有' },
  { doc_id: 'e2e_mem',       space: SP,  owner: OTHER, share_scope: 0, status: 1, member: 1,    desc: 'doc_member授权reader' },
  { doc_id: 'e2e_share',     space: SP,  owner: OTHER, share_scope: 1, status: 1, member: null, desc: 'anyone_in_space共享' },
  { doc_id: 'e2e_none',      space: SP,  owner: OTHER, share_scope: 0, status: 1, member: null, desc: 'restricted无授权' },
  { doc_id: 'e2e_arch',      space: SP,  owner: USER,  share_scope: 0, status: 2, member: null, desc: 'owner但归档status=2' },
  { doc_id: 'e2e_os2',       space: SP2, owner: USER,  share_scope: 0, status: 1, member: null, desc: 'owner但别space' },
  // 软删泄漏回归:space-share 文档被软删(DB status=0),但 OS 里还留着陈旧的
  // status=1 副本(消费端丢弃 acl、从不回读 status)。新逻辑靠 MySQL 实时算可见集,
  // 这个 doc 不该进任何人的可见集 → 即使 OS stale 也搜不到。
  { doc_id: 'e2e_share_del', space: SP,  owner: OTHER, share_scope: 1, status: 0, member: null, osStatus: 1, desc: 'space-share已软删(OS陈旧status=1)' },
]

async function cleanup() {
  await query(`DELETE FROM doc_member WHERE doc_id LIKE 'e2e_%'`, [])
  await query(`DELETE FROM doc_meta WHERE doc_id LIKE 'e2e_%'`, [])
  const os = getOsClient()
  for (const d of DOCS) {
    try { await os.delete({ index: 'octo-doc', id: d.doc_id }) } catch { /* ignore 404 */ }
  }
}

async function seed() {
  for (const d of DOCS) {
    await query(
      `INSERT INTO doc_meta (doc_id, document_name, title, owner_id, space_id, folder_id, doc_type, status, permission_epoch, share_scope, share_role, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 'f_e2e', 'doc', ?, 0, ?, 1, ?, '')`,
      [d.doc_id, `octo:${d.space}:f_e2e:${d.doc_id}`, `${KW}-${d.doc_id}`, d.owner, d.space, d.status, d.share_scope, d.owner],
    )
    if (d.member) {
      await query(
        `INSERT INTO doc_member (doc_id, uid, role, granted_by, source) VALUES (?, ?, ?, ?, 1)`,
        [d.doc_id, USER, d.member, d.owner],
      )
    }
  }
  // 索引进 OS(只索引 status=1 的,模拟 indexer;归档 e2e_arch 也故意索引进去,验证 OS filter status=1 能挡)
  const os = getOsClient()
  for (const d of DOCS) {
    await os.index({
      index: 'octo-doc',
      id: d.doc_id,
      body: {
        doc_id: d.doc_id, space_id: d.space, doc_type: 'doc',
        status: (d as { osStatus?: number }).osStatus ?? d.status, share_scope: d.share_scope,
        title: `${KW}-${d.doc_id}`, body: BODY,
        updated_at: Date.now(), ver: 1,
      },
    })
  }
  await os.indices.refresh({ index: 'octo-doc' })
}

function eq(name: string, got: unknown, want: unknown): boolean {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  const ok = g === w
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  got=${g} want=${w}`)
  return ok
}

async function run() {
  console.log('=== cleanup + seed ===')
  await cleanup()
  await seed()
  let allPass = true

  // 场景1:caller 是空间成员 — 可见集已在 MySQL 实时折进 space-share
  console.log('\n=== 场景1:isSpaceMember=true(可见集含 share,不含软删) ===')
  const vids1 = await docMetaRepo.listVisibleDocIdSet({ uid: USER, spaceId: SP, isSpaceMember: true })
  allPass = eq('成员可见集(own+mem+share;不含 none/arch/other_space/软删)', vids1.sort(), ['e2e_mem', 'e2e_own', 'e2e_share']) && allPass
  const r1 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids1, from: 0, size: 50 })
  const ids1 = r1.items.map((i) => i.docId).sort()
  allPass = eq('成员搜索命中(own+mem+share)', ids1, ['e2e_mem', 'e2e_own', 'e2e_share']) && allPass
  allPass = eq('成员搜索 total', r1.total, 3) && allPass

  // 场景2:caller 非空间成员 — space-share 不进可见集(fail-closed)
  console.log('\n=== 场景2:isSpaceMember=false(share 被 MySQL 挡) ===')
  const vids2 = await docMetaRepo.listVisibleDocIdSet({ uid: USER, spaceId: SP, isSpaceMember: false })
  allPass = eq('非成员可见集(仅 own+mem,无 share)', vids2.sort(), ['e2e_mem', 'e2e_own']) && allPass
  const r2 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids2, from: 0, size: 50 })
  const ids2 = r2.items.map((i) => i.docId).sort()
  allPass = eq('非成员搜索命中(仅 own+mem)', ids2, ['e2e_mem', 'e2e_own']) && allPass
  allPass = eq('非成员搜索 total', r2.total, 2) && allPass

  // 场景2b(本轮核心):软删的 space-share 文档 — OS 里还有陈旧 status=1 副本,
  // 但 MySQL 可见集实时算(status=1 过滤)已将它排除 → 即使成员也搜不到。
  console.log('\n=== 场景2b:软删泄漏已关闭(OS stale 也搜不到) ===')
  allPass = eq('软删 doc 不在成员可见集', vids1.includes('e2e_share_del'), false) && allPass
  allPass = eq('搜索结果不含软删 doc', ids1.includes('e2e_share_del'), false) && allPass
  // 反面确认:OS 里确实还有那份 stale status=1 副本(证明不是因为没索引才搜不到)。
  const osStale = await getOsClient().get({ index: 'octo-doc', id: 'e2e_share_del' }).then(
    (r) => (r.body._source as { status: number }).status, () => -1,
  )
  allPass = eq('OS 里软删 doc 确实还是陈旧 status=1(靠 MySQL 挡住而非靠 OS)', osStale, 1) && allPass

  // 场景3:分页(成员,size=2 分两页)
  console.log('\n=== 场景3:OS 分页 size=2 ===')
  const p1 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids1, from: 0, size: 2 })
  const p2 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: vids1, from: 2, size: 2 })
  allPass = eq('page1 total=3(track_total_hits)', p1.total, 3) && allPass
  allPass = eq('page1 返回 2 条', p1.items.length, 2) && allPass
  allPass = eq('page2 返回 1 条', p2.items.length, 1) && allPass
  const pageIds = [...p1.items, ...p2.items].map((i) => i.docId).sort()
  allPass = eq('两页合并=全部3条无重无漏', pageIds, ['e2e_mem', 'e2e_own', 'e2e_share']) && allPass

  // 场景4:短路(空可见集 → 不打 OS)
  console.log('\n=== 场景4:短路(空可见集) ===')
  const r4 = await searchDocs({ spaceId: SP, query: KW, visibleDocIds: [], from: 0, size: 50 })
  allPass = eq('短路 total=0', r4.total, 0) && allPass
  allPass = eq('短路 items 空', r4.items, []) && allPass

  // 场景5:空间隔离(别 space 的 e2e_os2 即使 owner=caller 也不出现在 SP 搜索)
  console.log('\n=== 场景5:空间隔离 ===')
  const vidsSp2 = await docMetaRepo.listVisibleDocIdSet({ uid: USER, spaceId: SP, isSpaceMember: true })
  allPass = eq('SP 的可见集不含别 space 的 e2e_os2', vidsSp2.includes('e2e_os2'), false) && allPass

  // 场景6:ik 中文分词命中 body(用 body 里才有的词"增长",title 没有)
  console.log('\n=== 场景6:ik body 检索 ===')
  const r6 = await searchDocs({ spaceId: SP, query: '增长', visibleDocIds: vids1, from: 0, size: 50 })
  allPass = eq('ik 检索 body"增长"命中(证明 body 索引+ik 生效)', r6.items.length > 0, true) && allPass
  allPass = eq('高亮片段存在', typeof r6.items[0]?.highlight === 'string', true) && allPass

  // 场景7:docType 过滤
  console.log('\n=== 场景7:docType 过滤 ===')
  const rT = await searchDocs({ spaceId: SP, query: KW, docType: ['sheet'], visibleDocIds: vids1, from: 0, size: 50 })
  allPass = eq('docType=sheet 过滤后 0 命中(seed 全是 doc)', rT.items.length, 0) && allPass

  console.log('\n=== cleanup ===')
  await cleanup()

  console.log(`\n====== ${allPass ? 'ALL PASS ✅' : 'SOME FAIL ❌'} ======`)
  process.exit(allPass ? 0 : 1)
}

run().catch(async (e) => {
  console.error('ERROR', e)
  try { await cleanup() } catch { /* ignore */ }
  process.exit(2)
})
