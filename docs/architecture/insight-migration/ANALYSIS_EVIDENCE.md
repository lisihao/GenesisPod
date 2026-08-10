# 基线分析证据

采集时间：2026-08-10

## 仓库证据

| 对象          | 固定提交                                   | 状态                            |
| ------------- | ------------------------------------------ | ------------------------------- |
| GenesisPod    | `e572d2a7d8e1b7ca5500bcf8822284f9f59ba146` | fork 的 `origin/main`，干净基线 |
| solar-harness | `7a0dff00a8a08d4e87678069672803412bd2f367` | 只读迁移源，干净基线            |

迁移源中已定位到：

- Hugging Face：`harness/lib/hf_paper_insight/`，4 个直接命名测试文件；
- GitHub：`github_trends_pipeline.py`、`github_trends_digest.py`、`tech_hotspot_radar.py`，1 个直接命名趋势测试，另有 5 个 tech-hotspot 测试；
- YouTube：`youtube_influence_digest.py` 与 `ai_influence_youtube_report/`，至少 24 个直接命名测试；
- 综合洞察：`ai_influence_daily.py`、`ai_influence_unified_report.py` 和 influence schema。

这些路径在当前 GitHub 历史中主要落在 2026-06-13 的 baseline 提交，无法仅靠该 squash 历史可靠还原 2026-05-20 至 2026-07-20 每个未完成特性的演进顺序。因此 Phase 2 继续保持 `hold`，等清理后的可审计历史或明确的单项选择后再解锁。

## GenesisPod 原生能力证据

- `CollectorRouter` 已注册 `RSS`、`YOUTUBE`、`X`、`CUSTOM`，支持单来源错误隔离；
- `YoutubeCollector` 已通过频道 RSS 采集，并预留 transcript 配置；
- Prisma 已有 `RadarTopic.entityType`、`RadarSource`、`RadarItem`、briefing 与 insight 模型；
- `RadarContentSourceProvider` 只暴露通过相关性和质量筛选的 accepted items；
- `TopicInsightsContentSourceProvider` 已把报告暴露为通用 ContentSource；
- 全局 JWT 是当前产品安全契约，仓库未发现受支持的 auth-disable 配置。

## Mac mini 冲突检查

检查时旧服务占用 3000、3001、5050，其中 backend/AI service 来自旧 vendor 副本。新的 GenesisPod canonical service root 尚未建立；规划端口 13300、14000、15000 均空闲。

结论：新部署必须使用独立 root 和端口，先并行验证再决定旧服务退役，不能就地覆盖。
