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

// ---- 个人档案（私人空间 / 用户身份，§22）----
// 和 characters 是一对镜像，多一个「当前身份」和删除。当前身份存在后端 settings 里，
// 所以全局一处切换，私聊群聊一起走。

export type ProfilesPayload = {
  profiles: CharacterProfile[]
  active_id: string
  main_id: string
}

export async function fetchProfiles(): Promise<ProfilesPayload> {
  return asJson<ProfilesPayload>('/api/profiles')
}

export async function saveProfile(profile: CharacterProfile): Promise<CharacterProfile> {
  return asJson<CharacterProfile>(`/api/profiles/${profile.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
}

/** 新建身份档案。缺 id 时后端生成 `persona-<hex>`，返回落库后的完整档案。 */
export async function createProfile(
  profile: Omit<CharacterProfile, 'id'> & { id?: string },
): Promise<CharacterProfile> {
  return asJson<CharacterProfile>('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
}

/** 「成为这个身份」：切当前身份。只改一个服务端设置，不动任何消息。 */
export async function switchProfile(profileId: string): Promise<{ active_id: string }> {
  return asJson<{ active_id: string }>(`/api/profiles/active/${profileId}`, { method: 'PUT' })
}

/** 删档案：后端会连这个身份名下的会话一起清掉（每个身份各自一条，§22）。 */
export async function deleteProfile(profileId: string): Promise<void> {
  await asJson(`/api/profiles/${profileId}`, { method: 'DELETE' })
}