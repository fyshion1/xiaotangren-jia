/** 看提示词浮层（§24）：把「这条消息实际发给模型的东西」原样摊开。
 *
 * 调 /api/chat/preview —— 后端只组装、不调上游，零 token 消耗。
 * 用来核对自我档案 / 世界书 / 记忆到底进没进 system（改完档案不生效时先看这里）。
 *
 * 内容一律 whitespace-pre-wrap 直出，不做 Markdown 渲染 —— 与项目其他面板一致。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { previewPrompt, type PromptDump } from '../api/client'

type Props = {
  open: boolean
  onClose: () => void
  /** 当前会话在场角色 id */
  characterIds: string[]
  /** 当前用户身份 id（§22） */
  personaId: string
  /** 当前这条聊天线的历史消息（含刚打完还没发的那条也行） */
  messages: { role: string; content: string }[]
  /** 当前是否走无审查通道（§7）—— 决定要不要多注入无审查规则块 */
  uncensored: boolean
}

/** 把「角色名 → id」的展示做轻量一点：后端返回的是纯 JSON，这里只做高亮与折叠。 */
function RoleTag({ role }: { role: string }) {
  const cls =
    role === 'system'
      ? 'bg-[var(--pink-soft)] text-[var(--pink-deep)] border-[var(--pink)]'
      : role === 'user'
        ? 'bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--border-strong)]'
        : 'bg-[var(--surface-2)] text-[var(--text-2)] border-[var(--border-strong)]'
  return <span className={`rounded-md border px-1.5 py-0.5 text-[11px] ${cls}`}>{role}</span>
}

export default function PromptInspector({ open, onClose, characterIds, personaId, messages, uncensored }: Props) {
  const [dump, setDump] = useState<PromptDump | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')
  // 只看 system（默认）还是完整 messages 数组
  const [scope, setScope] = useState<'system' | 'all'>('system')

  // 请求体。依赖用「序列化后的字符串」而不是数组本身：父组件每次渲染都会新建
  // messages 数组，直接依赖它会让 useMemo 每帧都变 → effect 重新触发 → 无限循环。
  // 序列化时就把 key 写成后端要的蛇形，省得再转一次。
  const payloadKey = useMemo(
    () =>
      JSON.stringify({
        messages,
        character_ids: characterIds,
        persona_id: personaId,
        uncensored,
      }),
    [messages, characterIds, personaId, uncensored],
  )

  const run = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setDump(await previewPrompt(JSON.parse(payloadKey)))
    } catch (e) {
      setErr('组装失败：' + String(e))
    } finally {
      setLoading(false)
    }
  }, [payloadKey])

  // 每次打开（或换了会话 / 通道）重算一次，保证看到的就是现在这一刻会发的东西
  useEffect(() => {
    if (!open) return
    void run()
  }, [open, run])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const systemText = dump?.system ?? ''
  const fullText = dump ? JSON.stringify(dump.messages, null, 2) : ''

  const copy = async (what: 'system' | 'all') => {
    const text = what === 'system' ? systemText : fullText
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      setErr('复制失败，浏览器拒绝了剪贴板权限')
    }
  }

  const charCount = systemText.length
  // 粗估 token：中文约 1 字 ≈ 1 token，这个数只用来看「是不是哪块特别胖」
  const estTokens = Math.round(charCount * 1.0)

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 md:p-8" onClick={onClose}>
      <div
        className="flex h-full max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
          <span className="eyebrow">发给模型的提示词</span>
          <span className="flex items-center gap-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-0.5">
            {(['system', 'all'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={
                  'rounded-md px-2 py-0.5 text-[12px] ' +
                  (scope === s ? 'bg-[var(--pink)] text-white' : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]')
                }
              >
                {s === 'system' ? '系统提示词' : '完整消息数组'}
              </button>
            ))}
          </span>
          <span className="text-[11px] text-[var(--text-3)]">
            {charCount} 字 · 约 {estTokens} token
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <button className="btn sm" onClick={() => void run()} disabled={loading}>
              {loading ? '组装中…' : '↻ 重新组装'}
            </button>
            <button className="btn sm" onClick={() => void copy(scope)} disabled={!dump}>
              {copied ? '✅ 已复制' : '📋 复制'}
            </button>
            <button className="btn sm ghost" onClick={onClose}>
              ✕
            </button>
          </span>
        </header>

        <div className="border-b border-[var(--border)] px-4 py-2 text-[11px] leading-snug text-[var(--text-3)]">
          这里显示的是<b>此刻</b>发这条消息会送上去的内容（不消耗 token，不会真的调用模型）。
          若改完档案没生效：先看下面 system 里有没有你要的那段；
          没有 → 那块多半是 <b>inject 没打开</b> 或 可见范围没勾当前角色。
        </div>

        {err && <p className="err-tip mx-4 mt-3">{err}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!dump && !err && <p className="text-[13px] text-[var(--text-3)]">组装中…</p>}

          {dump && scope === 'system' && (
            <pre className="whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text)]">
              {systemText || '（本次没有 system 块）'}
            </pre>
          )}

          {dump && scope === 'all' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3)]">
                <span>上游：{dump.base_url}</span>
                <span>·</span>
                <span>模型：{dump.model}</span>
                <span>·</span>
                <span>max_tokens：{dump.max_tokens ?? '不限'}</span>
                <span>·</span>
                <span>共 {dump.messages.length} 条</span>
              </div>
              {dump.messages.map((m, i) => (
                <div key={i} className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <RoleTag role={m.role} />
                    <span className="text-[11px] text-[var(--text-3)]">{m.content.length} 字</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[var(--text)]">
                    {m.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-3)]">
          💡 这里的内容就是后端「此刻组装出来」的那一份，与你真发一条消息时发的完全一致 —— 只是没花 token。
        </footer>
      </div>
    </div>
  )
}
