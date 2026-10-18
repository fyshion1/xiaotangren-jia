import { useEffect, useRef, useState } from 'react'

/**
 * 把一个 VRM 人形模型画在卡片里（§36 正式接入，替换原来的「占位」字样）。
 *
 * 做的是「能看、动一动」这一档：导入 → 摆正 → 按身高自动入画 → 自己慢慢转圈，
 * 有 idle 动画就播。**不做**：表情 / 骨骼操作 / 与聊天联动（那是后面的事）。
 *
 * 两个必需的坑点：
 * - `VRMUtils.rotateVRM0()`：VRM 0.x 模型面朝 −Z，直接放进 three 里是**背对镜头**的。
 * - `combineSkeletons()`：合并骨架，省一次 matrixWorld 更新（three-vrm 官方推荐）。
 */
const DEG = Math.PI / 180

export type VrmModelViewProps = {
  /** .vrm 的 URL（`/assets/models/vrm/...`）。变化时重新加载。 */
  url: string
  /** 加载失败时把原因交给外层显示。 */
  onError?: (message: string) => void
  className?: string
}

export function VrmModelView({ url, onError, className }: VrmModelViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  // 鼠标按住拖 = 手动转视角；松手后继续自己转。
  const dragRef = useRef<{ dragging: boolean; lastX: number }>({ dragging: false, lastX: 0 })

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let disposeAll: (() => void) | null = null

    setLoading(true)
    setReady(false)

    void (async () => {
      try {
        const [THREE, { GLTFLoader }, { VRMLoaderPlugin, VRMUtils }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('@pixiv/three-vrm'),
        ])
        if (disposed) return

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.setClearAlpha(0)
        renderer.domElement.style.width = '100%'
        renderer.domElement.style.height = '100%'
        renderer.domElement.style.display = 'block'
        host.appendChild(renderer.domElement)

        const scene = new THREE.Scene()
        const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
        camera.position.set(0, 1.25, 2.4)

        // 卡片这一档不需要写实光照：半球光把全身照亮 + 正面一盏补光。
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8d7d8a, 1.1))
        const key = new THREE.DirectionalLight(0xffffff, 0.85)
        key.position.set(0.6, 2.2, 2.6)
        scene.add(key)

        const clock = new THREE.Clock()
        let root: import('three').Object3D | null = null
        let vrm: { update(dt: number): void; scene?: unknown } | null = null

        const resize = () => {
          const w = Math.max(1, host.clientWidth)
          const h = Math.max(1, host.clientHeight)
          renderer.setSize(w, h, false)
          camera.aspect = w / h
          camera.updateProjectionMatrix()
        }
        resize()
        const observer = new ResizeObserver(resize)
        observer.observe(host)

        // ── 载入 ────────────────────────────────────────────────────────────
        const loader = new GLTFLoader()
        loader.register((parser) => new VRMLoaderPlugin(parser))
        const gltf = await new Promise<any>((resolve, reject) => {
          loader.load(url, resolve, undefined, (e) => reject(e instanceof Error ? e : new Error('模型读取失败')))
        })
        if (disposed) {
          renderer.dispose()
          renderer.domElement.remove()
          return
        }

        const loaded = gltf.userData.vrm
        if (!loaded) throw new Error('这个文件里没有 VRM 数据（是不是传错格式了）')
        vrm = loaded as { update(dt: number): void; scene?: unknown }
        root = loaded.scene as import('three').Object3D

        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.combineSkeletons(gltf.scene)
        // VRM 0.x 面朝 −Z：不转会背对镜头。1.x 调了也是空操作，可以无脑调。
        VRMUtils.rotateVRM0(loaded)
        root.traverse((obj: import('three').Object3D & { frustumCulled?: boolean }) => {
          obj.frustumCulled = false // 逐帧算包围盒太贵，人形模型关掉剔除更稳
        })

        // 有 idle 动画就播（Alicia 这类成品模型带；技术样例模型没有，跳过）。
        if (gltf.animations?.length) {
          const mixer = new THREE.AnimationMixer(root)
          mixer.clipAction(gltf.animations[0]).play()
          const baseUpdate = vrm!.update.bind(vrm)
          vrm!.update = (dt: number) => {
            mixer.update(dt)
            baseUpdate(dt)
          }
        }

        scene.add(root)

        // ── 按身高入画：人形模型身高差很大，写死机位会顶到框外/小得看不清 ──────
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        const height = size.y || 1.6
        const fitDistance = (height * 1.08) / (2 * Math.tan((camera.fov * DEG) / 2))
        camera.position.set(0, height * 0.55, fitDistance * 1.06)
        camera.lookAt(0, height * 0.5, 0)

        // ── 转圈 + 拖拽 ─────────────────────────────────────────────────────
        const pivot = new THREE.Group()
        pivot.add(root)
        scene.add(pivot)
        const el = renderer.domElement
        const onDown = (e: PointerEvent) => {
          dragRef.current = { dragging: true, lastX: e.clientX }
          el.setPointerCapture(e.pointerId)
        }
        const onMove = (e: PointerEvent) => {
          if (!dragRef.current.dragging) return
          pivot.rotation.y += (e.clientX - dragRef.current.lastX) * 0.01
          dragRef.current.lastX = e.clientX
        }
        const onUp = (e: PointerEvent) => {
          dragRef.current.dragging = false
          try {
            el.releasePointerCapture(e.pointerId)
          } catch {
            /* 指针早就没了，无所谓 */
          }
        }
        el.style.cursor = 'grab'
        el.addEventListener('pointerdown', onDown)
        el.addEventListener('pointermove', onMove)
        el.addEventListener('pointerup', onUp)
        el.addEventListener('pointercancel', onUp)

        let raf = 0
        const tick = () => {
          raf = requestAnimationFrame(tick)
          const dt = Math.min(clock.getDelta(), 0.05)
          if (!dragRef.current.dragging) pivot.rotation.y += dt * 0.35
          vrm?.update(dt)
          renderer.render(scene, camera)
        }
        tick()

        disposeAll = () => {
          cancelAnimationFrame(raf)
          observer.disconnect()
          el.removeEventListener('pointerdown', onDown)
          el.removeEventListener('pointermove', onMove)
          el.removeEventListener('pointerup', onUp)
          el.removeEventListener('pointercancel', onUp)
          scene.clear()
          renderer.dispose() // 连同它创建的 WebGL 上下文一起释放
          el.remove()
        }

        if (!disposed) {
          setReady(true)
          setLoading(false)
        }
      } catch (err) {
        if (disposed) return
        setLoading(false)
        onErrorRef.current?.(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      disposed = true
      disposeAll?.()
      for (const el of Array.from(host.querySelectorAll('canvas'))) el.remove()
    }
  }, [url])

  return (
    <div className={className ?? 'relative h-full w-full'}>
      <div ref={hostRef} className="absolute inset-0 cursor-grab touch-none" />
      {loading && !ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[var(--text-3)]">
          正在加载 3D 模型…
        </div>
      )}
      {ready && (
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] text-[var(--text-3)]">
          按住拖动可转视角
        </span>
      )}
    </div>
  )
}
