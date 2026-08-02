# Codex + Hermes 代码规则

编辑前阅读相关 README、配置、入口点和现有风格；修改后运行测试、lint、类型检查、构建或最小启动验证。

实现保持最小：先说明根因和假设，优先修改现有文件或配置；不为一次性代码增加抽象，不做无关重构，不为假设中的未来需求增加选项。每一处改动都必须对应需求，并用可重复的检查证明完成。

- 清单、格式和错误摘要等窄任务使用 `-Preset delegate`。
- 普通代码复核使用 `-Preset code`。
- 架构、认证、数据库、依赖、并发或复杂调试使用 `-Preset code-deep`。
- 未传 `-Path` 时 wrapper 自动收集 staged、unstaged、deleted 和 untracked Git 材料。
- `code-deep` 的专项 reviewer 仍收到完整 bundle；flash 不承担正式代码 reviewer。
- Codex/Sol 必须用代码、测试或文档核验每条意见，不采纳无证据结论。
- 默认不保存报告；用户要求存档时才用 `-OutputPath` 或 `-KeepReport`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<bridge>\tools\hermes-review.ps1" `
  -Preset code-deep -ProjectRoot "<root>" -Prompt "审查本轮全部改动。"
```
