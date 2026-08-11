# Solar 洞察历史数据迁移验收证据

日期：2026-08-11

迁移 marker：`solar-harness-insight-history-v1`

## 结论

Mac mini `solar-harness` 的 GitHub 趋势、Hugging Face 论文、YouTube 和大咖洞察
历史数据已经迁入 GenesisPod 原生 Radar 表。目标侧共有 4 个暂停主题、253 个
原生来源和 34,395 个已接受条目。迁移主题没有产生 Radar run 或 insight，旧采集
调度没有恢复。

## 源快照

- 活跃源库只读路径：
  `/Users/lisihao/.solar/harness/state/tech-hotspot-radar/tech-hotspot-radar.sqlite`
- 一致性快照：
  `/Users/lisihao/Services/GenesisPod/evidence/migrations/solar-harness-insight-history-v1/20260811T010915Z/source/tech-hotspot-radar.sqlite`
- SHA-256：
  `14476e03f3d1846aeea21c19eaceaef3bb62702eadbf6c76ceac034b02f6ac8a`
- SQLite `quick_check`：`ok`
- dry-run：34,395/34,395 可映射，0 skipped，0 writes。

dry-run 报告：
`/Users/lisihao/Services/GenesisPod/evidence/migrations/solar-harness-insight-history-v1/20260811T010915Z/dry-run-snapshot/dry-run-result.json`

## 目标计数

| 数据集 | Topic | Source | Item | 证据保留 | 状态 |
| --- | ---: | ---: | ---: | --- | --- |
| GitHub 趋势 | 1 | 1 | 10,038 | 星标历史、分析卡、证据 atoms | PAUSED |
| Hugging Face | 1 | 1 | 7,861 | papers daily/trending 历史 | PAUSED |
| YouTube | 1 | 51 | 3,090 | 2,078 份门禁合格字幕、指标快照 | PAUSED |
| 大咖洞察 | 1 | 200 | 13,406 | 4,840 条观点摘要、互动快照 | PAUSED |
| 合计 | 4 | 253 | 34,395 | N/A | PAUSED |

所有 34,395 个条目均为 `accepted=true`。所有样本均带
`raw.migration.marker=solar-harness-insight-history-v1`，旧分析产物保留
`raw.migration.source=solar-harness`，没有伪装成 GenesisPod 新生成结论。

生产结果：
`/Users/lisihao/Services/GenesisPod/evidence/migrations/solar-harness-insight-history-v1/20260811T010915Z/import-resume/migration-result.json`

最终验证：
`/Users/lisihao/Services/GenesisPod/evidence/migrations/solar-harness-insight-history-v1/20260811T010915Z/verify-final/verification-result.json`

## 恢复与幂等性

首次生产写入在前三类完成后，旧社媒文本中的异常 UTF-16 转义被 Prisma/PostgreSQL
拒绝。迁移器随后在写入边界规范化 NUL 和孤立代理码，源 SQLite 未被修改；断点
续跑跳过已经完整写入的 GitHub、HF 和 YouTube，只继续写入 13,406 条大咖数据。

第二次完整执行四类数据全部显示 `resume-skip`，目标计数保持 34,395，没有重复
条目。幂等报告：
`/Users/lisihao/Services/GenesisPod/evidence/migrations/solar-harness-insight-history-v1/20260811T010915Z/idempotency-rerun/migration-result.json`

回滚仍要求显式参数
`--confirm-rollback solar-harness-insight-history-v1`，且只删除当前 owner 下带 marker
的四个迁移主题；本次没有执行回滚。

## 调度与运行健康

- 四个迁移主题均为 `PAUSED`、`nextDueAt=null`。
- 迁移主题 `RadarRun=0`、`RadarInsight=0`。
- Mac mini：frontend `:3000`、backend `:3001/health`、AI `:5050` 均返回 200。
- MacBook：SSH 隧道 `:13300`、`:13301/health`、`:15050` 均返回 200。
- `com.solar.github-trend-report-daily`、`com.solar.hf-paper-weekly-report`、
  `com.solar.tech-hotspot-radar` 及相关 YouTube/AI influence LaunchAgent 保持 disabled。
- 用户 crontab 没有相关任务；活跃源 SQLite 没有打开句柄。

## 审查说明

独立 `mini-claude-opus-evaluator` 已派发，但因其 OAuth access token 过期返回 HTTP
401，未生成审查结果，也未修改数据。协调器回退执行了只读契约审查、全量 dry-run、
生产后数量/证据验证、幂等重跑和服务健康验证。该认证问题不影响本次迁移结果。
