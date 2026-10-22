import { useEffect, useRef, useState } from 'react'
import { VoiceCall, type VoiceSetup } from '../lib/voiceCall'

type Capabilities = { asr_provider: string; asr_model: string; asr_region: string; bailian_configured: boolean; soniox_configured: boolean; fish_configured: boolean; fish_model: string; voice_id: string; local_asr_ready: boolean; piper_voices: string[]; cosyvoice_ready: boolean; cosyvoice_speakers: string[]; kokoro_ready?: boolean; kokoro_speakers?: string[] }
type Props = {
  name: string
  setup: Pick<VoiceSetup, 'character_id' | 'persona_id' | 'session_id' | 'base_url' | 'api_key' | 'model' | 'max_tokens' | 'uncensored' | 'auto_memory'>
  onClose: () => void
  onHistory: () => void
}
const inputClass = 'w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm'

export default function VoiceCallPanel({ name, setup, onClose, onHistory }: Props) {
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [provider, setProvider] = useState('bailian')
  const [asrModel, setAsrModel] = useState('qwen-audio-3.1-asr-flash-streaming')
  const [region, setRegion] = useState('beijing')
  const [asrKey, setAsrKey] = useState('')
  const [fishKey, setFishKey] = useState('')
  const [fishModel, setFishModel] = useState('s2.1-pro-free')
  const [ttsProvider, setTtsProvider] = useState('piper')
  const [cosyPlayback, setCosyPlayback] = useState<'smooth' | 'stream'>('smooth')
  const [voice, setVoice] = useState('')
  const [status, setStatus] = useState('配置通话')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [starting, setStarting] = useState(false)
  const [muted, setMuted] = useState(false)
  const [hearing, setHearing] = useState('')
  const [said, setSaid] = useState('')
  const [answer, setAnswer] = useState('')
  const [typed, setTyped] = useState('')
  const [suspended, setSuspended] = useState(false)
  const call = useRef<VoiceCall | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const closePanel = useRef(onClose)
  closePanel.current = onClose
  const mounted = useRef(true)
  const history = useRef(onHistory)
  history.current = onHistory

  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    fetch('/api/voice/call/config', { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error('无法读取语音配置，请重启后端后重试')
      return r.json() as Promise<Capabilities>
    }).then(data => {
      if (!mounted.current) return
      setCaps(data); setProvider(data.local_asr_ready ? 'local' : data.asr_provider); setAsrModel(data.asr_provider === 'soniox' ? 'stt-rt-v3' : data.asr_model)
      setRegion(data.asr_region); setFishModel(data.fish_model)
      setTtsProvider(data.piper_voices.length ? 'piper' : 'fish')
      setVoice(data.piper_voices[0] || data.voice_id)
    }).catch(e => { if (mounted.current && e.name !== 'AbortError') setError(e.message) })
    return () => { mounted.current = false; abort.abort(); call.current?.close(); history.current() }
  }, [setup.character_id])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); call.current?.close(); closePanel.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])]
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (!first) return
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); previous?.focus() }
  }, [])

  const connect = async () => {
    if (starting || connected) return
    setError(''); setStarting(true); setStatus('正在连接…'); setAnswer(''); setSaid(''); setHearing('')
    const client = new VoiceCall(event => {
      if (!mounted.current || call.current !== client) return
      switch (event.type) {
        case 'ready': setConnected(true); setStarting(false); setMuted(false); setStatus('正在听'); break
        case 'transcript': setHearing(event.final ? '' : event.text || ''); if (!event.final) setStatus('正在听'); break
        case 'reply-start': setSaid(event.text || ''); setAnswer(''); setStatus('正在想'); break
        case 'delta': setAnswer(old => old + (event.text || '')); break
        case 'synthesizing': setStatus('正在准备声音'); break
        case 'audio-start': setStatus('正在说'); break
        case 'done': setStatus('正在听'); break
        case 'interrupted': setStatus('正在听'); break
        case 'history': history.current(); break
        case 'error': setError(event.message || '本轮未完成'); setStatus('正在听'); break
        case 'suspended': setSuspended(true); break
        case 'fatal': setError(event.message || '通话中断'); setConnected(false); setStarting(false); setStatus('通话已结束'); history.current(); break
      }
    })
    call.current?.close()
    call.current = client
    try {
      if (ttsProvider === 'fish') localStorage.setItem(`xiaotangren.voice.${setup.character_id}`, voice.trim())
    } catch { /* storage may be unavailable */ }
    try {
      await client.start({ ...setup, asr_provider: provider, asr_key: asrKey.trim(), asr_model: asrModel.trim(), asr_region: region,
        fish_key: fishKey.trim(), fish_model: fishModel, voice_id: voice.trim(), tts_provider: ttsProvider, cosyvoice_playback: cosyPlayback })
    } catch (e) {
      if (mounted.current && call.current === client) { setStarting(false); setStatus('未能接通'); setError(e instanceof Error ? e.message : '无法开启麦克风') }
    }
  }
  const hangup = () => {
    call.current?.close(); call.current = null; setConnected(false); setStarting(false); setHearing(''); setStatus('通话已结束'); history.current()
  }
  const missing = !caps || (provider === 'local' ? !caps.local_asr_ready : !(asrKey.trim() || (provider === 'bailian' ? caps.bailian_configured : caps.soniox_configured)) || !asrModel.trim())
    || (ttsProvider === 'fish' && !(fishKey.trim() || caps.fish_configured)) || !voice.trim()

  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm">
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`与${name}语音通话`} className="flex max-h-[94dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-2xl outline-none">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div><h2 className="font-bold">和{name}通话</h2><p role="status" className="mt-1 text-xs text-[var(--text-3)]">{muted && connected ? '麦克风已静音 · ' : ''}{status}</p></div>
        <button type="button" className="rounded-full px-3 py-2" onClick={() => { hangup(); onClose() }} aria-label="关闭语音通话">✕</button>
      </header>
      <div className="space-y-4 overflow-y-auto p-5">
        {!connected && !starting && <div className="space-y-3">
          <p className="text-sm text-[var(--text-2)]">接通后直接说话，说完她会自动回答。你随时可以开口打断她。</p>
          <label className="block text-xs">语音识别<select className={inputClass} value={provider} onChange={e => { setProvider(e.target.value); setAsrKey(''); setAsrModel(e.target.value === 'soniox' ? 'stt-rt-v3' : caps?.asr_model || 'qwen-audio-3.1-asr-flash-streaming') }}>
            {caps?.local_asr_ready && <option value="local">本地 Paraformer（中英）</option>}<option value="bailian">阿里云百炼</option><option value="soniox">Soniox</option>
          </select></label>
          {provider !== 'local' && <label className="block text-xs">识别模型<input className={inputClass} value={asrModel} onChange={e => setAsrModel(e.target.value)} /></label>}
          {provider === 'bailian' && <label className="block text-xs">密钥地域<select className={inputClass} value={region} onChange={e => setRegion(e.target.value)}><option value="beijing">北京</option><option value="singapore">新加坡</option></select></label>}
          {provider !== 'local' && <label className="block text-xs">识别 API Key<input type="password" autoComplete="off" className={inputClass} value={asrKey} onChange={e => setAsrKey(e.target.value)} placeholder={(provider === 'bailian' ? caps?.bailian_configured : caps?.soniox_configured) ? '服务器已配置，留空沿用' : '填写服务商的 API Key'} /></label>}
          <label className="block text-xs">语音合成<select className={inputClass} value={ttsProvider} onChange={e => { const next = e.target.value; setTtsProvider(next); setVoice(next === 'piper' ? caps?.piper_voices[0] || '' : next === 'fish' ? localStorage.getItem(`xiaotangren.voice.${setup.character_id}`) || caps?.voice_id || '' : next === 'kokoro' ? caps?.kokoro_speakers?.[0] || '' : caps?.cosyvoice_speakers[0] || '') }}>
            {!!caps?.piper_voices.length && <option value="piper">Piper 本地</option>}{caps?.cosyvoice_ready && <option value="cosyvoice">CosyVoice 本机服务</option>}{caps?.kokoro_ready && <option value="kokoro">Kokoro 本机（中文女声）</option>}<option value="fish">Fish Audio</option>
          </select></label>
          {ttsProvider === 'fish' && <label className="block text-xs">Fish Audio API Key<input type="password" autoComplete="off" className={inputClass} value={fishKey} onChange={e => setFishKey(e.target.value)} placeholder={caps?.fish_configured ? '服务器已配置，留空沿用' : '填写 Fish Audio API Key'} /></label>}
          {ttsProvider === 'fish' && <>
          <label className="block text-xs">Fish 模型<select className={inputClass} value={fishModel} onChange={e => setFishModel(e.target.value)}>
            <option value="s2.1-pro-free">S2.1 Pro Free</option><option value="s2.1-pro">S2.1 Pro（付费）</option><option value="drama-3">Drama 3（付费）</option><option value="s2-pro">S2 Pro（付费）</option><option value="s1">S1（付费）</option>
          </select></label>
          <label className="block text-xs">{name}的 Fish 音色 ID<input className={inputClass} value={voice} onChange={e => setVoice(e.target.value)} placeholder="从 Fish 音色页面复制 ID" /></label></>}
          {ttsProvider === 'piper' && <label className="block text-xs">本地音色<select className={inputClass} value={voice} onChange={e => setVoice(e.target.value)}>{caps?.piper_voices.map(v => <option key={v} value={v}>{{'zh_CN-huayan-medium': '华燕 · 女声', 'zh_CN-xiao_ya-medium': '小雅 · 女声', 'zh_CN-chaowen-medium': '超文 · 男声'}[v] || v}</option>)}</select></label>}
          {ttsProvider === 'kokoro' && <label className="block text-xs">Kokoro 音色<select className={inputClass} value={voice} onChange={e => setVoice(e.target.value)}>{caps?.kokoro_speakers?.map(v => <option key={v} value={v}>{v}</option>)}</select><span className="block mt-1">本地按句合成，再连续播放；支持打断。</span></label>}
          {ttsProvider === 'cosyvoice' && <><label className="block text-xs">CosyVoice 音色<select className={inputClass} value={voice} onChange={e => setVoice(e.target.value)}>{caps?.cosyvoice_speakers.map(v => <option key={v} value={v}>{v}</option>)}</select></label><label className="block text-xs">播放方式<select className={inputClass} value={cosyPlayback} onChange={e => setCosyPlayback(e.target.value as 'smooth' | 'stream')}><option value="smooth">平滑播放（先准备一句，再连续播放）</option><option value="stream">边生成边播（首声较早，可能断续）</option></select></label><p className="text-xs text-amber-700">本机生成速度慢于播放速度。平滑模式减少句内卡顿，但等待更久，句间仍可能停顿；两种模式都能随时打断。</p></>}
          <p className="text-xs leading-relaxed text-[var(--text-3)]">本地识别与合成不收语音 API 费用；聊天模型仍按所选服务计费。云端密钥仅用于本次通话。</p>
        </div>}
        {(connected || starting || answer || said) && <div className="space-y-3" aria-live="polite">
          {(hearing || said) && <div className="rounded-2xl bg-[var(--bg)] p-3 text-sm"><span className="text-xs text-[var(--text-3)]">你{hearing ? '正在说' : '说'}</span><p className="mt-1 whitespace-pre-wrap">{hearing || said}</p></div>}
          {answer && <div className="rounded-2xl border border-[var(--border)] p-3 text-sm"><span className="text-xs text-[var(--text-3)]">{name}</span><p className="mt-1 whitespace-pre-wrap">{answer}</p></div>}
        </div>}
        {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-600">{error}</p>}
        {suspended && connected && <button className={inputClass} onClick={() => void call.current?.resume().then(() => setSuspended(false))}>恢复声音</button>}
        {connected && <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (typed.trim()) { call.current?.sendText(typed); setTyped('') } }}>
          <input className={inputClass} value={typed} maxLength={16000} onChange={e => setTyped(e.target.value)} placeholder="也可以打字告诉她…" aria-label="通话中发送文字" />
          <button type="submit" className="shrink-0 rounded-xl border border-[var(--border)] px-3">发送</button>
        </form>}
      </div>
      <footer className="flex shrink-0 justify-center gap-3 border-t border-[var(--border)] p-4">
        {connected ? <>
          <button className="rounded-full border border-[var(--border)] px-4 py-3 text-sm" onClick={() => setMuted(value => { call.current?.setMuted(!value); return !value })}>{muted ? '开启麦克风' : '静音'}</button>
          <button className="rounded-full border border-[var(--border)] px-4 py-3 text-sm" onClick={() => call.current?.interrupt()}>停一下</button>
          <button className="rounded-full bg-red-500 px-5 py-3 text-sm text-white" onClick={hangup}>挂断</button>
        </> : starting ? <button className="rounded-full bg-red-500 px-6 py-3 text-sm text-white" onClick={hangup}>取消拨打</button>
          : <button className="rounded-full bg-emerald-600 px-8 py-3 text-sm text-white disabled:opacity-40" disabled={!!missing} onClick={() => void connect()}>开始通话</button>}
      </footer>
    </section>
  </div>
}
