# Hermes 使用说明

这份说明面向你的本机工作流：平时主要用 Codex 做论文修改和小项目开发，需要时让 Hermes 通过阿里百炼/DashScope 和 DeepSeek API 做轻量委派或独立复核。

## 1. 单独启动 Hermes

在 Windows PowerShell 中运行：

```powershell
wsl -d Ubuntu-24.04
cd ~/Hermes
hermes
```

这会进入 WSL 的 `Ubuntu-24.04`，切到 Hermes 工作目录，然后启动 Hermes 交互式命令行界面。

如果你的 WSL 发行版名称不同，先查看：

```powershell
wsl -l -v
```

然后把 `Ubuntu-24.04` 换成对应名称，例如：

```powershell
wsl -d Ubuntu-22.04
```

## 2. 单独使用 Hermes 的常用命令

在 WSL 里进入 Hermes 目录后：

```bash
cd ~/Hermes
```

启动交互式聊天：

```bash
hermes
```

查看版本：

```bash
hermes --version
```

查看帮助：

```bash
hermes --help
```

单次提问：

```bash
hermes chat -q "请检查这个项目的 README 是否清楚。"
```

脚本友好的单次模式，只输出最终回答：

```bash
hermes -z "请总结当前目录的项目用途。"
```

指定模型：

```bash
hermes --provider alibaba -m qwen3.6-flash -z "做一个轻量格式检查。"
hermes --provider alibaba -m qwen3.7-plus -z "做一次深入论文逻辑审查。"
hermes --provider alibaba -m glm-5.2 -z "做一次代码审查。"
hermes --provider deepseek -m deepseek-v4-flash -z "做一次便宜的第二意见。"
hermes --provider deepseek -m deepseek-v4-pro -z "做一次高质量独立复核。"
```

指定 provider：

```bash
hermes --provider alibaba -m qwen3.6-flash -z "检查这个文件。"
```

跳过项目规则和记忆，做更轻量的临时检查：

```bash
hermes --ignore-rules --provider alibaba -m qwen3.6-flash -z "只做简单核对。"
```

恢复最近会话：

```bash
hermes -c
```

查看历史会话：

```bash
hermes sessions list
```

运行诊断：

```bash
hermes doctor
```

查看状态：

```bash
hermes status
```

注意：`status` 可能显示 provider 配置状态。不要把包含密钥或账号信息的输出发到公开仓库。

## 3. Codex 调用 Hermes 的推荐方式

项目中的 `AGENTS.md` 可以指向这个 wrapper：

```text
<codex-hermes-bridge>\tools\hermes-review.ps1
```

也就是说，在已配置 `AGENTS.md` 的项目里，你可以直接用自然语言要求 Codex 调用 Hermes。

最推荐的简单核对提示：

```text
用 Hermes-first flash PathOnly 检查 <任务>，最多列 8 条问题，不保存报告，把 Hermes 结果转述给我。
```

复杂任务提示：

```text
你先完成修改，然后调用 Hermes pro 独立复核本轮改动。不保存 Markdown 报告，最后告诉我 Hermes 的主要结论和你是否采纳。
```

只让 Hermes 看，不改文件：

```text
只用 Hermes flash PathOnly 检查 <文件/问题>，不要修改文件，不保存报告，把结果转述给我。
```

论文高风险审查：

```text
这是论文逻辑、claim 和证据边界检查。请 Codex 主审，再调用 Hermes pro 复核引用使用、图表一致性、claim 强度和剩余风险。
```

## 4. Codex wrapper 直接命令

### 材料发送方式

wrapper 会按任务自动选择材料发送方式：

- 默认 review：发送当前 `git diff`，同时附上变更文件的 WSL/Windows 路径。Hermes 可以先看 diff；如果上下文不够，再按路径读取完整文件。
- `-Flow delegate` 或 `-PathOnly`：只发送路径，适合简单检查和省 token 场景。
- 没有 git diff 且显式 `-Path` 文本文件：内联文件内容。
- 图片文件：由视觉 sidecar 读取，再把视觉结果交给后续文本模型。

当 prompt 中提供路径时，wrapper 会要求 Hermes 必须实际读取需要的文件；如果读不到，要返回 `READ_FAILED`，不能根据文件名猜测。

运行前会显示材料模式、发送方式、材料字符数、prompt 字符数、每个文本模型 pass 的近似输入 token 数，以及文本模型调用次数。token 预览是粗略的 char/4 英文基准估算；中文、代码和混合文本的真实 token 数可能更高。

轻量 Hermes-first 检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" `
  -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 `
  -ProjectRoot "<project-root>" -TaskType paper `
  -Path "<project-root>\AGENTS.md" `
  -ExtraPrompt "只检查这个文件中的 Hermes 工作流说明是否清楚。"
```

Codex 修改后让 Hermes 复核：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" `
  -ProjectRoot "<project-root>" -TaskType code `
  -Path "<project-root>\AGENTS.md"
```

不真正调用 Hermes，只验证命令、路径、模型选择和临时报告行为：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" `
  -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 3 `
  -ProjectRoot "<project-root>" -TaskType code `
  -Path "<project-root>\AGENTS.md" `
  -ExtraPrompt "NoRun path verification only." `
  -NoRun
```

图片、截图或论文图审查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<codex-hermes-bridge>\tools\hermes-review.ps1" `
  -Flow delegate -Lite -PathOnly -MaxFindings 8 `
  -ProjectRoot "<project-root>" -TaskType paper `
  -Path "<project-root>\figure.png" `
  -Vision auto -VisionModel qwen3.7-plus `
  -ExtraPrompt "检查这张图是否清晰、标注是否完整、是否和论文表述一致。"
