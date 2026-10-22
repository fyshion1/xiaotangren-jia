import { useRef, useState } from 'react'

type Props = { src: string; onApply: (src: string) => void; onCancel: () => void }
export default function AvatarCropper({ src, onApply, onCancel }: Props) {
  const image = useRef<HTMLImageElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [x, setX] = useState(50),
    [y, setY] = useState(25),
    [zoom, setZoom] = useState(1)
  const [error, setError] = useState('')
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const scale = size.w && size.h ? Math.max(1 / size.w, 1 / size.h) * zoom : 1
  const w = size.w * scale,
    h = size.h * scale
  function apply() {
    try {
      if (!image.current || !size.w) throw Error('图片尚未加载')
      const canvas = document.createElement('canvas')
      canvas.width = 512
      canvas.height = 512
      const ctx = canvas.getContext('2d')
      if (!ctx) throw Error('无法生成头像')
      ctx.drawImage(
        image.current,
        (((1 - w) * x) / 100) * 512,
        (((1 - h) * y) / 100) * 512,
        w * 512,
        h * 512,
      )
      onApply(canvas.toDataURL('image/png'))
    } catch {
      setError('无法裁剪这张图片，请选择本地图片后重试。')
    }
  }
  return (
    <section className="avatar-cropper composition-editor" aria-label="头像裁剪">
      <div className="composition-editor-head">
        <div>
          <h3>把她的脸，放在刚好的位置。</h3>
          <p>拖动图片或调整滑杆；确认后生成方形头像。</p>
        </div>
        <button onClick={onCancel}>取消裁剪</button>
      </div>
      <div className="avatar-crop-workspace">
        <div
          ref={frame}
          className="avatar-crop-frame"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { px: e.clientX, py: e.clientY, x, y }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d || !frame.current) return
            const width = frame.current.clientWidth
            const clamp = (v: number) => Math.max(0, Math.min(100, v))
            if (w > 1) setX(clamp(d.x - ((e.clientX - d.px) / (width * (w - 1))) * 100))
            if (h > 1) setY(clamp(d.y - ((e.clientY - d.py) / (width * (h - 1))) * 100))
          }}
          onPointerUp={() => {
            drag.current = null
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
        >
          <img
            ref={image}
            src={src}
            crossOrigin="anonymous"
            alt="头像裁剪预览"
            draggable={false}
            onLoad={(e) =>
              setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            onError={() => setError('图片加载失败，请重新选择本地图片。')}
            style={{
              width: w * 100 + '%',
              height: h * 100 + '%',
              left: (1 - w) * x + '%',
              top: (1 - h) * y + '%',
            }}
          />
        </div>
        <div className="composition-sliders">
          {[
            { name: '头像左右位置', value: x, set: setX, min: 0, max: 100, step: 1 },
            { name: '头像上下位置', value: y, set: setY, min: 0, max: 100, step: 1 },
            { name: '头像缩放', value: zoom, set: setZoom, min: 1, max: 4, step: 0.01 },
          ].map((c) => (
            <label key={c.name}>
              {c.name}
              <output>
                {c.name === '头像缩放'
                  ? Math.round(c.value * 100) + '%'
                  : Math.round(c.value) + '%'}
              </output>
              <input
                aria-label={c.name}
                type="range"
                min={c.min}
                max={c.max}
                step={c.step}
                value={c.value}
                onChange={(e) => c.set(Number(e.target.value))}
              />
            </label>
          ))}
          <div className="composition-actions">
            <button
              onClick={() => {
                setX(50)
                setY(25)
                setZoom(1)
              }}
            >
              重置位置
            </button>
            <button className="save" disabled={!size.w || !!error} onClick={apply}>
              使用这个头像
            </button>
          </div>
          <p role="status">{error}</p>
        </div>
      </div>
    </section>
  )
}
