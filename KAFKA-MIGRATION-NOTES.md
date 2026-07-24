# Kafka 迁移说明（doc-index 管道，方案 A）—— octo-docs-backend（生产者侧）

把文档索引信号管道从 **Redis Stream** 迁移到 **Kafka**。本仓库是**生产者**：collab 的
`afterStoreDocument` 钩子在文档持久化后发一个 `{documentName,kind,ts}` 信号，供独立的
`octo-doc-indexer` 消费后写入 OpenSearch。

交付语义不变：best-effort 侧信道 + 消费端 at-least-once + OpenSearch external-version 幂等。
**发送失败绝不影响主文档写入**（保留原 try/catch 语义）。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/db/kafka.ts` | **新增**。kafkajs producer 懒加载单例（镜像 `db/redis.ts` 的 `getRedis()` 风格）：`getKafkaProducer()` 首次调用时构造 + connect，并发调用共享同一个 in-flight connect；connect 失败清空缓存以便下次重试。用 Java 兼容的 `DefaultPartitioner`，使按 key 分区一致。另有 `closeKafkaProducer()`。 |
| `src/search/docIndexQueue.ts` | `enqueueDocIndex` 把 `getRedis().xadd(...)` 换成 `producer.send({ topic, acks, messages:[{ key, value }] })`。**key = documentName**（同文档进同 partition 有序），value = 原 `{documentName,kind,ts}` JSON。删掉 MAXLEN 逻辑（Kafka 靠 topic retention）。保留 best-effort：`send` 失败只 `console.warn` + 返回 `false`。`docIndexQueueKey()` → `docIndexTopic()`（返回 `config.kafka.topic`）。签名、`isSearchIndexedDoc`/`DocIndexKind`/`DocIndexSignal` 均不变。 |
| `src/config/env.ts` | `search` 段删除 `indexStreamKey`（`SEARCH_INDEX_STREAM_KEY`）和 `queueMax`（`SEARCH_INDEX_QUEUE_MAX`），保留 `indexEnabled`（`SEARCH_INDEX_ENABLED`，仍是灰度开关）。新增 `kafka` 段：`brokers`（`KAFKA_BROKERS`，逗号分隔，默认 `127.0.0.1:9092`）、`topic`（`DOCINDEX_KAFKA_TOPIC`，默认 `octo.docindex.v1`）、`acks`（`KAFKA_ACKS`，默认 `1`）。 |
| `test/docIndexQueue.test.ts` | 由 mock Redis `xadd` 改为 mock `../src/db/kafka.js` 的 `getKafkaProducer`，断言 topic / key=documentName / JSON value / acks / 失败返回 false 且不抛。 |
| `package.json` / `package-lock.json` | `npm install kafkajs`（2.2.4）。 |

**未改动**：`ioredis` 依赖**保留**——Redis 在本仓库仍用于 pub/sub、permission_epoch 缓存、连接注册表等（`getRedis`/`closeRedis` 不动），只从 doc-index 生产者移除了 stream 用法。`posIntMin`（含其独立单测）保留。

## 环境变量对照

| 旧（Redis stream） | 新（Kafka） |
|---|---|
| `SEARCH_INDEX_STREAM_KEY` | `DOCINDEX_KAFKA_TOPIC`（默认 `octo.docindex.v1`） |
| `SEARCH_INDEX_QUEUE_MAX` | 删除（Kafka retention 由运维配置） |
| — | 新增 `KAFKA_BROKERS`、`KAFKA_ACKS` |
| `SEARCH_INDEX_ENABLED` | 不变（灰度开关） |

## 验收结果

- `npm run typecheck`：**EXIT 0**
- `npm run lint`（eslint）：**EXIT 0**
- `npm run test`（vitest）：**1478 passed / 3 skipped**（120 文件全过），含改造后的 `docIndexQueue.test.ts`

## 还没做（本任务边界之外）

- **不创建 Kafka topic**：`octo.docindex.v1` / `.retry` / `.dlq` 由运维侧创建（分区数、retention 等）。
- **未部署**、未跑 docker / VM。
- **未 git commit / push**。
- 生产环境需配置 `KAFKA_BROKERS`（默认 `127.0.0.1:9092` 仅本地）；`DOCINDEX_KAFKA_TOPIC` 必须与 indexer 侧一致。
- 未删除 `ioredis`（Redis 仍被其他子系统使用）。
