# 示例工作流（ComfyUI · API 格式）

这里的 json 是**内置兜底**：`COMFYUI_WORKFLOW` 留空时，`services/comfyui.py` 会读
`sd15_basic.json`。你自己的模型/流程请另存一份，把路径填进 `COMFYUI_WORKFLOW`。

## 怎么导出 API 格式

ComfyUI 里编辑好的工作流默认导出的是**带界面的**格式（节点坐标、连线样式、分组），
后端不认。必须导出 **API 格式**：

- 新版：菜单 `Workflow` → `Export (API)`
- 旧版：右上角齿轮 → 打开 `Dev Mode Settings` → 出现
  `Save (API Format)` 按钮 → 点它导出

导出的文件是一个**扁平字典**，形如 `{"3": {"class_type": "KSampler", "inputs": {...}}, ...}`。
普通格式导出的是 `{"nodes": [...], "links": [...]}`，看到 `nodes` 就是导错了。

## 节点 id 不固定这件事

`sd15_basic.json` 里用了 `3` / `4` / `5` 这些 id，但**我们并不依赖它们**。
后端按拓扑找节点（顺着连线走：`KSampler.inputs.positive` → 正向提示词，等等），
所以你改工作流、重排节点、换 id 都不影响。前提是这几样还在：

| 需要的东西 | 后端怎么找它 |
|---|---|
| 正向提示词 | `KSampler.inputs.positive` 连到的 `CLIPTextEncode` |
| 负向提示词 | `KSampler.inputs.negative` 连到的 `CLIPTextEncode` |
| seed / steps / cfg | `KSampler` / `KSamplerAdvanced` 自己的 inputs |
| 宽 / 高 | `KSampler.inputs.latent_image` 连到的、带 `width`+`height` 的节点 |
| 出图 | `SaveImage` / `PreviewImage` |

找不到任何一样时，报错会把**扫到的所有 `class_type`**列出来，照着改就行，不会只给一句
「生图失败」。

## 注意

- `CheckpointLoaderSimple.inputs.ckpt_name` 要换成**你本地实际有的模型文件名**
  （就是 ComfyUI `models/checkpoints/` 里看到的那个）。填错了 `/prompt` 会 400，
  报错会原样透出来。
- 默认尺寸是 512×768（竖构图）。生图面板里的「尺寸」会覆盖它；不填就按工作流自带的来。
- 负向提示词里那串水印/结构词是通用起手式，可以直接改。