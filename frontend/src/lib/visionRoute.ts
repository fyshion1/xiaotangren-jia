// 从本地存的模型配置里解析出「看图（vision）」这一路要打的上游。
//
// 为什么单独放一份：自动描述要用 vision 模型，但调用点不止聊天页 —— 介绍页立绘浮层、
// 小窝画廊、🖼 画廊浮层都要用。把 ChatView 整个 import 进来只为拿一个 resolveRoute 太重，
// 所以这里直接读同一份 localStorage 配置，规则与 ChatView.resolveRoute 保持一致：
// 走无审查通道时取无审查那一路，留空则回退常规通道。

const STORAGE_KEY = 'xiaotangren.config'

export type VisionRoute = { baseUrl: string; apiKey: string; model: string }

const FALLBACK: VisionRoute = {
  baseUrl: 'https://vsllm.cc/v1',
  apiKey: '',
  model: 'gemini-3.8-flash',
}

/** 读取当前配置里的 vision 上游（无审查通道生效时优先用它的字段）。 */
export function visionRoute(kind: 'vision' | 'chat' = 'vision'): VisionRoute {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return FALLBACK
    const c = JSON.parse(raw) as Record<string, string>
    const on = c.channel === 'uncensored'
    return {
      baseUrl: (on && c.uncensoredBaseUrl) || c.baseUrl || FALLBACK.baseUrl,
      apiKey: (on && c.uncensoredApiKey) || c.apiKey || '',
      model: (on && c[kind === 'chat' ? 'uncensoredChatModel' : 'uncensoredVisionModel']) || c[kind === 'chat' ? 'chatModel' : 'visionModel'] || FALLBACK.model,
    }
  } catch {
    return FALLBACK
  }
}

/** 当前是否在无审查通道（决定自动描述要不要注入越狱提示，§7）。 */
export function isUncensoredChannel(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    return (JSON.parse(raw) as Record<string, string>).channel === 'uncensored'
  } catch {
    return false
  }
}
