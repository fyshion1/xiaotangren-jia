/** 自我档案面板（§23）：私人空间的「我的档案」区块。
 *
 * 布局：左栏区块列表 + 右栏 Markdown 编辑器 + frontmatter 控件。
 * Markdown 不走渲染库，直接 textarea 原生写入 —— 与项目其他面板一致。
 */

import { useEffect, useState, useCallback } from 'react'
import {
  fetchSelfBlocks,
  fetchSelfBlock,
  saveSelfBlock,
  createSelfBlock,
  deleteSelfBlock,
  type SelfBlockMeta,
  type SelfBlock,
} from '../api/client'

type Props = {
  personaId: string
}

export default function SelfProfilePanel({ personaId }: Props) {
  const [blocks, setBlocks] = useState<SelfBlockMeta[]>([])
  const [selected, setSelected] = useState<SelfBlock | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [err, setErr] = useState('')

  // 角色列表（供 visible_to 选择）
  const characterIds = ['dashiyin', 'xiaoshiyin', 'xiaobai', 'xiaohongshutou']
  const characterNames: Record<string, string> = {
    dashiyin: '大诗音',
    xiaoshiyin: '小诗音',
    xiaobai: '小白',
    xiaohongshutou: '小红薯头',
  }

  const loadBlocks = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await fetchSelfBlocks(personaId)
      setBlocks(data)
    } catch (e) {
      setErr('加载失败：' + String(e))
    } finally {
      setLoading(false)
    }
  }, [personaId])

  useEffect(() => {
    setSelected(null)
    void loadBlocks()
  }, [loadBlocks])

  const openBlock = async (meta: SelfBlockMeta) => {
    try {
      const full = await fetchSelfBlock(meta.persona_id, meta.filename)
      setSelected(full)
    } catch (e) {
      setErr('读取失败：' + String(e))
    }
  }

  const handleSave = async () => {
    if (!selected) return
    setSaving(true)
    setErr('')
    try {
      const updated = await saveSelfBlock(selected.persona_id, selected.filename, {
        title: selected.title,
        inject: selected.inject,
        visible_to: selected.visible_to,
        content: selected.content,
      })
      setSelected(updated)
      void loadBlocks()
    } catch (e) {
      setErr('保存失败：' + String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    setErr('')
    try {
      const meta = await createSelfBlock(personaId, newTitle.trim())
      setNewTitle('')
      setShowNew(false)
      void loadBlocks()
      void openBlock(meta)
    } catch (e) {
      setErr('新建失败：' + String(e))
    }
  }

  const handleDelete = async (meta: SelfBlockMeta) => {
    const ok = window.confirm(`删掉「${meta.title}」？`)
    if (!ok) return
    try {
      await deleteSelfBlock(meta.persona_id, meta.filename)
      if (selected?.filename === meta.filename) setSelected(null)
      void loadBlocks()
    } catch (e) {
      setErr('删除失败：' + String(e))
    }
  }

  const handleExport = () => {
    window.open(`/api/self/export?persona_id=${encodeURIComponent(personaId)}`, '_blank')
  }

  const visibleToArray = (v: string | string[]): string[] => {
    if (!v || v === 'all') return []
    if (Array.isArray(v)) return v
    return (v as string).split(',').map(s => s.trim()).filter(Boolean)
  }

  const isAllVisible = (v: string | string[]) => !v || v === 'all' || visibleToArray(v).length === 0

  const handleInjectToggle = () => {
    if (!selected) return
    setSelected({ ...selected, inject: !selected.inject })
  }

  const handleVisibleChange = (val: string) => {
    if (!selected) return
    if (val === 'all') {
      setSelected({ ...selected, visible_to: 'all' })
    } else {
      const arr = visibleToArray(selected.visible_to)
      const next = arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]
      setSelected({ ...selected, visible_to: next.length ? next : 'all' })
    }
  }

  const vtArray = visibleToArray(selected?.visible_to ?? 'all')

  return (
    <section className="self-profile-panel">
      <div className="panel-header">
        <span className="eyebrow">我的档案</span>
        <div className="flex gap-2">
          <button className="btn sm" onClick={handleExport}>📦 导出</button>
          <button className="btn sm" onClick={() => { setShowNew(true); setNewTitle('') }}>
            ＋ 新建
          </button>
          <button className="btn sm ghost" onClick={loadBlocks} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {err && <p className="err-tip">{err}</p>}

      {showNew && (
        <div className="new-block-form">
          <input
            className="input"
            placeholder="区块标题，如：喜好、日常作息、年度目标…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
            autoFocus
          />
          <button className="btn sm" onClick={() => void handleCreate()}>创建</button>
          <button className="btn sm ghost" onClick={() => setShowNew(false)}>取消</button>
        </div>
      )}

      <div className="panel-body">
        {/* 左栏：区块列表 */}
        <div className="block-list">
          {blocks.length === 0 && !loading && (
            <p className="empty-tip">还没有档案区块，点「新建」开始记录吧。</p>
          )}
          {blocks.map((b) => (
            <div
              key={`${b.persona_id}/${b.filename}`}
              className={`block-item ${selected?.filename === b.filename && selected?.persona_id === b.persona_id ? 'on' : ''}`}
              onClick={() => void openBlock(b)}
            >
              <div className="block-meta">
                <span className="block-title">{b.title || b.filename}</span>
                {b.is_shared && <span className="shared-chip">共享</span>}
                {b.inject && <span className="inject-chip">注入中</span>}
              </div>
              <button
                className="del-btn"
                title="删除"
                onClick={(e) => { e.stopPropagation(); void handleDelete(b) }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* 右栏：编辑器 */}
        <div className="block-editor">
          {selected ? (
            <>
              {/* frontmatter 控件 */}
              <div className="frontmatter-row">
                <label className="fm-label">
                  标题
                  <input
                    className="input fm-input"
                    value={selected.title}
                    onChange={(e) => setSelected({ ...selected, title: e.target.value })}
                  />
                </label>
              </div>

              <div className="frontmatter-row">
                <label className="fm-label fm-toggle">
                  <input
                    type="checkbox"
                    checked={selected.inject}
                    onChange={handleInjectToggle}
                  />
                  聊天时注入
                  <span className="fm-hint">打开后，小糖人在聊天时会看到这段内容</span>
                </label>
              </div>

              <div className="frontmatter-row">
                <span className="fm-label">可见范围</span>
                <div className="visible-chips">
                  <button
                    className={`chip ${isAllVisible(selected.visible_to) ? 'on' : ''}`}
                    onClick={() => handleVisibleChange('all')}
                  >
                    所有人
                  </button>
                  {characterIds.map((cid) => (
                    <button
                      key={cid}
                      className={`chip ${vtArray.includes(cid) ? 'on' : ''}`}
                      onClick={() => handleVisibleChange(cid)}
                    >
                      {characterNames[cid]}
                    </button>
                  ))}
                </div>
              </div>

              {/* 正文编辑器 */}
              <textarea
                className="textarea block-textarea"
                value={selected.content}
                onChange={(e) => setSelected({ ...selected, content: e.target.value })}
                placeholder="在这里写下你想记录的内容……"
                spellCheck={false}
              />

              <div className="editor-footer">
                <span className="char-count">{selected.content.length} 字</span>
                <button className="btn" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? '保存中…' : '💾 保存'}
                </button>
              </div>
            </>
          ) : (
            <div className="editor-empty">
              <p>选择一个区块来编辑</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
