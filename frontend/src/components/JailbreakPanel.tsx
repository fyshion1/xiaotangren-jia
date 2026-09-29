import { useCallback, useEffect, useState } from 'react'
import { fetchSettings, saveSettings } from '../api/client'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

export default function JailbreakPanel() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    fetchSettings()
      .then((s) => {
        if (alive) setText(s.jailbreak ?? '')
      })
      .catch(() => {
        /* ignore */
      })
    return () => {
      alive = false
    }
  }, [])

  const save = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await saveSettings({ jailbreak: text })
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [text])

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[20px] font-extrabold tracking-wide">规则 / 越狱</h2>
        <span className="text-[13px] text-[var(--text-3)]">Jailbreak · 可选，默认为空</span>
      </div>

      <p className="mb-4 rounded-[14px] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-2.5 text-[13px] text-[var(--text-2)]">
        这里是一个可编辑的「规则 / 越狱」文本框，内容会追加到最终 System Prompt 之后。<b>默认留空即可</b>
        ——你走第三方无审查中转时模型侧本就不审查，纯人设就够用。只有切到商业官方 API（OpenAI / Claude /
        Gemini 官方）才可能需要在这里填一段越狱 preset；且随模型更新可能失效。
      </p>

      <Field label="越狱 / 规则文本">
        <textarea
          className="textarea"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="留空 = 纯人设。需要时在此粘贴你的 preset…"
        />
      </Field>

      <div className="mt-3 flex items-center gap-3">
        <button className="btn sm" onClick={save} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        {saved && <span className="text-[13px] text-[var(--mint)]">已保存</span>}
        {error && <span className="text-[13px] text-[var(--pink-deep)]">⚠ {error}</span>}
      </div>
    </section>
  )
}