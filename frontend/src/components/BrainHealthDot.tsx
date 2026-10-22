import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchHealth, restartBrain, type BrainHealth } from '../api/client'

// 灯自己轮询，避免把顶栏做成「有状态的组件树」。
const POLL_MS = 5000
// 重启期间查得勤一点 —— 这几秒正是用户盯着看的时候。
const RESTART_POLL_MS = 800
// 超过这么久还没报上新 pid，就直说没起来，别让人一直等。
const RESTART_TIMEOUT_MS = 60_000

type Phase = 'alive' | 'down' | 'restarting' | 'stuck'

function humanUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

/**
 * 顶栏那颗「大脑活着没有」的灯 + 一键重启（Block 二 ①）。
 *
 * 三件事：
 *  - 灯：后端连不上时**不会假装还活着**（这是 Block 二 ③ 的同一条规矩），
 *    而是变灰说「大脑没响应」；
 *  - 一键重启：先记下当前 pid，重启完**必须看到新 pid 才算好** ——
 *    接口本身几乎总能回 200，光看返回值会误判；
 *  - 重启窗口里后端本来就是断的，所以那一两秒的失败不算错，是流程的一部分。
 */
export default function BrainHealthDot() {
  const [phase, setPhase] = useState<Phase>('down')
  const [health, setHealth] = useState<BrainHealth | null>(null)
  const [note, setNote] = useState('')

  // 重启时会换 pid，拿它当「真的是新的那一个」的凭据。
  const oldPidRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)
  const busyRef = useRef(false)

  const probe = useCallback(async () => {
    const expired = () => {
      if (!busyRef.current || Date.now() - startedAtRef.current < RESTART_TIMEOUT_MS) return false
      busyRef.current = false
      oldPidRef.current = null
      setPhase('stuck')
      setNote('重启超时，请查看 backend/logs/ 中的重启日志')
      return true
    }
    if (expired()) return false
    try {
      const info = await fetchHealth()
      if (expired()) return false
      // 重启中：还是老 pid 说明新进程没接手，继续等。
      if (oldPidRef.current !== null && info.pid === oldPidRef.current) return false
      if (busyRef.current) {
        oldPidRef.current = null
        busyRef.current = false
        setNote('大脑已经换新的了')
        window.setTimeout(() => setNote(''), 4000)
      }
      setHealth(info)
      setPhase('alive')
      return true
    } catch {
      if (expired()) return false
      // 没连上 ≠ 没响应的时候也要分清楚：正在重启的话这是预期内的。
      if (busyRef.current) {
        return false
      }
      setPhase('down')
      return false
    }
  }, [])

  useEffect(() => {
    let timer = 0
    let cancelled = false
    const tick = async () => {
      await probe()
      if (cancelled) return
      timer = window.setTimeout(tick, busyRef.current ? RESTART_POLL_MS : POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [probe])

  const onRestart = async () => {
    if (busyRef.current) return
    busyRef.current = true
    oldPidRef.current = health?.pid ?? null
    startedAtRef.current = Date.now()
    setPhase('restarting')
    setNote('')
    try {
      await restartBrain()
    } catch (err) {
      // 500 = 中间人没叫起来，**当前这个大脑还在跑**，别把人吓着。
      busyRef.current = false
      oldPidRef.current = null
      setPhase('down')
      setNote(err instanceof Error ? `重启没发出去：${err.message}` : '重启没发出去')
    }
  }

  const dot =
    phase === 'alive' ? 'bg-emerald-500'
      : phase === 'restarting' ? 'animate-pulse bg-amber-400'
        : 'bg-[var(--text-3)]'

  const label =
    phase === 'alive' ? '大脑在线'
      : phase === 'restarting' ? '正在重启…'
        : phase === 'stuck' ? '重启好像没成功'
          : '大脑没响应'

  const tip =
    health && phase === 'alive'
      ? `已运行 ${humanUptime(health.uptime_seconds)}（pid ${health.pid}，${health.started_at} 起来）`
      : label

  return (
    // 手机端（§28 起布局固定）顶栏本来就紧，这里整体不占位；桌面端才出现。
    <div className="hidden min-w-0 shrink-0 items-center gap-1.5 sm:flex">
      <span
        title={tip}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text-2)] sm:px-3.5"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="hidden sm:inline">{label}</span>
      </span>
      <button
        onClick={() => void onRestart()}
        disabled={phase === 'restarting'}
        title="重启后端大脑（不动前端，几秒后自己会好）"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text-2)] transition hover:border-[var(--pink)] hover:text-[var(--pink-deep)] disabled:opacity-50 sm:px-3.5"
      >
        🔄
        <span className="hidden sm:inline">{phase === 'restarting' ? '重启中' : '重启大脑'}</span>
      </button>
      {note && (
        <span className="hidden max-w-[16rem] truncate text-[12px] text-[var(--text-3)] lg:inline" title={note}>
          {note}
        </span>
      )}
    </div>
  )
}
