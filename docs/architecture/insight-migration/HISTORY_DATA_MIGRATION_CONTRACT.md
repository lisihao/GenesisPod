# Solar 洞察历史数据迁移契约

迁移 marker：`solar-harness-insight-history-v1`

## 写入约束

- 只允许向 marker 对应的 GenesisPod Radar topic/source/item 写入。
- owner 必须是 Mac mini 当前实际登录的 active ADMIN 用户。
- topic 必须创建为 `PAUSED`、`nextDueAt=null`。
- 使用 `createMany(skipDuplicates=true)`；禁止覆盖用户已有 Radar item。
- 每批最多 100 条，单批失败必须整体失败并可安全重跑。
- 所有时间戳必须标准化；无法恢复的记录不得伪造时间，必须计入 skipped。
- 不打印数据库连接串、token、邮箱或其他 secret。

## 数据契约

- `RadarItem.externalId` 使用目标 collector 的原生 id。
- `contentHash` 使用 GenesisPod 的 title/content 归一化 SHA-256 规则。
- `raw.migration.marker` 必须存在。
- 旧库分析产物不得伪装成 GenesisPod 新生成结论；标记
  `raw.migration.source=solar-harness`。
- GitHub 分析卡和大咖观点可写入 `aiSummary`，同时保留原始结构化内容。
- transcript 只有通过旧库状态和最小字符门禁后才能进入 `content`。

## 停止条件

- 源 SQLite `quick_check` 失败。
- 目标 owner 不存在、不活跃或不是 ADMIN。
- 迁移前发现同 marker topic 的 owner 不一致。
- dry-run canonical 数量偏离本 PRD 且无法解释。
- 磁盘空间不足以建立一致性快照和证据目录。

## 回滚

回滚只允许在显式提供完整 marker 时执行，删除当前 owner 下 description 含 marker
的主题；由数据库外键级联删除其 source/item/insight/run。源 SQLite 快照始终保留。
