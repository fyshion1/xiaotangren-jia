import { useEffect, useState } from 'react'
import { fetchGallery, type GalleryItem } from '../api/gallery'
import GalleryComposition, { Picture, readFrame } from './GalleryComposition'
import UiIcon from './UiIcon'

const KEY = 'xtr.visual.nest-stickers-v1'
export type Sticker = { id: string; hidden: boolean }
type Config = { left: Sticker; right: Sticker }
const empty: Config = { left: { id: '', hidden: false }, right: { id: '', hidden: false } }
function read(): Config {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    const side = (v: unknown): Sticker => {
      const a = v as Partial<Sticker> | null
      return { id: typeof a?.id === 'string' ? a.id : '', hidden: a?.hidden === true }
    }
    return { left: side(raw?.left), right: side(raw?.right) }
  } catch {
    return empty
  }
}
export function useNestStickers() {
  const [config, setConfig] = useState(read)
  const [items, setItems] = useState<GalleryItem[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setItems([])
    fetchGallery('', false)
      .then((rows) => {
        if (alive) {
          setItems(rows.filter((g) => !g.private && g.owner === '' && g.kind !== 'video'))
          setError('')
        }
      })
      .catch(() => {
        if (alive) {
          setItems([])
          setError('共同画廊未读取，已隐藏无法核实的自选贴纸。')
        }
      })
    return () => {
      alive = false
    }
  }, [config, revision])
  useEffect(() => {
    const sync = () => {
      setConfig(read())
      setRevision((v) => v + 1)
    }
    window.addEventListener('storage', sync)
    window.addEventListener('xtr-stickers-change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('xtr-stickers-change', sync)
    }
  }, [])
  return { config, items, error }
}
export function StickerPicture({ src, name }: { src: string; name: string }) {
  const [viewport, setViewport] = useState(() =>
    matchMedia('(max-width:767px)').matches ? 'narrow' : 'wide',
  )
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const q = matchMedia('(max-width:767px)')
    const onSize = () => setViewport(q.matches ? 'narrow' : 'wide')
    const sync = () => setRevision((v) => v + 1)
    q.addEventListener('change', onSize)
    window.addEventListener('xtr-composition-change', sync)
    window.addEventListener('storage', sync)
    return () => {
      q.removeEventListener('change', onSize)
      window.removeEventListener('xtr-composition-change', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return (
    <div className="nest-sticker-custom" data-revision={revision}>
      <Picture
        entry={{ file: src, name }}
        value={readFrame(src, viewport)}
        interactive={false}
        onChange={() => {}}
      />
    </div>
  )
}
export default function NestStickerEditor() {
  const { config, items, error } = useNestStickers()
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(false)
  function save(side: 'left' | 'right', value: Sticker) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...config, [side]: value }))
      window.dispatchEvent(new Event('xtr-stickers-change'))
      setNotice('页头贴纸已保存在本机。')
    } catch {
      setNotice('未能保存，请检查浏览器存储。')
    }
  }
  return (
    <details className="nest-sticker-manager" onToggle={(e) => setEditing(e.currentTarget.open)}>
      <summary>
        <UiIcon name="paint" />
        页头小贴纸<span>选图 · 隐藏 · 调整构图</span>
      </summary>
      {editing && (
        <div className="nest-sticker-management">
          <p>
            从公开的共同画廊为左右两侧选图。图片转为私密、删除或归属改变后不再展示；空选项恢复默认。
          </p>
          {(['left', 'right'] as const).map((side) => (
            <div key={side} className="nest-sticker-setting">
              <label htmlFor={'nest-sticker-' + side}>
                {side === 'left' ? '左侧' : '右侧'}贴纸
              </label>
              <select
                id={'nest-sticker-' + side}
                value={config[side].id}
                onChange={(e) => save(side, { ...config[side], id: e.target.value })}
              >
                <option value="">默认角色贴纸</option>
                {config[side].id && !items.some((g) => g.id === config[side].id) && (
                  <option value={config[side].id}>图片已不可用</option>
                )}
                {items.map((g, i) => (
                  <option key={g.id} value={g.id}>
                    {g.description || '收藏图片 ' + (i + 1)}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={config[side].hidden}
                  onChange={(e) => save(side, { ...config[side], hidden: e.target.checked })}
                />{' '}
                隐藏
              </label>
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
          {(['left', 'right'] as const).map((side) => {
            const item = items.find((g) => g.id === config[side].id)
            return item && !config[side].hidden ? (
              <div key={side}>
                <h3>{side === 'left' ? '左侧' : '右侧'}贴纸构图</h3>
                <GalleryComposition
                  images={[item.orig]}
                  name="页头贴纸"
                  labels={[item.description]}
                  onOpen={() => {}}
                />
              </div>
            ) : null
          })}
          <p role="status">{notice}</p>
        </div>
      )}
    </details>
  )
}
