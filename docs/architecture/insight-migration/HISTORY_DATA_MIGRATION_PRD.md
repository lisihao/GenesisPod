# Solar 洞察历史数据迁移 PRD

日期：2026-08-10

## 目标

把 Mac mini `solar-harness` 已采集的 GitHub 趋势、Hugging Face 论文、
YouTube 视频/字幕和大咖 X 帖子迁入 GenesisPod 原生 Radar 数据模型，避免
GenesisPod 首次使用时重新采集全部历史数据。

## 边界

- 源：`/Users/lisihao/.solar/harness/state/tech-hotspot-radar/tech-hotspot-radar.sqlite`。
- 目标：Mac mini 当前 GenesisPod PostgreSQL 的 `RadarTopic`、`RadarSource`、
  `RadarItem`。
- 源数据库只读；不恢复旧 `solar-harness` 定时任务。
- 不把 `solar-harness` 代码或运行依赖引入 GenesisPod。
- 不在本次迁移中自动启动 GenesisPod Radar 调度；新建主题保持 `PAUSED`。

## 迁移规模

| 数据集 | 目标记录 | 补充数据 |
| --- | ---: | --- |
| GitHub | 10,038 repos | 星标历史、分析卡、证据 atoms |
| Hugging Face | 7,861 papers | daily/trending 出现历史与排名快照 |
| YouTube | 3,090 videos | 2,078 份合格字幕、指标快照 |
| 大咖洞察 | 13,406 posts | 4,840 条观点分析、互动快照 |

目标合计 34,395 个 `RadarItem`。Hugging Face 旧库没有可迁移的 model 行，本次只
迁移 papers。

## 目标建模

建立 4 个迁移主题：GitHub 趋势、Hugging Face 论文、YouTube 洞察、大咖洞察。
GitHub/HF 各用一个原生 source；YouTube 按 51 个 channel 建 source；大咖洞察按
200 个 X handle 建 source。全部 source 绑定 GenesisPod 自身 collector 类型。

原生 external id 保持与现有 collector 一致：GitHub `owner/repo`、HF
`paper:<paper_id>`、YouTube `video_id`、X `post_id`。这样后续恢复采集时由
`(topicId, externalId)` 唯一约束自然去重。

## 验收标准

1. 源库一致性快照、SHA-256 和迁移前目标计数可追溯。
2. dry-run 精确给出 4 topic、253 source、34,395 item。
3. 生产导入后四个数据集计数不低于源端 canonical 计数。
4. YouTube 合格字幕进入 `content`；旧观点进入 `aiSummary` 和 `raw.legacy`。
5. 历史指标快照进入 `raw.legacy.metricHistory`。
6. 重跑不增加重复记录；回滚只删除带迁移 marker 的四个主题并级联清理。
7. 导入后主题保持 `PAUSED`，不会自动触发外部采集或 LLM 任务。
