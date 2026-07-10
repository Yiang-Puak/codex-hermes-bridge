# codex-hermes-bridge

一个本地的 **Codex + Hermes 协作桥接项目**。

目标很朴素：平时由 Codex 负责改论文、写代码、整理项目；需要独立复核时，让 Codex 调用本地 Hermes CLI，用 Qwen、DeepSeek、GLM 等模型做轻量检查或多模型审查，同时尽量节省 token，并避免每次都留下 Markdown 报告。

## 项目包含什么

- `tools/hermes-review.ps1`：Windows PowerShell -> WSL -> Hermes 的主 wrapper。
- `skills/hermes-review/`：可安装到 Codex 的 Skill，让 Codex 知道什么时候、怎么调用 Hermes。
- `examples/AGENTS.paper.md`：论文/稿件项目的 `AGENTS.md` 模板。
- `examples/AGENTS.code.md`：代码项目的 `AGENTS.md` 模板。
- `tests/smoke-no-run.ps1`：不消耗模型 token 的 smoke test。

当前版本不是 MCP server，也不是常驻 daemon。它优先保持简单：脚本 + Skill + 项目规则。

## 适合的工作流

```text
Codex 修改/整理 -> Hermes 独立审查 -> Codex 复核 Hermes 意见 -> 只采纳能验证的问题
```

常见场景：

- 论文润色后，让 Hermes 检查逻辑、引用、图表一致性。
- 小项目改完后，让 Hermes 独立 code review。
- 简单任务先让 Hermes flash 快速看一遍，减少 Codex 自己读全文的 token。
- 重要任务要求多个模型独立给意见，再由 Codex 汇总和判断。

## 环境要求

- Windows PowerShell。
- WSL，并且 Hermes CLI 在 WSL 内可用，通常在 `$HOME/.local/bin/hermes`。
- Hermes 的 provider/model 已单独配置好。
- 如果要使用 Codex 自动调用，建议使用 Codex Desktop 或 Codex CLI，并安装本项目的 Skill。

仓库中不保存任何 API key。

默认 WSL 发行版是 `Ubuntu-24.04`。可以用下面命令查看本机名称：

```powershell
wsl -l -v
```

如果你的发行版不是这个名字，调用 wrapper 时加：

```powershell
-WslDistro "Ubuntu-22.04"
```

## 单独打开 Hermes

```powershell
wsl -d Ubuntu-24.04
cd ~/Hermes
hermes
```

## 安装 Codex Skill

在本仓库根目录运行：

```powershell
$dest = Join-Path $env:USERPROFILE ".codex\skills\hermes-review"
Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force ".\skills\hermes-review" $dest
```

安装后重启 Codex。

## 在项目中使用

把模板复制到目标项目根目录，命名为 `AGENTS.md`：

```powershell
Copy-Item ".\examples\AGENTS.paper.md" "D:\path\to\paper-project\AGENTS.md"
Copy-Item ".\examples\AGENTS.code.md" "D:\path\to\code-project\AGENTS.md"
```

之后可以直接用自然语言对 Codex 说：

```text
改完后让 Hermes 审查。
```

```text
用 qwen-flash 快速检查这个文件。
```

```text
用 deepseek-flash 和 qwen-flash 同时审核这个项目，然后你汇总两边意见。
```

```text
这张图用 Hermes 视觉审查一下。
```

## 直接调用 wrapper

### 材料发送方式

wrapper 会按任务形态自动选择发送方式：

- **Hybrid review**：默认 post-change review 会发送当前 `git diff`，同时附上变更文件的 WSL/Windows 路径，方便 Hermes 在 diff 上下文不足时读取完整文件。
- **PathOnly**：`-Flow delegate` 或 `-PathOnly` 只发送文件路径，适合简单检查和省 token 场景。
- **Inline content**：没有 git diff 且显式传入文本文件时，会把文件内容内联给 Hermes。
- **Vision sidecar**：图片文件由视觉模型读取，再把视觉结果交给后续文本模型。

当提供路径时，prompt 会要求 Hermes 必须实际读取需要的文件；如果读不到，要返回 `READ_FAILED`，不能根据文件名猜测。

每次调用前，wrapper 会显示材料模式、发送方式、字符数、CJK 字符数、近似输入 token/每个文本模型 pass、跨文本模型的近似总输入 token，以及文本模型调用次数。token 预览是粗略的中英混合启发式估算，不是 provider 计费 tokenizer；真实 provider token、输出 token 和视觉结果追加文本仍可能不同。三个及以上文本模型会给出非阻塞预算提醒，不会要求二次确认。

Hermes 的发现默认按第一性原理组织：先说明目标/约束，再给出证据、影响和动作。没有实际证据时，Hermes 应降低置信度，而不是把猜测写成事实。

