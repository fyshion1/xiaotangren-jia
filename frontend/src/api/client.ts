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

export type BrainHealth = {
  status: string
  name: string
  /** 这一份大脑是什么时候起来的（「%Y-%m-%d %H:%M:%S」）。 */
  started_at: string
  pid: number
  uptime_seconds: number
}

export async function fetchHealth(): Promise<BrainHealth> {
  return asJson<BrainHealth>('/api/health')
}

/**
 * 一键重启大脑（顶栏那颗灯旁边）。
 *
 * 后端先把新进程叫起来再回话，所以**这句几乎总能拿到 200**；随后老进程退位、新进程接上，
 * 中间大概断一两秒 —— 调用方别看它自己的返回值判断好了没，要等 `/api/health` 报出**新的 pid**。
 */
export async function restartBrain(): Promise<{ ok: boolean; message: string; log: string }> {
  return asJson('/api/system/restart', { method: 'POST' })
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

export async function saveGameApiConfig(body: { game_id: string; name: string; base_url: string; api_key: string; model: string }): Promise<any> {
  return asJson('/api/game/api-configs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
export async function fetchGameApiConfigs(gameId: string): Promise<any[]> {
  const result = await asJson<{ items: any[] }>(`/api/game/api-configs?game_id=${encodeURIComponent(gameId)}`)
  return result.items || []
}
export async function launchInteractiveHome(): Promise<{ ok: boolean; project: string }> {
  return asJson('/api/interactive-home/launch', { method: 'POST' })
}

// ---- 糖人小窝 · 通用外设接入层（§9.6）----
// 功能的唯一清单来自后端注册表（代码级真相源），前端按它渲染小窝入口列表。
// 配置分两层：全局默认（小窝大脑默认，带 vision）+ 每功能可覆盖。

/** 功能自己提供的子命令：前端按它渲染按钮，命令串由后端按白名单拼，前端传不了任意命令。 */
export type NestRunnerCommand = {
  name: string
  label: string
  desc: string
  params: string[]
  /** 常驻循环（跑起来就不返回）：后端立刻回 pid，前端显示「停掉」。 */
  background?: boolean
}

export type NestRunner = {
  folder: string
  module: string
  commands: NestRunnerCommand[]
}

export type NestFeature = {
  id: string
  name: string
  emoji: string
  kind: 'game' | 'media' | 'im' | 'home' | 'other'
  status: 'available' | 'planned'
  desc: string
  needs_vision: boolean
  folder: string
  /** 有 runner = 能在小窝里直接启动（本体只开进程，逻辑在独立项目里）。 */
  runner: NestRunner | null
  /** 有 settings = 这个功能的开关能在小窝前端改（§9.6.5，不用去编辑 config.json）。 */
  settings?: NestSettingField[] | null
}

// ---- 功能自己的配置项（§9.6.5）----
// 「有哪些项、什么类型、默认值」由功能在注册表里声明（跟着功能代码走）；
// 「值是多少」存本体。功能侧每轮拉一次 → 改完立刻生效，不用重启。

export type NestSettingField = {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'bool' | 'list' | 'select'
      | 'accounts' | 'character' | 'media_list'
  desc: string
  default: unknown
  /** 前端按这个分组显示（同一组的字段放一起，组名 = 小标题）。 */
  group: string
  /** 密码框显示（**只是不明文晃眼，不是加密**）。 */
  secret?: boolean
  /** 只给 bool 用：前端显示的是**存储值的反**（`memory.isolate` 那种名字反着写的开关）。
      勾上 = 存进去 false。`values` 回来的一律还是存储语义，前端的反只发生在显示层。 */
  invert?: boolean
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  /** type=accounts 时每一行里的格子。 */
  fields?: NestSettingField[]
}

export type NestSettings = {
  feature_id: string
  /** 能配什么（声明）+ 现在是什么（值），值里缺的已按默认补上。 */
  schema: NestSettingField[]
  values: Record<string, unknown>
  configured: boolean
  updated_at: string
  ignored?: string[]
}

export async function fetchNestFeatureSettings(featureId: string): Promise<NestSettings> {
  return asJson<NestSettings>(`/api/nest/features/${encodeURIComponent(featureId)}/settings`)
}

/** 整份提交（后端会丢掉注册表没声明过的 key，并按类型收敛）。 */
export async function saveNestFeatureSettings(
  featureId: string,
  values: Record<string, unknown>,
): Promise<NestSettings> {
  return asJson<NestSettings>(`/api/nest/features/${encodeURIComponent(featureId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
}

export type NestBrainConfig = {
  configured: boolean
  config: Record<string, string>
}

/** 该功能实际生效的配置（后端已把「全局默认 + 功能覆盖」合并好）。 */
export type NestEffectiveConfig = {
  feature_id: string
  name: string
  base_url: string
  api_key: string
  model: string
  vision_base_url: string
  vision_api_key: string
  vision_model: string
  needs_vision: boolean
  source: 'global_default' | 'feature_override'
  override: { id: string; name: string } | null
}

export async function fetchNestFeatures(): Promise<NestFeature[]> {
  const result = await asJson<{ items: NestFeature[] }>('/api/nest/features')
  return result.items || []
}
export async function fetchNestBrainDefault(): Promise<NestBrainConfig> {
  return asJson<NestBrainConfig>('/api/nest/api-config')
}
export async function saveNestBrainDefault(body: Record<string, string>): Promise<NestBrainConfig> {
  return asJson<NestBrainConfig>('/api/nest/api-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
export async function fetchNestFeatureConfig(featureId: string): Promise<NestEffectiveConfig> {
  return asJson<NestEffectiveConfig>(`/api/nest/features/${encodeURIComponent(featureId)}/api-config`)
}
export async function saveNestFeatureConfig(featureId: string, body: Record<string, unknown>): Promise<NestEffectiveConfig> {
  return asJson<NestEffectiveConfig>(`/api/nest/features/${encodeURIComponent(featureId)}/api-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
/** 删掉功能覆盖 → 回落「小窝大脑默认」。 */
export async function clearNestFeatureConfig(featureId: string, configId: string): Promise<NestEffectiveConfig> {
  return asJson<NestEffectiveConfig>(
    `/api/nest/features/${encodeURIComponent(featureId)}/api-config/${encodeURIComponent(configId)}`,
    { method: 'DELETE' },
  )
}

/** 「测一下路通不通」的一段：ok=false 时 hint 是「该去改哪里」。 */
export type NestApiCheck = {
  name: 'config' | 'stream' | 'complete' | 'vision'
  label: string
  ok: boolean
  /** 上游 HTTP 码；0 = 没走到上游（本地缺配置 / 连不上）。 */
  status: number
  detail: string
  hint: string
}

export type NestApiTestResult = {
  feature_id: string
  source: 'global_default' | 'feature_override' | ''
  base_url: string
  model: string
  /** 非空 = 建议把 Base URL 改成它再测（只补一个 /v1）。 */
  suggest_base_url: string
  ok: boolean
  checks: NestApiCheck[]
}

/** **真的发几个 token** 地测一遍这个功能的上游（不写库、不记账）。 */
export async function testNestFeatureApi(featureId: string): Promise<NestApiTestResult> {
  return asJson<NestApiTestResult>(
    `/api/nest/features/${encodeURIComponent(featureId)}/api-test`, { method: 'POST' },
  )
}

/** 功能动态流（§9.6）：独立功能把小糖人的产出推进来，小窝渲染成卡片。 */
export type NestFeedItem = {
  id: string
  feature_id: string
  kind: string
  title: string
  url: string
  summary: string
  cover: string
  payload: Record<string, unknown>
  status: 'new' | 'seen' | 'saved' | 'dismissed'
  created_at: string
}

export async function fetchNestFeed(params: { featureId?: string; status?: string; limit?: number } = {}): Promise<NestFeedItem[]> {
  const q = new URLSearchParams()
  if (params.featureId) q.set('feature_id', params.featureId)
  if (params.status) q.set('status', params.status)
  if (params.limit) q.set('limit', String(params.limit))
  const suffix = q.toString() ? `?${q}` : ''
  const result = await asJson<{ items: NestFeedItem[] }>(`/api/nest/feed${suffix}`)
  return result.items || []
}

export async function setNestFeedStatus(itemId: string, status: NestFeedItem['status']): Promise<void> {
  await asJson(`/api/nest/feed/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

export async function deleteNestFeedItem(itemId: string): Promise<void> {
  await asJson(`/api/nest/feed/${encodeURIComponent(itemId)}`, { method: 'DELETE' })
}

// ---- 在小窝里把独立功能跑起来（§9.6）----
// 前端只传「功能 id + 注册表里列出的子命令 + 白名单参数」，命令串由后端按注册表拼出。

export type NestRunResult = {
  ok: boolean
  running: boolean
  pid?: number
  exit_code?: number
  log?: string
  output?: string
  message?: string
}

export type NestRunStatus = {
  feature_id: string
  running: boolean
  pid: number
  command: string
  started_at: string
}

export type NestRunBody = {
  command: string
  limit?: number
  interval?: number
  character_ids?: string[]
  memory?: boolean
}

export async function runNestFeature(featureId: string, body: NestRunBody): Promise<NestRunResult> {
  return asJson<NestRunResult>(`/api/nest/features/${encodeURIComponent(featureId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function fetchNestRunStatus(featureId: string): Promise<NestRunStatus> {
  return asJson<NestRunStatus>(`/api/nest/features/${encodeURIComponent(featureId)}/run`)
}

/** 读功能最近的运行日志（后端按 utf-8 读，中文不会乱码 —— 终端里跑不出东西的那个毛病）。 */
export async function fetchNestRunLog(featureId: string, lines = 400): Promise<string> {
  const result = await asJson<{ log: string }>(
    `/api/nest/features/${encodeURIComponent(featureId)}/run-log?lines=${lines}`,
  )
  return result.log || ''
}

export async function stopNestFeature(featureId: string): Promise<{ ok: boolean; stopped: boolean; message?: string }> {
  return asJson(`/api/nest/features/${encodeURIComponent(featureId)}/run`, { method: 'DELETE' })
}

// ---- 外部网关（QQ 桥的 SnowLuma）----
// 桥连的是网关的 3001 端口；网关没开时桥只会每 5 秒报一次「拒绝连接」。
// 所以面板上直接给一个按钮，点一下由后端把 SnowLuma 起起来，等端口通了再回话。
// 只有注册表里声明了 runner.gateway 的功能才有，别处调会 404。

export type NestGatewayStatus = {
  feature_id: string
  label: string
  port: number
  online: boolean
  pid: number
  /** true = 这个进程是这次从小窝起的（重启大脑后就算 false，但端口在听仍然算在线）。 */
  started_by_nest: boolean
  /** 网关**现在**挂着的 QQ 号：问网关的 WebUI 得到（没填密码时退回日志）。空 = 一个都没挂上。 */
  uin: string
  /** 配置里写的机器人号（onebot.self_id）。和 uin 不一样 = 挂错号了。 */
  expected_uin: string
  /** 填了网关网页密码没有 —— 没填就只能提醒，不能自动换号。命令原文不回给前端。 */
  has_password: boolean
  log: string
  message: string
  /** 只有 start / claim 的返回里有。 */
  ok?: boolean
  waited?: number
  swap?: { ok: boolean; uin: string; changed: boolean; message: string }
}

export async function fetchNestGatewayStatus(featureId: string): Promise<NestGatewayStatus> {
  return asJson<NestGatewayStatus>(
    `/api/nest/features/${encodeURIComponent(featureId)}/gateway`,
  )
}

/** 开网关。后端最多等 60 秒（要注入 QQ、起 OneBot），前端按钮要转圈等着。 */
export async function startNestGateway(featureId: string): Promise<NestGatewayStatus> {
  return asJson<NestGatewayStatus>(
    `/api/nest/features/${encodeURIComponent(featureId)}/gateway/start`, { method: 'POST' },
  )
}

/** 关网关。只关得掉**从小窝起的**那个进程；别人手动开的后端会 409（不该去杀不属于自己的进程）。 */
export async function stopNestGateway(featureId: string): Promise<NestGatewayStatus> {
  return asJson<NestGatewayStatus>(
    `/api/nest/features/${encodeURIComponent(featureId)}/gateway/stop`, { method: 'POST' },
  )
}

/** 把网关的端口换给配置里的机器人号独占（同时登两个 QQ 时用）。换号要网关密码，慢，按钮要转圈等。 */
export async function claimNestGateway(featureId: string): Promise<NestGatewayStatus> {
  return asJson<NestGatewayStatus>(
    `/api/nest/features/${encodeURIComponent(featureId)}/gateway/claim`, { method: 'POST' },
  )
}

/** 「主要看什么」：大老大写给功能的方向说明。本体只存原文，怎么用是功能自己的事。 */
export type NestDirective = {
  feature_id: string
  look_for: string
  avoid: string
  updated_at: string
}

export async function fetchNestDirective(featureId: string): Promise<NestDirective> {
  return asJson<NestDirective>(`/api/nest/features/${encodeURIComponent(featureId)}/directive`)
}

export async function saveNestDirective(featureId: string, lookFor: string, avoid: string): Promise<NestDirective> {
  return asJson<NestDirective>(`/api/nest/features/${encodeURIComponent(featureId)}/directive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ look_for: lookFor, avoid }),
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

// ---- 这个身份的记忆挑选（§22.4）----
// 两池子：长期记忆（03 记忆池）+ 个人数据库 03 里已批准的真实信息。
// 没挑中 = 一条都不带，不兜底；挑中开着 = 强制注入；挑中关着 = 连召回也不要。

export type PersonaMemoryItem = {
  id: string
  text: string
  bucket: 'home' | 'personal'
  char_id: string
  created_at: string
  picked: boolean
  enabled: boolean
}

export type PersonaDbItem = {
  ref_id: string
  title: string
  content: string
  visible_to: string | string[]
  created_at: string
  picked: boolean
  enabled: boolean
}

export type PersonaPicks = {
  persona_id: string
  memories: PersonaMemoryItem[]
  database: PersonaDbItem[]
}

export async function fetchPersonaPicks(personaId: string): Promise<PersonaPicks> {
  return asJson<PersonaPicks>(`/api/profiles/${encodeURIComponent(personaId)}/memory-picks`)
}

/** 挑中 / 打开 / 关掉一条。kind = 'memory' | 'db'，refId 用 encodeURIComponent 包好。 */
export async function setPersonaPick(
  personaId: string,
  kind: 'memory' | 'db',
  refId: string,
  enabled: boolean,
): Promise<void> {
  await asJson(
    `/api/profiles/${encodeURIComponent(personaId)}/memory-picks/${kind}/${refId.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  )
}

/** 取消挑选（回到「没挑中」）。 */
export async function clearPersonaPick(
  personaId: string,
  kind: 'memory' | 'db',
  refId: string,
): Promise<void> {
  await asJson(
    `/api/profiles/${encodeURIComponent(personaId)}/memory-picks/${kind}/${refId.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'DELETE' },
  )
}

/** 删档案：后端会连这个身份名下的会话一起清掉（每个身份各自一条，§22）。 */
export async function deleteProfile(profileId: string): Promise<void> {
  await asJson(`/api/profiles/${profileId}`, { method: 'DELETE' })
}

// ── 自我档案（§23）──────────────────────────────────────────────────────────

export type SelfBlockMeta = {
  title: string
  inject: boolean
  visible_to: string | string[]
  created_at: string
  filename: string
  persona_id: string
  is_shared?: boolean
}

export type SelfBlock = SelfBlockMeta & { content: string }

/** 当前身份下所有区块元数据（不含正文）。 */
export async function fetchSelfBlocks(personaId: string): Promise<SelfBlockMeta[]> {
  return asJson<SelfBlockMeta[]>(`/api/self/status?persona_id=${encodeURIComponent(personaId)}`)
}

/** 读完整区块（包含正文）。 */
export async function fetchSelfBlock(personaId: string, filename: string): Promise<SelfBlock> {
  return asJson<SelfBlock>(`/api/self/${encodeURIComponent(personaId)}/${encodeURIComponent(filename)}`)
}

/** 保存区块（替换 frontmatter + 正文）。 */
export async function saveSelfBlock(
  personaId: string,
  filename: string,
  body: { title: string; inject: boolean; visible_to: string | string[]; content: string },
): Promise<SelfBlock> {
  return asJson<SelfBlock>(`/api/self/${encodeURIComponent(personaId)}/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 新建空白区块。 */
export async function createSelfBlock(personaId: string, title: string): Promise<SelfBlockMeta> {
  return asJson<SelfBlockMeta>(`/api/self/${encodeURIComponent(personaId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

/** 删除区块。 */
export async function deleteSelfBlock(personaId: string, filename: string): Promise<void> {
  await asJson(`/api/self/${encodeURIComponent(personaId)}/${encodeURIComponent(filename)}`, { method: 'DELETE' })
}

// ── 看提示词（§24）───────────────────────────────────────────────────────────

export type PromptDump = {
  model: string
  base_url: string
  max_tokens: number | null
  /** 与真正发给上游的一模一样：system 打头，其后是原始对话 */
  messages: { role: string; content: string }[]
  /** messages[0] 的正文（没有 system 块时为空串），方便前端默认只展示这一段 */
  system: string
}

export type PromptPreviewBody = {
  messages: { role: string; content: string }[]
  character_ids: string[]
  persona_id: string
  uncensored: boolean
}

/** 只组装、不调用模型（零 token 消耗）：核对自我档案 / 世界书 / 记忆进没进提示词。 */
export async function previewPrompt(body: PromptPreviewBody): Promise<PromptDump> {
  return asJson<PromptDump>('/api/chat/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type PersonalDbEntry = { path: string; name: string; kind: 'file' | 'directory'; extension: string; size: number | null; editable: boolean; content?: string | null; readonly?: boolean; sha256?: string; sheets?: {name:string;rows:number;columns:number;preview?:unknown[][]}[] }
export async function fetchPersonalDbTree(): Promise<PersonalDbEntry[]> { return asJson('/api/personal-db/tree') }
export async function fetchPersonalDbFile(path: string): Promise<PersonalDbEntry> { return asJson(`/api/personal-db/file?path=${encodeURIComponent(path)}`) }
export async function savePersonalDbFile(path: string, content: string, expected_sha256?: string): Promise<PersonalDbEntry> { return asJson('/api/personal-db/file', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, content, expected_sha256}) }) }
export async function fetchPersonalDbHistory(path: string): Promise<{path:string;name:string;size:number}[]> { return asJson(`/api/personal-db/history?path=${encodeURIComponent(path)}`) }
export async function restorePersonalDbVersion(path: string, version: string): Promise<void> { await asJson('/api/personal-db/restore', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,version})}) }
export async function createPersonalDbFile(path:string,content:string):Promise<PersonalDbEntry>{return asJson('/api/personal-db/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,content})})}
export async function renamePersonalDbFile(path:string,new_name:string):Promise<PersonalDbEntry>{return asJson('/api/personal-db/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,new_name})})}
export async function archivePersonalDbFile(path:string):Promise<void>{await asJson(`/api/personal-db/archive?path=${encodeURIComponent(path)}`,{method:'POST'})}
export async function movePersonalDbPath(path:string,destination:string):Promise<PersonalDbEntry>{return asJson('/api/personal-db/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,destination})})}
export async function renamePersonalDbFolder(path:string,new_name:string):Promise<PersonalDbEntry>{return asJson('/api/personal-db/rename-folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,new_name})})}
export async function copyToAiLayer(source:string,destination:string,title?:string):Promise<PersonalDbEntry>{return asJson('/api/personal-db/layer/copy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,destination,title})})}
export async function approveAiLayer(source:string,destination:string):Promise<PersonalDbEntry>{return asJson('/api/personal-db/layer/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,destination})})}

// ── 成果巡检（任务①，§28.1）─────────────────────────────────────────────────

export type HarvestEvent = {
  id: string
  kind: string
  source_path: string
  title: string
  date_done: string
  detected_at: string
  status: 'pending' | 'confirmed' | 'ignored'
  note: string
  card?: string
  index?: string
}

export type HarvestStatus = {
  enabled: boolean
  interval: number
  watch_dirs: string[]
  last_scan: string
  last_error: string
}

export async function fetchPatrolStatus(): Promise<HarvestStatus> { return asJson('/api/patrol/status') }
export async function fetchPatrolEvents(status?: string): Promise<HarvestEvent[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return asJson(`/api/patrol/events${qs}`)
}
export async function confirmPatrolEvent(id: string, body: { date_done?: string; title?: string }): Promise<HarvestEvent> {
  return asJson(`/api/patrol/confirm/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
export async function ignorePatrolEvent(id: string): Promise<HarvestEvent> {
  return asJson(`/api/patrol/ignore/${encodeURIComponent(id)}`, { method: 'POST' })
}
export async function setPatrolEventDate(id: string, date_done: string): Promise<HarvestEvent> {
  return asJson(`/api/patrol/events/${encodeURIComponent(id)}/date`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date_done }) })
}
export async function fetchWatchDirs(): Promise<{ watch_dirs: string[] }> { return asJson('/api/patrol/watch-dirs') }
export async function saveWatchDirs(watch_dirs: string[]): Promise<{ watch_dirs: string[] }> {
  return asJson('/api/patrol/watch-dirs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watch_dirs }) })
}
