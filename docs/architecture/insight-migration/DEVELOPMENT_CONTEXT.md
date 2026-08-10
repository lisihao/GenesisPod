# GenesisPod 洞察迁移开发语境

- 状态：Active
- 基线日期：2026-08-10
- GenesisPod 基线：`e572d2a7d8e1b7ca5500bcf8822284f9f59ba146`
- 迁移源基线：`solar-harness@7a0dff00a8a08d4e87678069672803412bd2f367`

## 1. 项目边界

- GenesisPod 是独立产品和独立 Git 仓库，不是 AI4Research 的前端、子项目或部署壳。
- AI4Research 的 Solar 主干是另一个仓库的 `openJiuwen-Solar` 分支；本仓库不跟踪、镜像或内嵌它。
- `solar-harness` 只作为特性迁移源。迁移必须按固定提交审计，不能把其运行目录、个人路径、数据库、LaunchAgent 或旧 UI 原样复制进来。
- MacBook 是开发与控制端；Mac mini 是 GenesisPod 的目标运行机。GenesisPod 与 AI4Research 使用独立 release root、服务、端口、日志、状态和回滚链。

## 2. 当前任务

第一阶段只迁移已经推送到 GitHub、可以从固定提交复现的洞察能力：

1. GitHub 趋势与项目洞察；
2. Hugging Face 论文、模型与趋势洞察；
3. YouTube 大咖/频道洞察；
4. 跨 GitHub、Hugging Face、YouTube 的“大咖洞察”与综合报告。

迁移粒度是“能力契约”，不是文件搬运。每项能力必须依次通过：源证据定位、目标接口设计、fixture/contract test、实现、MacBook 门禁、Mac mini 固定提交部署、健康检查和回滚证明。

## 3. 原生落点

GenesisPod 已有 Radar、通用 ContentSource 和 Topic Insights，因此迁移统一进入现有主链：

```text
外部来源
  ├─ YouTube（扩展既有 collector）
  ├─ GitHub（新增 typed collector）
  └─ Hugging Face（新增 typed collector）
          ↓
RadarSource → CollectorRouter → RadarItem → 相关性/质量门禁
          ↓
RadarContentSourceProvider
          ↓
Topic Insights / 报告 / 每日与每周 briefing
```

“大咖”不是新的 collector 类型。它是 `RadarTopic.entityType = person` 的人物主题，绑定多个平台信源，并使用人物洞察模板生成带证据的报告。

## 4. 不迁移的内容

- solar-harness 的绝对个人路径、`~/.solar` 目录布局和本地 SQLite 状态；
- launchd 定时器、shell 编排、tmux 面板和旧 status server；
- 与 GenesisPod 已有 YouTube、Radar、Insight 重复的采集/展示管线；
- 无 evidence id、来源制品或模型输出支撑的推断性结论；
- 未完成特性的隐式补齐或确定性“替代分析”。

## 5. 运行边界

目标部署仅绑定 Mac mini loopback，由 MacBook 通过 SSH tunnel 访问。规划端口如下，最终以部署验收时的冲突检查为准：

| 服务                  | Mac mini          | MacBook           | 说明                 |
| --------------------- | ----------------- | ----------------- | -------------------- |
| GenesisPod frontend   | `127.0.0.1:13300` | `127.0.0.1:13300` | 独立于现有 3000/3300 |
| GenesisPod backend    | `127.0.0.1:14000` | `127.0.0.1:14000` | REST/WebSocket       |
| GenesisPod AI service | `127.0.0.1:15000` | `127.0.0.1:15000` | FastAPI              |

产品当前使用全局 JWT，仓库没有受支持的 `DISABLE_AUTH` 开关。“不输入用户名密码”的目标不能通过删除鉴权实现；后续部署节点将设计 loopback-only 的单用户自动会话，并用负向测试证明局域网没有直接暴露。

## 6. 阶段门禁

- Phase 1：只处理 `phase1-feature-routing.json` 中状态为 `ready_for_contract` 的条目。
- Phase 2：solar-harness 2026-05-20 至 2026-07-20 的未完成特性保持 `hold`；逐项由用户选择后，才能进入实现。
- 未经单独授权，不向 AI4Research 上游推送；GenesisPod 也只在本 fork 的 `codex/*` 分支开发。
