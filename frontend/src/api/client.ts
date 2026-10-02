// 与后端通信封装（/api，经 Vite 代理转发到后端 :8000；手机访问时也是同源，无需改地址）。
import type { CharacterProfile } from '../data/characters'
import type { WorldbookEntry } from '../data/worldbook'

async function asJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    let detail = ''
    try {
      const body = await resp.json()
      detail = body?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

export async function fetchCharacters(): Promise<CharacterProfile[]> {
  return asJson<CharacterProfile[]>('/api/characters')
}

export async function saveCharacter(char: CharacterProfile): Promise<CharacterProfile> {
  return asJson<CharacterProfile>(`/api/characters/${char.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(char),
  })
}

/** 新建角色。缺 id 时后端生成 `char-<hex>`，返回落库后的完整档案（含最终 id）。 */
export async function createCharacter(char: Omit<CharacterProfile, 'id'> & { id?: string }): Promise<CharacterProfile> {
  return asJson<CharacterProfile>('/api/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(char),
  })
}

/** owner 不传 = 全部（编辑面板）；传 '' = 家共用那一档（群聊）；传角色 id = 那位的专属。 */
export async function fetchWorldbook(owner?: string): Promise<WorldbookEntry[]> {
  const qs = owner === undefined ? '' : `?owner=${encodeURIComponent(owner)}`
  return asJson<WorldbookEntry[]>(`/api/worldbook${qs}`)
}

export async function createWorldbookEntry(
  entry: Omit<WorldbookEntry, 'id' | 'updated_at'>,
): Promise<WorldbookEntry> {
  return asJson<WorldbookEntry>('/api/worldbook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
}

export async function updateWorldbookEntry(entry: WorldbookEntry): Promise<WorldbookEntry> {
  return asJson<WorldbookEntry>(`/api/worldbook/${entry.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
}

export async function deleteWorldbookEntry(id: string): Promise<void> {
  await asJson(`/api/worldbook/${id}`, { method: 'DELETE' })
}

export type Settings = Record<string, string>

export async function fetchSettings(): Promise<Settings> {
  return asJson<Settings>('/api/settings')
}

export async function saveSettings(kv: Settings): Promise<Settings> {
  return asJson<Settings>('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(kv),
  })
}