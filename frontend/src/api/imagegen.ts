// 生图（《项目要求》§7）。
// 四个引擎：本地 ComfyUI / 云端 ComfyUI（同协议，只是地址不同）/ 第三方 OpenAI 兼容 API /
// NovelAI（预留插槽）。后端负责分派与落盘，前端只管传参和展示。

export type ImageEngine = {
  id: string
  name: string
  ready: boolean
  desc: string
}

export async function fetchImageEngines(): Promise<{ engines: ImageEngine[]; selected: string }> {
  try {
    const resp = await fetch('/api/images/engines')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return (await resp.json()) as { engines: ImageEngine[]; selected: string }
  } catch {
    // 后端没起来时给一份等价的内置表，界面不至于空着
    return {
      selected: 'local',
      engines: [
        { id: 'local', name: '本地 ComfyUI', ready: false, desc: '后端未连接，无法探测。' },
        { id: 'cloud', name: '云端 ComfyUI（CNB 等）', ready: false, desc: '后端未连接，无法探测。' },
        { id: 'thirdparty', name: '第三方生图 API', ready: false, desc: '后端未连接，无法探测。' },
        { id: 'novelai', name: 'NovelAI（未接入）', ready: false, desc: '协议不兼容，只留插槽。' },
      ],
    }
  }
}

/** 记住选中的生图方式（§7）。存后端 DB，重启仍在。 */
export async function selectImageEngine(id: string): Promise<string> {
  const resp = await fetch('/api/images/engines/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const data = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(data?.detail ?? `HTTP ${resp.status}`)
  return data?.selected ?? id
}

export type GenerateRequest = {
  prompt: string
  session_id: string
  size?: string
  n?: number
  seed?: number | null
  negative?: string
  steps?: number | null
  cfg?: number | null
  // thirdparty 引擎的临时覆盖（走前端「模型设置」里的值）
  base_url?: string
  api_key?: string
  model?: string
}

/** 后端返回的附件引用，与 POST /attachments 同形 */
export type GeneratedImage = {
  id: string
  orig: string
  thumb: string
}

/**
 * 出图。结果已落到附件库（source='generated'），无需再上传。
 * 失败时抛出后端原话（后端会点名缺哪个配置，别吞掉）。
 */
export async function generateImages(req: GenerateRequest): Promise<GeneratedImage[]> {
  const resp = await fetch('/api/images/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const data = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(data?.detail ?? `HTTP ${resp.status}`)
  return (data?.images ?? []) as GeneratedImage[]
}