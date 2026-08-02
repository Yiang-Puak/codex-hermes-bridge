# codex-hermes-bridge

一个保持轻量的本地 **Codex → Hermes 独立评审桥**。

Codex 负责修改、确定性验证和最终判断；Hermes 让不同模型基于同一个不可变材料快照独立给意见。wrapper 不做语义共识、不保存数据库、不运行 daemon，也不把模型意见自动当成事实。

## 五个 Preset

| Preset | Reviewer | 用途 |
| --- | --- | --- |
| `delegate` | Qwen Flash | 格式、清单、错误摘要等窄范围检查 |
| `paper` | DeepSeek Pro、DeepSeek Flash、千问 Plus | 三模型分别完整审查同一论文材料 |
| `paper-deep` | 标准三模型 + GLM + Qwen Flash | 投稿前或争议较大的完整审查 |
| `code` | GLM | 一位强模型全局代码审查 |
| `code-deep` | GLM 全局 + 千问 Plus 安全 + DeepSeek Pro 正确性/测试 | 高风险代码改动 |

论文 reviewer 不分章节、不共享其他 reviewer 的身份或输出。代码专项 reviewer 仍看到完整 bundle，只是对指定领域投入更多注意力；同时检查一次性抽象、重复实现、推测性配置和无关重构是否造成不必要复杂度。

## 材料合同

wrapper 只生成一种不可变 bundle：

- 显式 `-Path`：使用这些文件的内容。
- code preset 未传 `-Path`：自动收集 staged、unstaged、deleted diff 和 untracked 文件。
- 文本内容和图片哈希进入同一个 snapshot。
- 二进制、超大文件、读取失败或未审查图片会让 coverage 变成 `incomplete`。
- 每个 reviewer 收到同一个 snapshot ID 和 bundle 路径。

运行前会显示材料字符数、近似 token/reviewer、coverage、模型和 provider。这个估算包含 bundle 内容，但仍不是 provider 的计费 tokenizer。

## 使用

论文标准面板：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Preset paper -Concurrency 3 -ProjectRoot "D:\path\to\paper" `
  -Path "D:\path\to\paper\main.tex","D:\path\to\paper\supplement.tex" `
  -Prompt "完整审查逻辑、数字、claim、证据边界和可推广性。"
```

代码高风险面板；不传 `-Path` 时审查全部 Git 变更，包括 untracked：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Preset code-deep -ProjectRoot "D:\path\to\project" `
  -Prompt "重点检查认证、并发和回归风险。"
```

窄范围委派：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Preset delegate -ProjectRoot "D:\path\to\project" `
  -Path "D:\path\to\project\README.md" `
  -Prompt "只检查安装步骤是否自洽。"
```

只检查路由、快照和 runner，不调用模型：

```powershell
... -NoRun
```

常用参数：

- `-Models`：显式覆盖 preset 模型顺序。
- `-MaxFindings`：每位 reviewer 的发现上限。
- `-TimeoutSec`：每位 reviewer 的硬超时。
- `-Concurrency`：并行上限；设为 `1` 即串行。论文 preset 未显式指定时自动使用 `3`，使三位独立审稿人同时启动；显式值仍优先。
- `-OutputPath` 或 `-KeepReport`：持久保存唯一的 JSON 报告。
- `-KeepTemp`：仅用于调试 bundle、prompt 和 runner。
- `-AllowSensitiveInput`：用户确认外发范围后绕过高置信度内容检查。

## 输出与 Sol

wrapper 只维护一种 JSON 结果（schema `2.1`）：`runStatus`、snapshot、文件状态、reviewer 状态、findings、residual risks 和 transport 诊断。只有 `runStatus=completed` 且所有 reviewer 都是 `completed` 时才是有效结论；默认会把 JSON 输出到终端，然后删除临时报告。

WSL 的启动诊断与 reviewer 结果分开处理：WSL 退出码为 `0` 时，启动 stderr 仅记录为非致命诊断，不能单独判定审查失败。若 Windows 使用 `localhost` 代理而 WSL 为 NAT 模式，可在 `%UserProfile%\.wslconfig` 设置 `autoProxy=false`，或在确实需要该本地代理时改用 mirrored networking。

从 Codex 或其他会话型终端调用时，必须持续轮询同一终端，直至出现 `Reviewer states:` 和 JSON 结果；wrapper 会输出 reviewer 完成进度和心跳。`Hermes review prepared`、`Running Hermes...` 以及 WSL 非致命诊断都只是进度，不是完成或失败信号。

wrapper 故意不做自动语义共识。所有 reviewer 独立完成后，由 Sol/Codex：

1. 按语义合并相同问题。
2. 回到 bundle 核验证据。
3. 区分共识、分歧和模型独有意见。
4. 拒绝无依据计算和过强结论。

Sol/Terra/Luna 的选择属于 Codex 编排层，不是 wrapper 的模型切换参数。

## 图像与敏感材料

默认 `-Vision off`，图片不会外发且 coverage 为 `incomplete`。

允许共享视觉 sidecar：

```powershell
-Vision shared -AllowImageUpload
```

视觉证据由一个 sidecar 生成并共享给文本 reviewer，因此文本判断仍独立，但视觉证据不是多模型独立生成。

内容扫描只拦截高置信度 private key、Bearer token、API key 和带密码连接串；它不是完整 DLP。真实论文、日志或私有代码外发前仍需人工确认。

## 安装

Skill 的唯一源码就在 `skills/hermes-review/`。可直接复制：

```powershell
$dest = Join-Path $env:USERPROFILE ".codex\skills\hermes-review"
Copy-Item -Path ".\skills\hermes-review\*" -Destination $dest -Recurse -Force
```

仓库同时包含 `.codex-plugin/plugin.json`。安装 plugin 时复制整个 `skills/hermes-review/`，不需要构建或生成同步副本。

## 开发验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tests\smoke-no-run.ps1"
```

smoke 不消耗模型 token，验证论文顺序与隔离、强模型代码角色、Git untracked/deleted 收集、coverage、敏感内容拒绝和临时文件策略。

## 简洁性约束

- Skill 目录是唯一实现源码。
- 顶层 wrapper 必须保持在 10 行以内。
- 主脚本目标不超过 900 行；smoke 不超过 250 行。
- 只允许一个 profile 配置和一个结果 schema。
- 不提交生成副本，不为每个版本新建迁移文档。
- 不加入 MCP、daemon、数据库、任务队列、Web UI 或 wrapper 内第二轮模型共识。
