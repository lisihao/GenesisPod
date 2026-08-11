# 四类洞察模块一级导航 PRD

日期：2026-08-11

## 目标

把 GitHub 趋势、Hugging Face、YouTube 洞察和大咖洞察从 AI Radar 的通用主题
页面中拆出，成为 GenesisPod 左侧导航的四个独立一级入口。每个入口拥有独立路由、
页面标题、数据列表和状态摘要。

## 信息架构

| 模块         | 一级路由                 | 数据主题                          |
| ------------ | ------------------------ | --------------------------------- |
| GitHub 趋势  | `/insights/github`       | `GitHub 趋势（Solar 历史）`       |
| Hugging Face | `/insights/hugging-face` | `Hugging Face 论文（Solar 历史）` |
| YouTube 洞察 | `/insights/youtube`      | `YouTube 洞察（Solar 历史）`      |
| 大咖洞察     | `/insights/creators`     | `大咖洞察（Solar 历史）`          |

四个入口在桌面 Sidebar 和移动 MobileNav 中同源渲染。页面使用新的
`InsightModulePage` 壳，不跳转或嵌入 `/ai-radar` 页面。

## 技术边界

- 继续复用 GenesisPod 原生 Radar API 和 PostgreSQL 数据，不建立第二套服务或存储。
- 不引用 `solar-harness` 运行时代码、HTTP 服务或 SQLite。
- 不硬编码生产 topic UUID；按模块契约解析当前用户对应的迁移主题。
- 原 AI Radar 保留用于普通用户主题，但不再展示这四个专用迁移主题。
- 本次不自动恢复四个迁移主题的定时采集；状态仍由后端 topic 控制。

## 验收标准

1. 左侧导航出现四个可独立点击的条目，移动端同步。
2. 四个路由分别加载自己的 topic、source 数量和 item 数据。
3. 页面不依赖 `/ai-radar/topic/:id` 路由，也不嵌入原 Radar 页面组件。
4. AI Radar 首页不重复显示四个专用迁移主题。
5. 导航 active 状态不会被 `/insights` 下其他模块误命中。
6. 前端测试、类型检查和生产构建通过；Mac mini 部署后四条路由可从 MacBook 打开。
