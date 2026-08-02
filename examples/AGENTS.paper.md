# Codex + Hermes 论文规则

保持科学含义、引用键、数值、公式、表格值和术语。修改后先运行 LaTeX、引用键或用户指定的确定性检查。

修改保持手术式和最小化：先说明假设与证据边界，不新增与论文目标无关的结构，不顺手重写无关章节；每一处改动都要有可验证的成功条件。

- 格式、清单和引用数量等窄任务使用 `-Preset delegate`。
- 论文逻辑、方法、结果、claim、引用和图表一致性使用 `-Preset paper`；投稿前高风险版本可用 `paper-deep`。
- paper preset 必须显式列出完整正文、补充材料和相关文本文件。每个模型独立审查全部材料，不能按章节分工，也不能看到其他 reviewer 的身份或输出。
- 标准面板顺序固定为 DeepSeek Pro、DeepSeek Flash、千问 Plus。
- 图片默认不外发；用户明确允许后才使用 `-Vision shared -AllowImageUpload`。
- Codex/Sol 在全部独立输出完成后做语义合并和证据核验。模型自报 confidence 不等于事实。
- 默认不保存报告；用户要求存档时才用 `-OutputPath` 或 `-KeepReport`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<bridge>\tools\hermes-review.ps1" `
  -Preset paper -ProjectRoot "<root>" -Path "<main>","<supplement>" `
  -Prompt "完整审查逻辑、数字、证据边界和可推广性。"
```
