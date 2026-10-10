import { useEffect, useMemo, useState } from 'react'
import {
  archivePersonalDbFile, createPersonalDbFile, createSelfBlock, fetchPersonalDbFile,
  fetchPersonalDbHistory, fetchPersonalDbTree, movePersonalDbPath, renamePersonalDbFile,
  renamePersonalDbFolder, restorePersonalDbVersion, savePersonalDbFile, saveSelfBlock,
  copyToAiLayer, approveAiLayer,
  type PersonalDbEntry,
} from '../api/client'

type TreeNode = { name: string; path: string; files: PersonalDbEntry[]; dirs: TreeNode[] }
type Version = { path: string; name: string; size: number }

function makeTree(entries: PersonalDbEntry[]): TreeNode {
  const root: TreeNode = { name: '个人数据库', path: '', files: [], dirs: [] }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    let node = root
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        if (entry.kind === 'file') node.files.push(entry)
        return
      }
      let child = node.dirs.find(item => item.name === part)
      if (!child) {
        child = { name: part, path: parts.slice(0, index + 1).join('/'), files: [], dirs: [] }
        node.dirs.push(child)
      }
      node = child
    })
  }
  return root
}

function readField(text: string, key: string): string {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  return front?.split(/\r?\n/).find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') ?? ''
}

function updateField(text: string, key: string, value: string): string {
  const match = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/)
  if (!match) return `---\n${key}: ${value}\n---\n${text}`
  const rows = match[2].split(/\r?\n/)
  const index = rows.findIndex(line => line.startsWith(`${key}:`))
  if (index >= 0) rows[index] = `${key}: ${value}`
  else rows.push(`${key}: ${value}`)
  return `${match[1]}${rows.join('\n')}${match[3]}${text.slice(match[0].length)}`
}

