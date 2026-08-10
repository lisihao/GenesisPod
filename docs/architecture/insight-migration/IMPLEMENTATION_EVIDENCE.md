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

## Mac mini 切换验收

- 固定运行 SHA：`bd6bf6ba5c0ab8a3e645d737aa91c662f497b153`；`previous` 为
  `41a36637f1abcf106cfe7e0913a23369a7c9c303`。
- 独立根目录：`/Users/lisihao/Services/GenesisPod`；backend、frontend、
  ai-service 的实际 cwd 均位于固定 SHA release，活动 launchd 配置不含 Solar 路径。
- Mac mini loopback health 与 MacBook tunnel health：frontend、backend、AI
  均为 HTTP 200；MacBook 端口为 13300、13301、15050。
- GitHub、Hugging Face、YouTube 生产构建真实采集分别返回 5、5、3 条，并带原生
  provider evidence；架构门禁确认无 solar-harness runtime 引用。
- 单用户免密：loopback frontend proxy 可创建 ADMIN JWT 会话；Tailscale 直连后端
  返回 403；全新 Chrome profile 无输入获得 access/refresh token，且未显示密码框。
- 回滚：三个服务从 `bd6bf6ba5` 切到 `41a36637f` 后健康，再切回
  `bd6bf6ba5` 后健康且免密会话恢复。
- 旧任务：13 个 GitHub/HF/YouTube/大咖相关 launchd label 均为 disabled 且未加载；
  12 份 plist（含遗留 GenesisPod watchdog）可恢复归档在
  `/Users/lisihao/Services/GenesisPod/evidence/deployments/20260810T225000Z-solar-insight-launchagents-disabled`。
