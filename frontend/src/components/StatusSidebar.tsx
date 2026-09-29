import type { CharacterProfile } from '../data/characters'
import type { ChatSession, CharacterStatus } from '../data/chats'
import { DEFAULT_STATUS } from '../data/chats'

type Props = {
  session: ChatSession
  characters: CharacterProfile[]
}

export default function StatusSidebar({ session, characters }: Props) {
  const members = session.characterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is CharacterProfile => Boolean(c))
  const single = members.length === 1 ? members[0] : null
  const status: CharacterStatus | undefined = single ? DEFAULT_STATUS[single.id] : undefined

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-3 text-[12px] font-semibold tracking-wide text-[var(--text-3)]">状态</div>

      {/* 操作空壳：打电话 / 生成照片 / 播放语音 */}
      <div className="grid grid-cols-3 gap-2 px-4">
        <button className="status-action" title="空壳功能（阶段 3）">
          <span className="text-[16px]">📞</span>打电话
        </button>
        <button className="status-action" title="空壳功能（阶段 3）">
          <span className="text-[16px]">🎨</span>生成照片
        </button>
        <button className="status-action" title="空壳功能（阶段 3）">
          <span className="text-[16px]">🔊</span>播放语音
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {single && status ? (
          <>
            {/* 羁绊 & 渴望 */}
            <div className="status-box">
              <div className="mb-1 flex items-center justify-between text-[12px] text-[var(--text-2)]">
                <span>羁绊</span>
                <span className="font-semibold text-[var(--pink-deep)]">{status.bond}/100</span>
              </div>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${status.bond}%` }} />
              </div>
              <div className="mt-3 text-[12px] text-[var(--text-2)]">
                渴望：<span className="text-[var(--text)]">{status.desire}</span>
              </div>
            </div>

            {/* 她现在的样子（右下角状态） */}
            <div className="status-box mt-3">
              <div className="status-title">她现在的样子</div>
              <div className="status-row">
                <span>心情</span>
                <span>{status.mood}</span>
              </div>
              <div className="status-row">
                <span>地点</span>
                <span>{status.location}</span>
              </div>
              <div className="status-row">
                <span>与你的关系</span>
                <span>{status.relation}</span>
              </div>
              <p className="mt-2 text-[11px] leading-snug text-[var(--text-3)]">＊ 壳子：后续可据上下文动态读取（阶段 2 记忆/状态）</p>
            </div>
          </>
        ) : members.length > 1 ? (
          <div className="status-box">
            <div className="status-title">成员状态</div>
            {members.map((m) => {
              const st = DEFAULT_STATUS[m.id]
              if (!st) return null
              return (
                <div key={m.id} className="status-row">
                  <span>
                    {m.emoji} {m.name}
                  </span>
                  <span>
                    {st.mood} · {st.location}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="status-box">
            <div className="status-title">角色卡</div>
            <p className="text-[12px] leading-snug text-[var(--text-3)]">导入的角色卡暂无人设解析（阶段 2），先占位。</p>
          </div>
        )}
      </div>
    </div>
  )
}