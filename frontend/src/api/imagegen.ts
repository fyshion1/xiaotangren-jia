// 生图方式切换器（《项目要求》§7）。
// 三种方式：腾讯云（占位，默认）/ 本地 ComfyUI-SD（占位）/ 第三方 API（可用）。
// 后端只负责列出与记住选择；真正接入实机前，未接入的选项只给提示、不阻挡。

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
      selected: 'tencent',
      engines: [
        { id: 'tencent', name: '腾讯云（占位）', ready: false, desc: '实机接入排在生图通道就绪之后。' },
        { id: 'comfyui', name: '本地 ComfyUI / SD（占位）', ready: false, desc: '填本地 /v1 地址即可接入。' },
        { id: 'thirdparty', name: '第三方生图 API', ready: true, desc: '支持 /images/generations 的中转，现在就能用。' },
      ],
    }
  }
}

/** 记住选中的生图方式（§7）。只存选择，实机接入前不改变上游调用。 */
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
