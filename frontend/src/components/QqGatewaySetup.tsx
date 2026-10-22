import { useEffect, useState } from 'react'

type Diagnostic = { installed: boolean; folder: string; versions: string[]; old_qq: boolean; message: string; password_hint: string; install_supported: boolean }
type Release = { version: string; name: string; size: number; notes: string }
type AudioDiagnostic = { ready: boolean; checks: Record<string, boolean>; engine: string; fallback: string; instructions: string; note: string }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/qq-bridge/setup/' + path, {
    method: body ? 'POST' : 'GET', headers: { 'X-Exploration-Dashboard': '1', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || '检查失败')
  return data
}
export default function QqGatewaySetup({ onInstalled }: { onInstalled?: () => void }) {
  const [info, setInfo] = useState<Diagnostic | null>(null)
  const [release, setRelease] = useState<Release | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [passwordNotice, setPasswordNotice] = useState('')
  const [audio, setAudio] = useState<AudioDiagnostic | null>(null)
  const [audioError, setAudioError] = useState('')
  async function check() {
    try { setInfo(await api<Diagnostic>('diagnostics')) }
    catch (e) { setNote(String(e)) }
    try { setAudio(await api<AudioDiagnostic>('audio')); setAudioError('') }
    catch (e) { setAudioError('语音依赖检查失败：' + String(e)) }
  }
  useEffect(() => { void check() }, [])
  async function act(install: boolean) {
    setBusy(true)
    try {
      if (install && release && consent) {
        const result = await api<{ message: string }>('install', { consent: true, version: release.version })
        setNote(result.message); await check(); setRelease(null); setConsent(false); onInstalled?.()
      } else {
        setConsent(false); setRelease(await api<Release>('release'))
      }
    } catch (e) { setNote(String(e)) }
    finally { setBusy(false) }
  }
  return <div className="mb-3 rounded-xl border border-[var(--border)] p-3 text-xs leading-relaxed">
    <b>首次接入 / 连接不上？</b>
    <button className="btn ghost sm" disabled={busy} onClick={() => void check()}>检查安装与 QQ</button>
    {info && <>
      <p>{info.installed ? '已找到网关运行文件' : '配置目录中未找到完整网关（也可能安装在其他目录）'}：{info.folder}</p>
      <p>正在运行的 QQ：{info.versions.join('、') || '版本未知，请在 QQ 设置中核对'}。{info.message}</p>
      <p>{info.password_hint}</p>
      <button className="btn ghost sm" onClick={() => {
        if (passwordNotice) { setPasswordNotice(''); return }
        void api<{ notice: string }>('initial-password').then(r => setPasswordNotice(r.notice)).catch(e => setNote(String(e)))
      }}>{passwordNotice ? '隐藏密码提示' : '查看启动日志中的初始密码提示'}</button>
      {passwordNotice && <pre className="whitespace-pre-wrap break-words">{passwordNotice}</pre>}
      {!info.installed && <p>已安装？先在下方「接入方式」填写正确目录。尚未安装？
        <button className="btn ghost sm" disabled={busy || !info.install_supported} onClick={() => void act(false)}>查看官方版本并准备安装</button>
      </p>}
    </>}
    <a href="https://github.com/SnowLuma/SnowLuma/releases" target="_blank" rel="noreferrer">官方发行说明 / 手动下载</a>
    {audio && <div>
      <b>QQ 语音识别：{audio.ready ? '本地兜底依赖齐全' : '本地兜底尚未就绪'}</b>
      <p>当前引擎 {audio.engine}，QQ 失败后 {audio.fallback}。</p>
      <p>{Object.entries(audio.checks).map(([name, ready]) => `${name}：${ready ? '已找到' : '缺少'}`).join('；')}</p>
      {!audio.ready && <p>{audio.instructions}</p>}
      <p>{audio.note}</p>
    </div>}
    {audioError && <p role="status">{audioError}</p>}
    {release && <div>
      <p>待安装：{release.version} · {release.name} · {(release.size / 1024 / 1024).toFixed(1)} MB。将安装到小家 backend/data/gateways/SnowLuma，不覆盖已有目录，不自动执行。</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{release.notes}</pre>
      <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我同意从官方 GitHub 下载并安装第三方 SnowLuma 网关；网关协议由我首次启动时自行确认。</label>
      <button className="btn sm" disabled={busy || !consent} onClick={() => void act(true)}>{busy ? '下载安装中…' : '确认安装这个版本'}</button>
    </div>}
    <p>配置顺序：登录兼容版本的 QQ → 开网关 → 在网关网页完成初始化 → 在下方连接设置保存网页密码 → 读取已登录 QQ、选择账号并自动配置，再保存。网页密码与连接 token 是两回事；非专家模式的连接设置收在「连接修复」中。</p>
    {note && <p role="status">{note}</p>}
  </div>
}