export default function PersonalDatabasePanel({ personaId }: { personaId: string }) {
  const [entries, setEntries] = useState<PersonalDbEntry[]>([])
  const [selected, setSelected] = useState<PersonalDbEntry | null>(null)
  const [selectedFolder, setSelectedFolder] = useState('')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [history, setHistory] = useState<Version[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const tree = useMemo(() => makeTree(entries), [entries])
  const searchResults = useMemo(() => entries.filter(entry => entry.kind === 'file' && entry.path.toLowerCase().includes(query.toLowerCase())), [entries, query])

  async function load() { setEntries(await fetchPersonalDbTree()) }
  useEffect(() => { void load() }, [])

  async function open(entry: PersonalDbEntry) {
    const file = await fetchPersonalDbFile(entry.path)
    setSelected(file)
    setSelectedFolder(entry.path.split('/').slice(0, -1).join('/'))
    setDraft(file.content ?? (file.sheets ? JSON.stringify(file.sheets, null, 2) : ''))
    setMessage('')
    setHistory(file.editable ? await fetchPersonalDbHistory(entry.path) : [])
  }

  async function save() {
    if (!selected?.editable) return
    setSaving(true)
    try {
      const saved = await savePersonalDbFile(selected.path, draft, selected.sha256)
      setSelected({ ...selected, sha256: saved.sha256, content: draft })
      setMessage('已保存，旧内容已进入历史版本')
      await load()
      setHistory(await fetchPersonalDbHistory(selected.path))
    } catch (error) {
      setMessage(`保存失败：${String(error)}`)
    } finally { setSaving(false) }
  }

  async function createFile() {
    const name = window.prompt('新 Markdown 文件名')
    if (!name) return
    const directory = selectedFolder || selected?.path.split('/').slice(0, -1).join('/') || ''
    const filename = name.endsWith('.md') ? name : `${name}.md`
    const path = `${directory ? `${directory}/` : ''}${filename}`
    const title = filename.replace(/\.md$/i, '')
    const created = await createPersonalDbFile(path, `---\ntitle: ${title}\ntype: reference\nstatus: draft\nupdated_at: ${new Date().toISOString().slice(0, 10)}\nsensitivity: private\ninject: false\nvisible_to: all\n---\n`)
    await load()
    await open(created)
  }

  async function rename() {
    if (selected) {
      const name = window.prompt('新文件名', selected.name)
      if (!name) return
      const renamed = await renamePersonalDbFile(selected.path, name)
      await load(); await open(renamed)
    } else if (selectedFolder) {
      const name = window.prompt('新文件夹名', selectedFolder.split('/').pop())
      if (!name) return
      await renamePersonalDbFolder(selectedFolder, name)
      setSelectedFolder(''); await load()
    }
  }

  async function move() {
    const source = selected?.path ?? selectedFolder
    if (!source) return
    const parent = source.split('/').slice(0, -1).join('/')
    const destination = window.prompt('目标文件夹路径；留空表示数据库根目录', parent)
    if (destination === null) return
    const moved = await movePersonalDbPath(source, destination)
    await load()
    if (selected) await open(moved)
    else setSelectedFolder(moved.path)
  }

  async function showHistory() {
    if (!selected) return
    const versions = await fetchPersonalDbHistory(selected.path)
    setHistory(versions)
    const choice = window.prompt(versions.length ? versions.map((version, i) => `${i + 1}. ${version.name}`).join('\n') : '暂无历史版本')
    const index = Number(choice) - 1
    if (!choice || !versions[index] || !window.confirm('恢复该版本？当前内容会先保存为一个历史版本。')) return
    await restorePersonalDbVersion(selected.path, versions[index].path)
    await open(selected)
  }

  async function importToProfile() {
    if (!selected) return
    const title = readField(draft, 'title') || selected.name.replace(/\.md$/i, '')
    const block = await createSelfBlock(personaId, title)
    const content = draft.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
    await saveSelfBlock(personaId, block.filename, { title, inject: false, visible_to: 'all', content })
    setMessage('已复制到当前身份档案，聊天注入保持关闭')
  }

  async function copyToWorkLayer() {
    if (!selected || selected.extension !== '.md') return
    const destination = window.prompt('AI 工作层目标路径', `02_AI工作层/待确认/${selected.name}`)
    if (!destination) return
    await copyToAiLayer(selected.path, destination, readField(draft, 'title') || selected.name)
    setMessage(`已复制到 ${destination}`); await load()
  }

  async function approveToInjectLayer() {
    if (!selected || selected.extension !== '.md') return
    const destination = window.prompt('AI 注入层目标路径', `03_AI注入层/个人背景/${selected.name}`)
    if (!destination) return
    await approveAiLayer(selected.path, destination)
    setMessage(`已批准并复制到 ${destination}`); await load()
  }

  function renderNode(node: TreeNode, level = 0): JSX.Element {
    return <div key={node.path || 'root'}>
      {node.dirs.map(directory => <div key={directory.path}>
        <button className="db-folder" style={{ paddingLeft: level * 12 + 8 }} onClick={() => {
          setSelected(null); setSelectedFolder(directory.path)
          setExpanded(previous => { const next = new Set(previous); next.has(directory.path) ? next.delete(directory.path) : next.add(directory.path); return next })
        }}>{expanded.has(directory.path) ? '▾' : '▸'}　{directory.name}</button>
        {expanded.has(directory.path) && renderNode(directory, level + 1)}
      </div>)}
      {node.files.map(entry => <button key={entry.path} className={`block-item ${selected?.path === entry.path ? 'on' : ''}`} style={{ paddingLeft: level * 12 + 22 }} onClick={() => void open(entry)}>
        <span className="block-title">{entry.name}</span>
        {entry.extension === '.xlsx' && <span className="inject-chip">只读预览</span>}
        {entry.editable && <span className="inject-chip">可编辑</span>}
      </button>)}
    </div>
  }

  return <section className="self-profile-panel personal-db-panel">
    <div className="panel-header"><span className="eyebrow">数据库工作区</span><div className="db-actions">
      <button className="btn sm" onClick={() => void createFile()}>新建</button>
      <button className="btn sm ghost" disabled={!selected && !selectedFolder} onClick={() => void rename()}>重命名</button>
      <button className="btn sm ghost" disabled={!selected && !selectedFolder} onClick={() => void move()}>移动</button>
      <button className="btn sm ghost" onClick={() => void load()}>刷新</button>
    </div></div>
    <div className="db-toolbar"><input className="input" placeholder="搜索文件" value={query} onChange={event => setQuery(event.target.value)} /><span className="fm-hint">Markdown 和 DOCX 可编辑，XLSX 只读预览</span></div>
    <div className="panel-body">
      <div className="block-list db-tree">{query ? searchResults.map(entry => <button key={entry.path} className="block-item" onClick={() => void open(entry)}><span className="block-title">{entry.path}</span></button>) : renderNode(tree)}</div>
      <div className="block-editor">{selected ? <>
        <div className="frontmatter-row"><b className="db-current-path">{selected.path}</b><span className="fm-hint">{selected.editable ? (selected.extension === '.docx' ? 'DOCX 文字编辑' : 'Markdown 编辑') : '只读文件'}</span></div>
        {selected.editable && selected.extension === '.md' && <div className="db-meta-form">
          <label>标题<input className="input" value={readField(draft, 'title')} onChange={event => setDraft(value => updateField(value, 'title', event.target.value))} /></label>
          <label>状态<select className="input" value={readField(draft, 'status') || 'draft'} onChange={event => setDraft(value => updateField(value, 'status', event.target.value))}><option value="current">当前</option><option value="draft">草稿</option><option value="needs_review">待确认</option><option value="archived">已归档</option></select></label>
          <label className="db-check"><input type="checkbox" checked={readField(draft, 'inject') === 'true'} onChange={event => setDraft(value => updateField(value, 'inject', String(event.target.checked)))} />聊天时注入</label>
          <label>可见身份<input className="input" value={readField(draft, 'visible_to') || 'all'} onChange={event => setDraft(value => updateField(value, 'visible_to', event.target.value))} placeholder="all 或身份 ID" /></label>
        </div>}
        {selected.extension === '.xlsx' && selected.sheets && <div className="xlsx-preview">{selected.sheets.map(sheet => <details key={sheet.name}><summary>{sheet.name} · {sheet.rows} 行 × {sheet.columns} 列（预览前 100 行、30 列）</summary><pre>{JSON.stringify(sheet.preview, null, 2)}</pre></details>)}</div>}
        {selected.extension !== '.xlsx' && <textarea className="textarea block-textarea" value={draft} onChange={event => setDraft(event.target.value)} readOnly={!selected.editable} spellCheck={false} />}
        {selected.extension === '.docx' && <p className="fm-hint">保存会备份原 DOCX；网页编辑保留段落和表格结构，但段落内文字格式可能简化。</p>}
        <div className="editor-footer"><span className="char-count">{message}</span><div className="db-actions">{selected.editable && <>
          <button className="btn sm ghost" title="历史版本" onClick={() => void showHistory()}>历史 · {history.length}</button>
          <button className="btn sm ghost" onClick={async () => { if (selected && window.confirm(`归档 ${selected.path}？`)) { await archivePersonalDbFile(selected.path); setSelected(null); await load() } }}>归档</button>
          <button className="btn sm ghost" onClick={() => void copyToWorkLayer()} disabled={selected.extension !== '.md'}>复制到 AI 工作层</button>
          <button className="btn sm ghost" onClick={() => void approveToInjectLayer()} disabled={selected.extension !== '.md'}>批准到 AI 注入层</button>
          <button className="btn sm ghost" onClick={() => void importToProfile()} disabled={selected.extension !== '.md'}>复制到我的档案</button>
          <button className="btn" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存版本'}</button>
        </>}</div></div>
      </> : <div className="editor-empty"><p>选择一个文件开始</p></div>}</div>
    </div>
  </section>
}
