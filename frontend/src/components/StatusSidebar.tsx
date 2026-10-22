import UiIcon from '../visual/UiIcon'
import type { CharacterProfile } from '../data/characters'
import type { ChatSession, CharacterStatus } from '../data/chats'
import { DEFAULT_STATUS } from '../data/chats'

/** 状态栏里的一个快捷入口（§27.5）。 */
export type SidebarAction = {
  key: string
  icon: string
  label: string
  /** 当前是「开着」的开关（自动记忆 / 多选删除 / 无审查通道）→ 高亮 */
  on?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

type Props = {
  session: ChatSession
  characters: CharacterProfile[]
  onVoiceCall: () => void
  onVideoCall: () => void
  voiceName: string
  onPickVoice: () => void
  onGeneratePhoto: () => void
  /**
   * 手机端专属的「快捷」按钮组（§27.5）。
   *
   * 桌面顶栏那一排（成员 / 提示词 / 记忆 / 画廊 / 删除 / 自动记忆 / 通话 / 设置 / 通道）
   * 整块包在 `hidden … md:flex` 里，手机上一个都摸不到 —— 这里把它们挪进「状态」这个
   * 本来就有的 Tab，省得再为手机单独开一个抽屉。
   *
   * 只在手机上渲染（`md:hidden`）：桌面端顶栏已经有同样一套，重复铺一遍只是噪音。
   * 判断宽窄这件事收在这个组件里、不往外漏 —— ChatView 只管把动作表递进来。
   */
  actions?: SidebarAction[]
}

export default function StatusSidebar({
  session,
  characters,
  onVoiceCall,
  onVideoCall,
  voiceName,
  onPickVoice,
  onGeneratePhoto,
  actions = [],
}: Props) {
  const members = session.characterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter((c): c is CharacterProfile => Boolean(c))
  const single = members.length === 1 ? members[0] : null
  const status: CharacterStatus | undefined = single ? DEFAULT_STATUS[single.id] : undefined

  return (
    // min-h-0 flex-1 而不是 h-full（§19.21）：h-full 是按「整栏高度」算的，
    // 不扣掉上面那个立绘轮播（shrink-0），于是内部滚动区的可用高度被高估、
    // 下半截落到父级 overflow-hidden 之外被裁掉 —— 手机上看着就是「滑到底了但下面还有字」。
    <div className="flex min-h-0 shrink-0 flex-col md:flex-1 md:overflow-y-auto">
      <div className="px-4 pb-2 pt-3 text-[12px] font-semibold tracking-wide text-[var(--text-3)]">状态</div>

      {/* 操作：生成照片 / 朗读·停止 / 自动朗读 */}
      {!session.sandbox && <div className="grid grid-cols-3 gap-2 px-4">
        <button className="status-action" onClick={onGeneratePhoto} title="生成照片">
          <span className="text-[16px]">🎨</span>生成照片
        </button>
        <button className="status-action" onClick={onVoiceCall} title="语音通话"><UiIcon name="phone"/>语音通话</button>
        <button className="status-action" onClick={onVideoCall} title="视频通话"><UiIcon name="video"/>视频通话</button>
      </div>}

      {/* 引擎+音色切换 */}
      {!session.sandbox && <div className="mt-2 px-4">
        <button
          onClick={onPickVoice}
          className="w-full rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[12px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)]"
        >
          🗣 语音：{voiceName}
        </button>
      </div>}

      {/* 手机端快捷入口（§27.5）：桌面顶栏那一排在这儿的等价物 */}
      {actions.length > 0 && (
        <div className="mt-3 px-4 md:hidden">
          <div className="eyebrow mb-1.5">快捷</div>
          <div className="grid grid-cols-4 gap-1.5">
            {actions.map((a) => (
              <button
                key={a.key}
                onClick={a.onClick}
                disabled={a.disabled}
                aria-pressed={a.on}
                title={a.title ?? a.label}
                className={`status-action disabled:opacity-40 ${a.on ? 'on' : ''}`}
              >
                <span className="text-[15px]">{a.icon}</span>
                <span className="text-[11px] leading-tight">{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3">
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
        ) : single ? (
          /* 私聊一位，但不是自家四位：羁绊 / 心情 / 地点那套是写死的壳子（DEFAULT_STATUS），
             对导入进来的角色没有意义 —— 硬套一个假数值不如不显示。改成摊开卡里的原词条：
             都是导入时从原文抽出来、用户能在 ✎ 编辑资料里改的，一个字不编。 */
          <div className="status-box">
            <div className="status-title">{single.name} · 卡里的词条</div>
            {(
              [
                ['别名', single.alias],
                ['职业', single.occupation],
                ['生日', single.birthday],
                ['年龄', single.age],
                ['身高', single.height],
                ['关系', single.relationships],
              ] as [string, string | undefined][]
            )
              .filter(([, v]) => (v || '').trim())
              .map(([label, v]) => (
                <div key={label} className="status-row">
                  <span>{label}</span>
                  <span className="text-right">{v}</span>
                </div>
              ))}
            {single.catchphrase?.trim() && (
              <div className="mt-2 text-[12px] leading-snug text-[var(--text-2)]">
                口头禅：<span className="text-[var(--text)]">{single.catchphrase}</span>
              </div>
            )}
            <p className="mt-2 text-[11px] leading-snug text-[var(--text-3)]">
              ＊ 到这儿来的角色：羁绊 / 心情那套数值只给自家四位算，她这儿就照原文摆词条。
            </p>
          </div>
        ) : (
          <div className="status-box">
            <div className="status-title">状态</div>
            <p className="text-[12px] leading-snug text-[var(--text-3)]">这一条会话还没有在场角色 —— 去成员面板勾一位。</p>
          </div>
        )}
      </div>
    </div>
  )
}
