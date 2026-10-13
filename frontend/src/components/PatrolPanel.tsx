/** 巡检面板（任务①）：私人空间里「成果收录」待确认卡片。
 *
 * 后台低频轮询「成果」目录，发现新文件就弹一张卡：
 * [文件名 · 检测时间 · ✎改日期] → ✓ 收录 / ✗ 忽略。
 * 收录后写成 02 工作层成果卡 + 年表索引；忽略后不再提醒。
 * 不改底部导航与整体布局，只在私人空间加一个可滚动区块。
 */

import { useEffect, useState, useCallback } from 'react'
import {
  fetchPatrolStatus,
  fetchPatrolEvents,
  confirmPatrolEvent,
  ignorePatrolEvent,
  setPatrolEventDate,
  fetchWatchDirs,
  saveWatchDirs,
  type HarvestEvent,
  type HarvestStatus,
} from '../api/client'

export default function PatrolPanel() {
  const [events, setEvents] = useState<HarvestEvent[]>([])
  const [status, setStatus] = useState<HarvestStatus | null>(null)
  const [watchDirs, setWatchDirs] = useState<string[]>([])
  const [dirInput, setDirInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [evs, st, wd] = await Promise.all([
        fetchPatrolEvents(),
        fetchPatrolStatus(),
        fetchWatchDirs(),
      ])
      setEvents(evs)
      setStatus(st)
      setWatchDirs(wd.watch_dirs ?? [])
    } catch (e) {
      setErr('加载失败：' + String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const pending = events.filter((e) => e.status === 'pending')

  const handleConfirm = async (ev: HarvestEvent) => {
    setErr('')
    try {
      await confirmPatrolEvent(ev.id, { date_done: ev.date_done, title: ev.title })
      void load()
    } catch (e) {
      setErr('收录失败：' + String(e))
    }
  }

  const handleIgnore = async (ev: HarvestEvent) => {
    setErr('')
    try {
      await ignorePatrolEvent(ev.id)
      void load()
    } catch (e) {
      setErr('忽略失败：' + String(e))
    }
  }

  const handleDateChange = async (ev: HarvestEvent, dateDone: string) => {
    setErr('')
    try {
      await setPatrolEventDate(ev.id, dateDone)
      void load()
    } catch (e) {
      setErr('改日期失败：' + String(e))
    }
  }

  const addDir = async () => {
    const rel = dirInput.trim().replace(/^[\\/]+|[\\/]+$/g, '')
    if (!rel) return
    setErr('')
    try {
      const next = await saveWatchDirs([...watchDirs, rel])
      setWatchDirs(next.watch_dirs)
      setDirInput('')
    } catch (e) {
      setErr('添加目录失败：' + String(e))
    }
  }

  const removeDir = async (rel: string) => {
    setErr('')
    try {
      const next = await saveWatchDirs(watchDirs.filter((w) => w !== rel))
      setWatchDirs(next.watch_dirs)
    } catch (e) {
      setErr('移除目录失败：' + String(e))
    }
  }

  return (
    <section className="self-profile-panel">
      <div className="panel-header">
        <span className="eyebrow">巡检 · 成果收录</span>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[var(--text-3)]">
            {status?.last_scan ? `上次扫描 ${status.last_scan}` : ''}
          </span>
          <button className="btn sm ghost" onClick={() => void load()} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {err && <p className="err-tip">{err}</p>}

      {/* 监测目录：可自己换 / 增删（你希望「自己选盯哪个文件夹」） */}
      <div className="px-4 pb-3">
        <div className="mb-1 text-[12px] font-semibold text-[var(--pink-deep)]">盯这些文件夹（丢进去新文件就会弹卡）</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {watchDirs.map((w) => (
            <span key={w} className="chip">
              {w}
              <button className="ml-1 text-[var(--text-3)] hover:text-[#d9534f]" title="移除" onClick={() => void removeDir(w)}>×</button>
            </span>
          ))}
          <input
            className="input"
            style={{ width: 160 }}
            placeholder="如：画 / 图片"
            value={dirInput}
            onChange={(e) => setDirInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addDir() }}
          />
          <button className="btn sm" onClick={() => void addDir()}>＋</button>
        </div>
        <p className="mt-1 text-[12px] text-[var(--text-3)]">相对的数据库内路径，默认已盯「成果」目录。</p>
      </div>

      <div className="panel-body">
        <div className="patrol-list">
          {pending.length === 0 && !loading && (
            <p className="empty-tip">没有待确认的新成果。往「成果」文件夹丢个新文件，这里就会弹卡。</p>
          )}
          {pending.map((ev) => (
            <div key={ev.id} className="patrol-card">
              <div className="patrol-main">
                <div className="patrol-title">🆕 {ev.title}</div>
                <div className="patrol-meta">{ev.source_path}</div>
              </div>
              <label className="fm-label">
                完成日期
                <input
                  className="input fm-input"
                  type="date"
                  value={ev.date_done}
                  onChange={(e) => void handleDateChange(ev, e.target.value)}
                />
              </label>
              <div className="patrol-actions">
                <button className="btn sm" onClick={() => void handleConfirm(ev)}>✓ 收录</button>
                <button className="btn sm ghost" onClick={() => void handleIgnore(ev)}>✗ 忽略</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}