# 洞察迁移项目架构

## 架构选择

采用 GenesisPod 现有的模块化单体与 adapter 扩展方式，不增加独立微服务或平行洞察平台。

### 领域层次

```text
frontend
  ai-radar / ai-insights
       │
open-api
  Radar API / Insight API
       │
ai-app
  radar ── ContentSource ── insight
       │
ai-engine
  content fetch / LLM / evidence
       │
platform
  PostgreSQL / Redis / credentials / scheduler
```

### 新增与复用

| 能力                 | 决策                              | 目标位置                                               |
| -------------------- | --------------------------------- | ------------------------------------------------------ |
| YouTube 采集         | 复用并扩展                        | `ai-app/radar/.../youtube-collector.service.ts`        |
| GitHub 趋势          | 新增 `GITHUB` typed adapter       | `ai-app/radar/.../collectors/`                         |
| Hugging Face         | 新增 `HUGGING_FACE` typed adapter | `ai-app/radar/.../collectors/`                         |
| 论文/模型 enrichment | 提炼纯函数与 provider             | `ai-engine/content/fetch/` 或 Radar collector 内部端口 |
| 大咖洞察             | 人物主题 + 多信源绑定             | `RadarTopic(entityType=person)`                        |
| 综合报告             | 复用 Topic Insights               | `ai-app/insight/`                                      |
| 每日/每周摘要        | 复用 Radar briefing               | `ai-app/radar/`                                        |

## 关键契约

### Collector contract

所有新增 collector 实现现有 `ICollector`，输出 `RawCollectedItem`。单来源失败必须通过 `CollectorRouter` 返回真实错误，不能返回伪造成功数据。

### Evidence contract

迁移后的每个报告结论至少关联：

- `RadarItem.id`；
- 原始 URL 与外部对象 ID；
- 抓取时间和来源类型；
- 模型输出或可重放的确定性转换结果；
- 评分和淘汰原因（适用时）。

### Storage contract

采集状态进入 PostgreSQL/Redis 与 GenesisPod 现有模型；不得运行第二套 solar-harness SQLite。原始 payload 仅按现有 `RadarItem.raw` 治理规则保存。

### Deployment contract

每次 Mac mini 部署必须固定到完整 Git SHA，保留 `current`/`previous`、健康检查与一次可重放回滚记录。GenesisPod 部署不得复用 AI4Research 的 release root 或 launchd label。

## 实施顺序

1. M0：固定源/目标 SHA，建立 fixture 和字段映射；
2. M1：GitHub typed source、collector、DTO/Prisma migration、测试；
3. M2：Hugging Face typed source、collector、enrichment、测试；
4. M3：扩展 YouTube transcript/evidence，保持现有 RSS 路径；
5. M4：人物主题配置与跨来源洞察模板；
6. M5：统一报告、briefing、前端筛选；
7. M6：Mac mini 独立部署、自动会话、隧道、监控和回滚。

每个节点单独提交、单独验收；后一个节点不得用尚未验收的前一个节点作为默认成功前提。
