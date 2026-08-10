# ADR-001：使用原生 Radar/Insight 管线承载迁移能力

- 状态：Accepted
- 日期：2026-08-10

## 背景

solar-harness 中存在 GitHub、Hugging Face、YouTube 和 AI influence 的采集、评分、报告与本地调度实现。GenesisPod 已有 Radar 多源采集、`RadarItem` 评分、`RadarContentSourceProvider` 和 Topic Insights 报告链。

## 决策

1. GitHub 和 Hugging Face 增加显式 `RadarSourceType`，而不是长期塞进 `CUSTOM`。这会增加一次 Prisma migration 和 DTO/UI 变更，但保留类型校验、健康状态、筛选和可观测性。
2. YouTube 只扩展现有 `YoutubeCollector`；不引入 solar-harness 的第二套调度和数据库。
3. 大咖洞察由人物 RadarTopic 聚合多平台 source，再交给 Topic Insights；不新增“大咖 collector”。
4. 只移植与来源无关的纯转换、评分和 evidence 规则；所有路径、存储和调度使用 GenesisPod 原生设施。

## 后果

- 优点：模块边界清楚，复用现有前端、权限、调度、报告和测试；Mac mini 只运行一套 GenesisPod 状态。
- 代价：不能直接复制脚本，需要逐项建立字段映射、fixture 和数据库迁移。
- 风险控制：任何“洞察成功”必须有来源与 evidence；不可用时显示 `warn/error`，不能生成替代性伪结论。
