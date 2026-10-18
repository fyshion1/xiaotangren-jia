// 酒馆（SillyTavern）角色卡导入 —— 与后端 `/api/imports/tavern-card/*` 通信。
//
// 三步走，前两步都是「先预览、后落库」：
//   previewTavernCard(file)   → 只读卡 + 立绘落盘 + 拼 about，**立刻返回草稿**（不建角色、不叫模型）
//   extractTavernCard(file)   → 画面出来之后才叫模型抽词条（后填；慢的是它）
//   translateTavernCard(text) → 另要一份中文译文（只给界面看，原文照旧喂模型）
//   commitTavernCard(...)     → 用户在预览里确认 / 改过名字词条之后，才真的建角色
//
// 读卡与抽取的规则在后端 `services/card_import.py`（原文一字不改）；这里只管传输。

import type { CharacterProfile } from '../data/characters'

/** 抽取 / 翻译模型走聊天那一份上游（与 lib/visionRoute 同源）：留空则由后端回退 .env。 */
export type CardImportRoute = { baseUrl: string; apiKey: string; model: string }

export type CardPreview = {
  status: 'preview'
  filename: string
  /** chara_card_v1 / v2 / v3 —— 用来在预览里标一句「这是哪个版本的卡」。 */
  spec: string
  creator: string
  tags: string[]
  /** 卡里有没有开场白。**存下来但不自动发言**：导入框默认不勾，勾了才写进私聊第一条。 */
  has_greeting: boolean
  /** 草稿档案：键与 CharacterProfile 一致（缺 id / forms 等可选字段）。 */
  profile: Partial<CharacterProfile> & { imported?: boolean }
  /** 非致命提醒（截断、没抽成、没卡图…）。有内容就在预览里摊开给用户看。 */
  warnings: string[]
  /** 同名角色已在库：前端先问「跳过还是新建第二张」，默认跳过。 */
  duplicates: { id: string; name: string }[]
}

async function asJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.json())?.detail ?? ''
    } catch {
      /* 后端没回 JSON（崩了 / 代理断了）—— 用状态码兜底 */
    }
    throw new Error(detail || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

function routeQuery(route?: CardImportRoute): string {
  const q = new URLSearchParams()
  if (route) {
    if (route.baseUrl) q.set('base_url', route.baseUrl)
    if (route.apiKey) q.set('api_key', route.apiKey)
    if (route.model) q.set('model', route.model)
  }
  return q.toString() ? `?${q}` : ''
}

/**
 * 只读卡，**不建角色、也不叫模型** —— 毫秒级返回，立绘与「关于」立刻能看。
 *
 * 词条与译文由 `extractTavernCard` / `translateTavernCard` 后填，别在这里等。
 */
export async function previewTavernCard(file: File): Promise<CardPreview> {
  const fd = new FormData()
  fd.append('file', file)
  return asJson<CardPreview>('/api/imports/tavern-card/preview?extract=false', { method: 'POST', body: fd })
}

/** 第二步：叫模型从原文里抽词条（后填）。要几秒，抽不到就是空词条 + warnings，不抛。 */
export async function extractTavernCard(
  file: File,
  route?: CardImportRoute,
): Promise<{ extracted: boolean; fields: Partial<CharacterProfile>; warnings: string[] }> {
  const fd = new FormData()
  fd.append('file', file)
  return asJson(`/api/imports/tavern-card/extract${routeQuery(route)}`, { method: 'POST', body: fd })
}

/** 第三步：要一份**只给界面看**的中文译文。翻的是传进来的 text（用户改过就翻改过的）。 */
export async function translateTavernCard(
  text: string,
  route?: CardImportRoute,
): Promise<{ aboutZh: string; warnings: string[] }> {
  return asJson(`/api/imports/tavern-card/translate${routeQuery(route)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

/** 按（可能被用户改过的）草稿建角色。`id` 留空 = 新建第二张（后端生成 `char-<hex>`）。
 *  `greeting=true` 时后端把卡里的开场白写成她私聊的第一条 —— **默认 false，不写**。 */
export async function commitTavernCard(body: {
  id?: string
  name: string
  fields: Partial<CharacterProfile> & { imported?: boolean }
  /** 勾了「把卡里的开场白放进她的私聊」才传 true。 */
  greeting?: boolean
}): Promise<CharacterProfile> {
  return asJson<CharacterProfile>('/api/imports/tavern-card/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: body.id ?? '',
      name: body.name,
      fields: body.fields,
      greeting: body.greeting ?? false,
    }),
  })
}

/** 角色介绍页的「插入开场白」：把档案里存的那份开场白写成她私聊的第一条。
 *  会话已经聊过则 400（开场白该在最前面），把后端的原话抛给用户看。 */
export async function insertTavernCardGreeting(
  charId: string,
): Promise<{ ok: boolean; session_id: string; content: string }> {
  return asJson(`/api/imports/tavern-card/${encodeURIComponent(charId)}/greeting`, { method: 'POST' })
}

/** 删掉导入的角色卡（角色介绍 / 最近对话里都能点）。
 *  只有导入的卡删得掉 —— 自家四位是种子数据，后端会 400 并说明原因。 */
export async function deleteTavernCard(
  charId: string,
  purge = true,
): Promise<{ ok: boolean; removed: { sessions: number; messages: number; memories: number; gallery: number; files: number } }> {
  return asJson(`/api/imports/tavern-card/${encodeURIComponent(charId)}?purge=${purge}`, { method: 'DELETE' })
}