# 四类洞察模块一级导航验收证据

日期：2026-08-11

## 实现状态

| 验收项              | 状态 | 证据                                                                                    |
| ------------------- | ---- | --------------------------------------------------------------------------------------- |
| 四个一级导航条目    | ok   | `NAV_GROUPS` 的独立“洞察频道”分组                                                       |
| 四条独立路由        | ok   | `/insights/github`、`/insights/hugging-face`、`/insights/youtube`、`/insights/creators` |
| 独立页面架构        | ok   | `InsightModulePage`，不导入或嵌入 AI Radar 页面组件                                     |
| GenesisPod 原生数据 | ok   | 只调用 `frontend/services/ai-radar`；topic UUID 动态解析                                |
| 原 Radar 去重入口   | ok   | 专用迁移 topic 从 `/ai-radar` 首页过滤                                                  |
| Desktop/Mobile 同步 | ok   | Sidebar 与 MobileNav 共同读取 `nav-config.ts`                                           |

## 本地验证

```text
targeted frontend ESLint             PASS (0 warnings)
frontend TypeScript                  PASS
navigation/page Vitest               7/7 PASS
native runtime architecture Jest     1/1 PASS
direct Next production build         PASS
generated routes                     112/112
new /insights routes                 4/4 present
git diff --check                      PASS
```

Vitest 和 Next 在 MacBook 上缺少 npm optional native packages；验证时只在 `mktemp`
目录安装对应架构二进制并通过 `NODE_PATH` 注入，没有修改仓库 `node_modules` 或
`package-lock.json`。Next 构建期间既有 Slides Themes 静态预取因本地服务未启动输出
`ECONNREFUSED`，但构建、类型检查和 112 个页面生成均成功。浏览器验收发现独立页面
最初会早于本机单用户认证完成发起数据请求；已在 `fcf847cd8` 中让页面等待
`AuthContext` 初始化，并增加回归测试。

## 部署证据

```text
branch                            codex/insight-migration-baseline
deployed SHA                       fcf847cd89dfe2d65b30bc1e44bf32ae95f2e2f6
Mac mini current                   releases/fcf847cd89dfe2d65b30bc1e44bf32ae95f2e2f6
Mac mini previous                  releases/9c3d0e4fc9cf73963522d7e8694508569b7c2556
frontend / backend / AI            200 / 200 / 200
MacBook tunnels                    13300 / 13301 / 15050 = 200 / 200 / 200
independent insight routes         4/4 = 200 on Mac mini and MacBook
local single-user session          ok (no username/password input)
browser navigation activation      4/4 PASS
AI Radar historical topic removal  4/4 absent from main content
```

真实浏览器从 MacBook 隧道逐项点击左侧导航，并确认独立页面及历史总数：

| 模块         | 路由                     | 历史条目 | 浏览器状态 |
| ------------ | ------------------------ | -------- | ---------- |
| GitHub 趋势  | `/insights/github`       | 10,038   | ok         |
| Hugging Face | `/insights/hugging-face` | 7,893    | ok         |
| YouTube 洞察 | `/insights/youtube`      | 3,090    | ok         |
| 大咖洞察     | `/insights/creators`     | 13,488   | ok         |

历史源库在第一次验收后发现停用前尾差 114 条（Hugging Face 32、大咖洞察 82）。
已用幂等迁移补齐，最终 `verification-result.json` 为 `ok: true`：4 个主题、253 个
来源、34,509 个已入选条目；YouTube 字幕 2,078、大咖 AI 摘要 4,887；迁移主题均为
`PAUSED` 且 `nextDueAt=null`，目标调度 run/insight 均为 0。

Mac mini 上未发现旧 GitHub/HF/YouTube/大咖采集进程、launchd、tmux 或 crontab
任务。验证报告位于：

```text
/Users/lisihao/Services/GenesisPod/shared/migrations/reports/verification-result.json
```

非阻塞观察：生产浏览器控制台仍有 GenesisPod 既有 SSR 英文、客户端中文切换导致的
React hydration `#418/#423` 警告；四条页面的导航、认证、数据加载和交互验收均通过。
