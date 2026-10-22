import { useEffect, useRef, useState } from 'react'
export type Frame = { x: number; y: number; zoom: number; fit: 'cover' | 'contain' }
export type Entry = { file: string; name: string }
const KEY = 'xtr.visual.gallery-composition-v1'
function defaults(file: string): Frame {
  return {
    x: 50,
    y: 25,
    zoom: 1,
    fit: file.includes('193cace') || file.includes('10860c') ? 'contain' : 'cover',
  }
}
function safe(v: unknown, file: string): Frame {
  const d = defaults(file)
  if (!v || typeof v !== 'object') return d
  const a = v as Partial<Frame>
  const n = (v: unknown, f: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : f
  return {
    x: n(a.x, d.x, 0, 100),
    y: n(a.y, d.y, 0, 100),
    zoom: n(a.zoom, 1, 1, 2.5),
    fit: a.fit === 'contain' ? 'contain' : 'cover',
  }
}
export function readFrame(file: string, viewport: string) {
  try {
    return safe(JSON.parse(localStorage.getItem(KEY) || '{}')[viewport + ':' + file], file)
  } catch {
    return defaults(file)
  }
}
export function Picture({
  entry,
  value,
  interactive,
  onChange,
}: {
  entry: Entry
  value: Frame
  interactive: boolean
  onChange: (v: Frame) => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1, h: 1 })
  const [natural, setNatural] = useState({ w: 1, h: 1 })
  const drag = useRef<{ id: number; x: number; y: number; value: Frame } | null>(null)
  useEffect(() => {
    if (!el.current) return
    const o = new ResizeObserver((es) => {
      const r = es[0].contentRect
      setSize({ w: r.width, h: r.height })
    })
    o.observe(el.current)
    return () => o.disconnect()
  }, [])
  const scale =
    (value.fit === 'cover'
      ? Math.max(size.w / natural.w, size.h / natural.h)
      : Math.min(size.w / natural.w, size.h / natural.h)) * value.zoom
  const w = natural.w * scale,
    h = natural.h * scale
  const dx = size.w - w,
    dy = size.h - h
  return (
    <div
      ref={el}
      className={'composition-frame' + (interactive ? ' adjustable' : '')}
      style={{ touchAction: interactive ? 'none' : 'auto' }}
      onPointerDown={(e) => {
        if (!interactive || e.button !== 0) return
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, value: { ...value } }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || !interactive) return
        onChange({
          ...d.value,
          x:
            Math.abs(dx) < 1
              ? d.value.x
              : Math.max(0, Math.min(100, d.value.x + ((e.clientX - d.x) / dx) * 100)),
          y:
            Math.abs(dy) < 1
              ? d.value.y
              : Math.max(0, Math.min(100, d.value.y + ((e.clientY - d.y) / dy) * 100)),
        })
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
    >
      <img
        src={entry.file}
        alt={entry.name}
        draggable={false}
        onLoad={(e) =>
          setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
        style={{
          position: 'absolute',
          width: w,
          height: h,
          maxWidth: 'none',
          left: (dx * value.x) / 100,
          top: (dy * value.y) / 100,
          objectFit: 'fill',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
export default function GalleryComposition({
  images,
  name,
  onOpen,
  labels = [],
}: {
  images: string[]
  name: string
  labels?: string[]
  onOpen: (src: string) => void
}) {
  const [viewport, setViewport] = useState(() =>
    matchMedia('(max-width:767px)').matches ? 'narrow' : 'wide',
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Frame>(defaults(''))
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState('')
  const [ratio, setRatio] = useState(1)
  const editor = useRef<HTMLElement>(null)
  const editButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (editing)
      editor.current?.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      })
  }, [editing])
  useEffect(() => {
    const q = matchMedia('(max-width:767px)')
    const f = () => {
      setViewport(q.matches ? 'narrow' : 'wide')
      setEditing(null)
      setStatus('')
    }
    q.addEventListener('change', f)
    return () => q.removeEventListener('change', f)
  }, [])
  useEffect(() => {
    setEditing(null)
    setStatus('')
  }, [images])
  function start(file: string, button: HTMLButtonElement) {
    editButton.current = button
    const frame = button
      .closest('figure')
      ?.querySelector('.composition-frame')
      ?.getBoundingClientRect()
    if (frame) setRatio(frame.width / frame.height)
    setDraft(readFrame(file, viewport))
    setEditing(file)
    setStatus('')
  }
  function finish() {
    setEditing(null)
    editButton.current?.focus()
  }
  function save() {
    if (!editing) return
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || '{}')
      data[viewport + ':' + editing] = draft
      localStorage.setItem(KEY, JSON.stringify(data))
      setRevision(revision + 1)
      window.dispatchEvent(new Event('xtr-composition-change'))
      setStatus('构图已保存在本机浏览器')
      finish()
    } catch {
      setStatus('未能保存，请检查浏览器存储设置。')
    }
  }
  return (
    <>
      <div className={'editorial-images count-' + images.length}>
        {images.map((file, i) => {
          const entry = { file, name: name + '的收藏图片 ' + (i + 1) }
          const active = editing === file
          return (
            <figure className="composition-card" key={file}>
              <button
                className="composition-open"
                aria-label={'查看收藏图片 ' + (i + 1)}
                disabled={active}
                onClick={() => onOpen(file)}
              >
                <Picture
                  entry={entry}
                  value={active ? draft : readFrame(file, viewport)}
                  interactive={false}
                  onChange={() => {}}
                />
              </button>
              <figcaption>
                <span>0{i + 1}</span>
                <b>{labels[i] || '收藏的片刻'}</b>
                <button
                  onClick={(e) => start(file, e.currentTarget)}
                  aria-label={'调整图片 ' + (i + 1) + ' 构图'}
                >
                  调整构图 ↗
                </button>
              </figcaption>
            </figure>
          )
        })}
      </div>
      {editing && (
        <section ref={editor} className="composition-editor" aria-label="图片构图调整">
          <div className="composition-editor-head">
            <div>
              <h3>调整这张画的展示位置</h3>
              <p>
                当前调整{viewport === 'wide' ? '桌面' : '窄屏'}
                构图。拖动预览或使用滑杆；控件均放在画外。
              </p>
            </div>
            <button onClick={finish} aria-label="关闭构图调整">
              取消 ×
            </button>
          </div>
          <div className="composition-workspace">
            <div className="composition-preview" style={{ aspectRatio: ratio }}>
              <Picture
                entry={{ file: editing, name: '构图预览' }}
                value={draft}
                interactive
                onChange={setDraft}
              />
            </div>
            <div className="composition-sliders">
              <label>
                展示方式
                <select
                  aria-label="展示方式"
                  value={draft.fit}
                  onChange={(e) => setDraft({ ...draft, fit: e.target.value as Frame['fit'] })}
                >
                  <option value="cover">填满画框</option>
                  <option value="contain">完整显示原画</option>
                </select>
              </label>
              {(
                [
                  { key: 'x', label: '左右位置', min: 0, max: 100, step: 1 },
                  { key: 'y', label: '上下位置', min: 0, max: 100, step: 1 },
                  { key: 'zoom', label: '缩放', min: 1, max: 2.5, step: 0.01 },
                ] as const
              ).map((c) => (
                <label key={c.key}>
                  {c.label}
                  <output>
                    {c.key === 'zoom'
                      ? Math.round(draft.zoom * 100) + '%'
                      : Math.round(draft[c.key]) + '%'}
                  </output>
                  <input
                    aria-label={c.label}
                    type="range"
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    value={draft[c.key]}
                    onChange={(e) => setDraft({ ...draft, [c.key]: Number(e.target.value) })}
                  />
                </label>
              ))}
              <p>
                想保留脸部，可调整上下位置；想保留整张画，可切到完整显示。没有可裁切余量时，该方向的位置变化不会移动图片。
              </p>
              <div className="composition-actions">
                <button onClick={() => setDraft(defaults(editing))}>重置构图</button>
                <button className="save" onClick={save}>
                  保存构图
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
      <p className="composition-status" role="status">
        {status}
      </p>
    </>
  )
}
