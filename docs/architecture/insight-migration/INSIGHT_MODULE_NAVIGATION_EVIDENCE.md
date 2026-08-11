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
navigation/page Vitest               6/6 PASS
native runtime architecture Jest     1/1 PASS
direct Next production build         PASS
generated routes                     112/112
new /insights routes                 4/4 present
git diff --check                      PASS
```

Vitest 和 Next 在 MacBook 上缺少 npm optional native packages；验证时只在 `mktemp`
目录安装对应架构二进制并通过 `NODE_PATH` 注入，没有修改仓库 `node_modules` 或
`package-lock.json`。Next 构建期间既有 Slides Themes 静态预取因本地服务未启动输出
`ECONNREFUSED`，但构建、类型检查和 112 个页面生成均成功。

## 部署证据

部署 SHA、release 路径、current/previous 指针、Mac mini 健康检查和 MacBook 浏览器
验收在 N4/N5 完成后补录。
