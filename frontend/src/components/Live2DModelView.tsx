import { useEffect, useRef, useState } from 'react'

/** Live2D 官方运行时（全局挂 `window.Live2DCubismCore`），静态文件放 frontend/public/vendor/。 */
const CUBISM_CORE_SRC = '/vendor/live2dcubismcore.min.js'

let corePromise: Promise<void> | null = null

/** 只注入一次 Cubism Core；重复调用返回同一个 Promise。 */
function loadCubismCore(): Promise<void> {
  if (typeof window !== 'undefined' && (window as any).Live2DCubismCore) return Promise.resolve()
  if (corePromise) return corePromise
  corePromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = CUBISM_CORE_SRC
    el.async = true
    el.onload = () => {
      if ((window as any).Live2DCubismCore) resolve()
      else reject(new Error('live2dcubismcore.js 加载了，但没挂到 window 上'))
    }
    el.onerror = () => {
      corePromise = null // 允许下次重试
      reject(new Error(`没加载到 ${CUBISM_CORE_SRC}`))
    }
    document.head.appendChild(el)
  })
  return corePromise
}

type Model = import('pixi-live2d-display/cubism4').Live2DModel
type Application = import('pixi.js').Application

/**
 * 销毁一个模型，连它自己的贴图一起释放。
 *
 * 为什么要包一层：这个包的**类型声明**把 `destroy` 写成 `(options?) => void`（pixi Container 的那套），
 * 但 `Live2DModel` 运行时是要 `destroy(true, opts)` 才会去释放 moc3 / 贴图资源的。
 * 所以这里按运行时真正需要的形式调用，类型上用一次断言过桥。
 */
function destroyModel(model: Model) {
  const fn = model.destroy as unknown as (release?: boolean, options?: Record<string, boolean>) => void
  fn.call(model, true, { children: true, texture: true, baseTexture: true })
}

export type Live2DModelViewProps = {
  /** .model3.json 的 URL（`/assets/live2d/...`）。变化时重新加载模型。 */
  url: string
  /** 待机动作组名；不给就用模型自带的第一个动作组。 */
  idleMotion?: string
  /** 加载完先摆一个表情。 */
  expression?: string
  /** 加载失败时把原因交给外层显示（占位卡片里放得下）。 */
  onError?: (message: string) => void
  className?: string
}

/**
 * 把一个 Live2D 模型画在卡片里（§36 正式接入，替换原来的「占位」字样）。
 *
 * 三件容易踩的事，都在这里处理掉了：
 * 1. **整个实例必须「用完就扔」**：pixi 的 Application / Ticker / WebGL 上下文在
 *    React 18 StrictMode 下会被 effect 跑两遍，不彻底 destroy 就会残留 canvas
 *    （最坏撞上浏览器 WebGL 上下文上限，之后所有 3D 都黑屏）。所以 cleanup 里
 *    `destroy(true, {children:true, texture:true, baseTexture:true})` + 摘掉 canvas。
 * 2. **尺寸必须自己量**：pixi 自己 resize 出来的 buffer 常常是 0×0（会白屏），
 *    所以走 `resizeTo` 盯容器 + ResizeObserver 手动 `renderer.resize`。
 * 3. **模型要「站满」卡片**：模型画布跟卡片不是同一比例，直接塞会小得可怜。
 *    用每帧量出来的**可见轮廓**（SDK 的模型变换 + 所有 drawable 顶点）做 contain 适配。
 */
