# Phase 1 原生洞察实现证据

日期：2026-08-10

## 已实现

- `GITHUB` typed source：GitHub repository search / exact repository adapter，输出标准 `RawCollectedItem`、平台指标和原始证据链接。
- `HUGGING_FACE` typed source：Models trending 与 Daily Papers adapter，输出 canonical external id、模型/论文指标和项目证据链接。
- YouTube：扩展现有 `YoutubeCollector`，复用 GenesisPod `ContentFetchService` 获取字幕；空字幕、provider error 文本和过短字幕不能进入正文。
- 大咖洞察：继续使用 `RadarTopic(entityType=person)` 与多 source 绑定；S7 人物模板要求每个信号引用真实 `RadarItem.id`，无证据信号会被过滤。
- Runtime independence：目标后端与前端目录由 architecture test 守门，不允许出现 solar-harness import、调用或绝对运行路径。

## 验证

```text
backend type-check                         PASS
backend radar tests                       283/283 PASS
new contract and architecture tests       42/42 PASS
frontend type-check                       PASS
frontend Radar/person flow tests          62/62 PASS
backend production build                  PASS
frontend direct Next production build     PASS
Prisma schema validate                    PASS
GitHub/HF live provider smoke              PASS
```

标准 frontend `npm run build` 的 changelog 前置脚本依赖工作区中未跟踪的
`frontend/lib/generated/CHANGELOG.md`，因此在进入 Next 编译前失败；直接运行
`next build` 已完成生产编译、类型检查和 108 个静态页面生成。

## 切换约束

在 Mac mini 的 GenesisPod 固定 SHA 部署、数据库 migration、健康检查和真实 Radar
运行完成前，不停止旧 solar-harness 定时任务。验收通过后，按精确 label 执行
`bootout + disable + 可恢复归档`，保留旧代码和历史数据但不再定时运行。
