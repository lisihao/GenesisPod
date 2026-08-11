# 四类洞察模块一级导航契约

## 必须满足

- 导航 SSOT 仍为 `frontend/lib/constants/nav-config.ts`。
- 四个条目必须是可见的一级 `NavItem`，不得放进 AI Radar 页面内的 Tab 或卡片。
- 独立页面只通过 `frontend/services/ai-radar` 读取 GenesisPod 数据。
- topic 解析必须使用受控模块配置和精确名称/marker 匹配，不得把模糊搜索第一条直接当结果。
- 页面必须有 loading、empty、error 和正常数据四种状态。
- 外链必须使用 `noopener noreferrer`。
- 不修改或暂存用户现有 `package-lock.json` 变更。

## 不允许

- 不硬编码 Mac mini 的 topic UUID、用户 UUID、数据库连接或 token。
- 不恢复 `solar-harness` 采集服务或定时任务。
- 不把四个入口重定向回 `/ai-radar/topic/:id`。
- 不删除 AI Radar 普通主题能力。

## 停止条件

- 当前分支或目标仓库不是 `lisihao/GenesisPod`。
- 四个生产 topic 无法通过受控配置解析，且需要改变数据模型才能修复。
- 构建失败揭示与本次变更相关的类型或路由错误。

## 回滚

回滚本次前端提交并重新部署上一 GenesisPod release。数据迁移主题和 34,395 条历史
数据不受导航回滚影响。
