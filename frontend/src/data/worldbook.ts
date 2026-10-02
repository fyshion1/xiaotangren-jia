// 世界书词条模型（World Info / 知识库）。
// 触发方式：聊天最近几轮出现「keywords」里的任意关键词 → 注入该词条正文。

export type WorldbookEntry = {
  id: string
  title: string
  keywords: string // 逗号分隔，可多词
  content: string
  enabled: boolean
  priority: number
  /** 归属（§19）：'' = 家共用（群聊用），<角色 id> = 那位角色的专属 */
  owner: string
  updated_at: string
}

export function keywordList(entry: WorldbookEntry): string[] {
  return (entry.keywords || '')
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}