轻量 delegate 检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 `
  -ProjectRoot "D:\path\to\project" -TaskType paper `
  -Path "D:\path\to\project\main.tex" `
  -ExtraPrompt "检查是否有一句正文引用超过三篇参考文献。"
```

Codex 改完后的独立审查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Mode auto -ProjectRoot "D:\path\to\project" -TaskType code `
  -Path "D:\path\to\project\src\changed-file.ts"
```

指定两个模型独立审查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Flow delegate -Lite -PathOnly -ProjectRoot "D:\path\to\project" `
  -TaskType code -Path "D:\path\to\project\README.md" `
  -Models "deepseek-flash","qwen-flash" `
  -ExtraPrompt "请独立审查并返回简洁问题列表。"
```

图片、截图或论文图审查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Flow delegate -Lite -PathOnly -ProjectRoot "D:\path\to\project" `
  -TaskType paper -Path "D:\path\to\project\figure.png" `
  -Vision auto -VisionModel qwen3.7-plus `
  -ExtraPrompt "检查图片是否清晰、标注是否完整、是否与正文描述一致。"
```

默认情况下，wrapper 会把 Hermes 输出显示到终端，并在运行结束后删除临时 Markdown 报告。只有显式使用 `-KeepReport` 或 `-OutputPath` 时，才会保存报告文件。

更完整的中文使用说明见：[docs/HERMES_USAGE.md](docs/HERMES_USAGE.md)。

## 模型策略

默认 provider 路由：

- Qwen / GLM -> `alibaba`
- DeepSeek -> `deepseek`

常用模型：

- `qwen3.6-flash`：简单检查、格式检查、小文件扫描、低成本快速复核。
- `qwen3.7-plus`：论文逻辑、结果解释、图表一致性、终稿复核。
- `deepseek-v4-flash`：便宜的独立补充意见，适合多模型审查。
- `glm-5.2`：复杂代码改动、架构/API/数据库/auth/依赖、调试类审查。
- `deepseek-v4-pro`：需要五个独立意见时作为更强的补充意见。

常用参数：

- `-Mode flash`：强制使用轻量模型。
- `-Mode pro`：强制使用较强模型。
- `-Mode auto`：让 wrapper 自动选择。
- `-Models "deepseek-flash","qwen-flash"`：精确指定模型组合。
- `-OpinionCount 3`：Qwen flash + Qwen pro + DeepSeek flash。
- `-OpinionCount 4`：在 3 个意见基础上加入 GLM。
- `-OpinionCount 5`：在 4 个意见基础上加入 DeepSeek pro。

常用别名：

- `qwen-flash` -> `qwen3.6-flash`
- `qwen-pro` -> `qwen3.7-plus`
- `deepseek-flash` -> `deepseek-v4-flash`
- `deepseek-pro` -> `deepseek-v4-pro`
- `glm` -> `glm-5.2`

## 图片和截图审查

普通 Hermes CLI 路线主要是文本审查。这个 wrapper 会额外检测 `.png`、`.jpg`、`.jpeg`、`.webp` 文件，并在默认 `-Vision auto` 下调用阿里百炼 OpenAI-compatible 视觉接口，把图片本身发送给多模态模型。

关键参数：

- `-Vision auto`：默认，有图片时启用视觉审查。
- `-Vision off`：不上传图片，只保留路径/文本审查。
- `-VisionModel qwen3.7-plus`：默认视觉审查模型。
- `-MaxImageMb 10`：限制每张图片大小。
- `-HermesEnvPath /root/.hermes/.env`：视觉 sidecar 读取的 WSL env 文件路径。

视觉 sidecar 会先读取图片，再把视觉结果追加给后续文本模型。因此 DeepSeek、Qwen flash、GLM 等文本模型可以基于视觉摘要继续审查。

注意：

- 极小图片可能会被 provider 的尺寸规则拒绝。
- 正常截图、论文图、界面截图是推荐输入。
- `-NoRun` 只验证图片检测和路由，不会真的调用视觉 API。
- `-KeepTemp` 会保留 prompt、runner、vision Python 文件、图片 manifest 和 vision-result Markdown，用于调试。

## Smoke Test

提交 wrapper、Skill 或模板改动前运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tests\smoke-no-run.ps1"
```

这个测试使用 `-NoRun`，不会调用 Hermes，也不会消耗模型 token。

## 安全约定

- 不把 API key、provider 私有配置、真实论文内容、本机私有路径或日志提交到仓库。
- 默认不保存 Markdown 审查报告，避免报告越积越多。
- Hermes 的意见只是独立输入，不自动等于事实；最终由 Codex 或人工复核后决定是否采纳。

## 当前状态

v0.1 面向个人和小团队本地使用。先保持轻量；只有当脚本 + Skill 的工作流确实不够用时，再考虑 MCP、常驻进程或完整 Codex plugin。