export function Live2DModelView({ url, idleMotion, expression, onError, className }: Live2DModelViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)

  // 回调放 ref 里：不然父组件每次重渲染都会重建回调 → effect 重跑 → 模型反复加载。
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let app: Application | null = null
    let model: Model | null = null
    let observer: ResizeObserver | null = null

    setLoading(true)
    setReady(false)

    void (async () => {
      try {
        await loadCubismCore()
        // pixi.js 单独 import：cubism4 入口自己会去要同一份，Vite 会去重。
        const PIXI = await import('pixi.js')
        const { Live2DModel } = await import('pixi-live2d-display/cubism4')
        if (disposed) return

        const built = new PIXI.Application({
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          // 尺寸由下面手动 resize，不让 pixi 跟着容器乱跳。
          resizeTo: undefined,
        })
        app = built
        // Application 的 options 类型里没声明 resizeTo，运行时其实吃这个值 —— 补上。
        ;(built as unknown as { resizeTo: HTMLElement }).resizeTo = host

        const canvas = built.view as unknown as HTMLCanvasElement
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        canvas.style.display = 'block'
        host.appendChild(canvas)

        const fit = () => {
          const w = Math.max(1, host.clientWidth)
          const h = Math.max(1, host.clientHeight)
          if (built.renderer.width !== w || built.renderer.height !== h) {
            built.renderer.resize(w, h)
          }
        }
        fit()
        observer = new ResizeObserver(fit)
        observer.observe(host)

        // ticker 必须显式交过去。0.5 版的 Automator 只认两种来源：options.ticker，
        // 或者全局 `window.PIXI` —— 我们是动态 import，没有全局，所以不给 ticker
        // 就等于 autoUpdate 全程没挂上：模型不眨眼、不呼吸、待机动作不走，
        // 更要命的是 `pose3.json` 的 PartOpacity 也不会被评估（Haru 的手臂是
        // A/B 两套同位置部件，靠 pose 淡出藏掉一套），于是四只手一起画出来。
        // 注意 `autoInteract` 在 0.5 已拆分，用它每次加载都会打一条 deprecation 警告。
        const loaded = await Live2DModel.from(url, {
          ticker: built.ticker,
          autoHitTest: false,
          autoFocus: false,
        })
        if (disposed) {
          // 0.5 版的 destroy 只吃 options 对象（旧版才吃 `destroy(true, opts)` 那种 pixi 老签名）。
          destroyModel(loaded)
          return
        }
        model = loaded
        built.stage.addChild(loaded as unknown as Parameters<typeof built.stage.addChild>[0])

        // 自动眨眼 / 呼吸 / 待机动作：Automator 默认就开，这里只是把待机动作组指明白。
        // 动作组清单在 Cubism4 的 settings 上（`FileReferences.Motions` 的键，如 "Idle"）。
        // 注意类型声明里 `motions` 只写在 Cubism2 那份上，Cubism4 没暴露 —— 运行时是有的，断言取。
        const motionGroups =
          (loaded.internalModel.settings as unknown as { motions?: Record<string, unknown> })?.motions ?? {}
        const group = idleMotion || Object.keys(motionGroups)[0]
        if (group) void loaded.motion(group)
        if (expression) void loaded.expression(expression)

        /**
         * 每帧把可见轮廓贴到卡片里（contain）。
         * 轮廓 = 所有 drawable 顶点，经 `drawingMatrix` 变换 —— 用的是 SDK 自己算好的
         * 变换矩阵，所以缩放 / 锚点 / 位置怎么变都跟得上，不用自己重推一遍。
         */
        const bounds = { x: 0, y: 0, width: 0, height: 0 }
        const applyLayout = () => {
          if (disposed || !model) return
          const rw = built.renderer.width
          const rh = built.renderer.height
          const im = model.internalModel as unknown as { getDrawableVertices(i: number | string): Float32Array }
          let count = 0
          try {
            count = (im as unknown as { coreModel: { getDrawableCount(): number } }).coreModel.getDrawableCount()
          } catch {
            return
          }

          let minX = Infinity
          let minY = Infinity
          let maxX = -Infinity
          let maxY = -Infinity
          const m = model.worldTransform
          for (let i = 0; i < count; i++) {
            let verts: Float32Array
            try {
              verts = im.getDrawableVertices(i)
            } catch {
              continue
            }
            for (let k = 0; k < verts.length; k += 2) {
              const x = m.a * verts[k] + m.c * verts[k + 1] + m.tx
              const y = m.b * verts[k] + m.d * verts[k + 1] + m.ty
              if (x < minX) minX = x
              if (y < minY) minY = y
              if (x > maxX) maxX = x
              if (y > maxY) maxY = y
            }
          }
          if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return

          bounds.x = minX
          bounds.y = minY
          bounds.width = maxX - minX
          bounds.height = maxY - minY

          const pad = 0.94 // 留一点边，别顶满
          const scale = Math.min(rw / (bounds.width / pad), rh / (bounds.height / pad))
          const cx = bounds.x + bounds.width / 2
          const cy = bounds.y + bounds.height / 2
          model.scale.set(scale)
          model.position.set(rw / 2 - (cx - model.x) * scale, rh / 2 - (cy - model.y) * scale)
        }

        // 每帧在渲染前跑（priority 高于 pixi 自己那套 render 优先级，抢在渲染前生效）。
        built.ticker.add(applyLayout, undefined, (PIXI as any).UPDATE_PRIORITY?.HIGH ?? 25)

        if (!disposed) {
          setReady(true)
          setLoading(false)
        }
      } catch (err) {
        if (disposed) return
        const msg = err instanceof Error ? err.message : String(err)
        setLoading(false)
        onErrorRef.current?.(msg)
      }
    })()

    return () => {
      disposed = true
      observer?.disconnect()
      try {
        if (model) destroyModel(model)
      } catch {
        /* 销毁失败就算了，下面还有一层兜底 */
      }
      try {
        app?.destroy(true, { children: true, texture: true, baseTexture: true })
      } catch {
        /* 同上 */
      }
      // 兜底：pixi 的 destroy 偶尔会留下 canvas（旧版本 / 异常路径），直接摘干净。
      for (const el of Array.from(host.querySelectorAll('canvas'))) el.remove()
    }
  }, [url, idleMotion, expression])

  return (
    <div className={className ?? 'relative h-full w-full'}>
      <div ref={hostRef} className="absolute inset-0" />
      {loading && !ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[var(--text-3)]">
          正在加载 Live2D 模型…
        </div>
      )}
    </div>
  )
}
