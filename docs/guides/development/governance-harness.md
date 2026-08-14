# Code Harness 工程治理

GenesisPod 使用仓内可执行 Code Harness 判定项目规则、适用范围和质量门禁。AI 指令用于说明语境；真正的通过条件是脚本退出码和 GitHub Actions `ci-status`。

## 入口

| 命令                        | 用途                                                      |
| --------------------------- | --------------------------------------------------------- |
| `npm run governance:audit`  | 校验 Profile、bundle SHA、Hook 执行位、npm 入口和 CI 接线 |
| `npm run governance:plan`   | 根据全部改动状态生成 full gate 计划                       |
| `npm run governance:quick`  | 开发期快速门禁并生成 quick attestation                    |
| `npm run governance:verify` | 完整相关门禁并生成 full attestation                       |

改动发现覆盖 unstaged、staged、untracked 和可选 branch range。Attestation 绑定 Profile、Git HEAD、改动路径和文件字节；任何变化都会使旧凭证失效。

## 仓库结构

```text
.agent-governance/profile.json
tools/agent-development-governance/
├── governance.py
├── check_changed_text.py
└── manifest.json
```

Manifest 记录中央治理项目版本、源提交和文件 SHA-256。修改仓内 bundle 或 Profile 后若未重新导出，`governance:audit` 必须失败。

## CI 和 Hook

- `pre-commit` 在 lint-staged 前校验治理契约。
- `pre-push` 校验治理契约并保存本次 full gate 计划，之后执行原有架构、类型、测试、UI 和 i18n 门禁。
- GitHub Actions `governance-contract` 在独立 Linux runner 上验证同一契约。
- `governance-contract` 与现有产品质量 jobs 一起进入 `ci-status`；任一失败都阻断合并。
- CI 不再忽略 `.claude/` 或纯文档变更，治理规则变化也必须产生完整 CI 证据。

## 更新中央 Harness

中央源码位于独立的 `agent-development-governance` 项目。更新时使用其 `scripts/export_bundle.py` 重新导出，不手工复制；随后运行 `npm run governance:audit` 和相关 full gates，并在 PR 中记录新 manifest 的版本与源提交。