```

## 5. Hermes 能力分工

### Hermes-first delegate

让 Hermes 先做简单核对，Codex 只负责调度、验收和必要复核。适合：

- 引用数量检查
- 一句话是否引用超过三篇文献
- 文件清单检查
- 格式列表检查
- 拼写或明显一致性扫描
- 错误日志摘要
- 单文件窄范围核对

推荐模型：`qwen3.6-flash`

推荐参数：`-Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8`

### Hermes independent review

Codex 完成主要修改后，让 Hermes 独立审查。适合：

- 论文正文润色后的逻辑复核
- claim 强度和证据边界
- 引用和正文是否匹配
- 图表、结果、正文是否一致
- 代码改动后的 bug/边界条件检查
- 最终交付前复核

推荐模型：小改用 `qwen3.6-flash`，论文高风险用 `qwen3.7-plus`，代码高风险用 `glm-5.2`。

### PathOnly 省 token

`PathOnly` 表示只把文件路径和任务交给 Hermes，让 Hermes 自己读取必要片段。它适合简单核对，能避免 Codex 先读完整大文件。

优点：

- 明显节省 Codex token
- 避免把大文件全文塞进提示词
- 适合引用数量、格式、明显一致性等任务

注意：

- 如果要 Hermes 判断多个文件是否存在或是否同步，需要把这些文件都显式放进 `-Path`。
- PathOnly 审查可能因为视野窄而误报，Codex 需要复核后再采纳。

### 图片和截图审查

普通 Hermes CLI 文本通道不会自动读取图片内容。当前 wrapper 会检测 `.png`、`.jpg`、`.jpeg` 和 `.webp` 文件；默认 `-Vision auto` 时，会把这些图片通过阿里百炼 OpenAI-compatible 视觉接口发送给 `qwen3.7-plus`，再把视觉审查结果和 Hermes 文本审查结果一起输出。

常用参数：

- `-Vision auto`：默认行为，有图片时启用视觉审查。
- `-VisionModel qwen3.7-plus`：默认高质量视觉模型。
- `-Vision off`：不上传图片，只保留路径/文本审查。
- `-MaxImageMb 10`：限制每张图片最大大小。
- `-HermesEnvPath /root/.hermes/.env`：视觉 sidecar 读取的 WSL env 文件，默认就是这个路径。

如果你让 DeepSeek 或 GLM 等文本模型一起审查图片，图片本身仍由视觉 sidecar 读取；文本模型看到的是路径、提示词和视觉审查输出，需要 Codex 汇总后再判断是否采纳。

极小图片可能会被阿里视觉接口的尺寸规则拒绝。日常截图、论文图、界面截图这类正常尺寸图片是推荐输入。

如果使用 `-KeepTemp` 调试，视觉流程还会保留临时 Python sidecar、图片 manifest 和 vision-result Markdown 文件。

`-NoRun` 只验证图片检测、模型路由和临时文件准备，不会真的调用视觉 API；因此视觉结论只会在真实运行时追加给后续文本模型。

## 6. 模型选择

优先用 `qwen3.6-flash` 的场景：

- 简单核对
- 格式检查
- 文件清单
- 拼写扫描
- 错误摘要
- 单文件窄范围检查

优先用 `qwen3.7-plus` 的场景：

- 论文逻辑
- claim 强度
- 实验结果解释
- 图表一致性
- 多文件代码改动
- 架构/API/数据库/认证/依赖变更
- 投稿前或交付前审查

优先用 `glm-5.2` 的场景：

- 代码实现审查
- 多文件代码改动
- 架构/API/数据库/认证/依赖变更
- 测试失败修复和复杂调试

需要三个独立意见时使用：

```powershell
-OpinionCount 3
```

此时 wrapper 使用 `qwen3.6-flash`、`qwen3.7-plus` 和 `deepseek-v4-flash` 做三路独立审查。需要四个独立意见时使用 `-OpinionCount 4`，即前述三路加一个 `glm-5.2`；需要五个独立意见时使用 `-OpinionCount 5`，即再加 `deepseek-v4-pro`。默认情况下 Qwen/GLM 走阿里百炼，DeepSeek 模型走 DeepSeek 官方 API；如需全部走百炼，可显式传入 `-Provider alibaba`。

如果你想指定精确模型组合，使用：

```powershell
-Models "deepseek-flash","qwen-flash"
```

常用别名包括 `qwen-flash`、`qwen-pro`、`deepseek-flash`、`deepseek-pro` 和 `glm`。

`-Flow delegate -Mode auto` 会默认选择 flash，因为 delegate 是为轻量 Hermes-first 检查设计的。如果 delegated task 仍然很难，显式写 `-Mode pro`。

## 7. 报告保存策略

默认行为：

- Hermes 输出会显示在本轮终端/对话中。
- wrapper 会创建临时 Markdown 报告。
- 脚本结束后会删除临时报告。

只有明确需要留档时才使用：

```powershell
-KeepReport
```

或：

```powershell
-OutputPath "D:\path\to\hermes-review.md"
```

日常不要保存每次审查报告，否则很快会堆很多 Markdown 文件。

## 8. 你平时最该记住的两句话

简单省 token：

```text
用 Hermes-first flash PathOnly 检查这个问题，不保存报告，把结果转述给我。
```

复杂提质量：

```text
你先完成修改，然后用 Hermes pro 独立复核本轮改动，不保存报告。
```
