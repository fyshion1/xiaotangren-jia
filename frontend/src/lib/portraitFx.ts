// 立绘的视觉处理（《项目要求》§19）。
//
// 1) extractPalette —— 从图里量出几个主色，给占位区铺一层柔和的模糊色底。
//    立绘多数是**不透明**的整幅画，直接 object-contain 会留下生硬的直角留白；
//    参考图（Jellyfish 那种纵向色带）的做法是让颜色自己化开，所以这里取图里的
//    真实颜色做底，而不是拿一个固定底色硬填。
// 2) firstFrameOf —— GIF 的首帧静态图，用来实现「鼠标移上去才播放」。

export type Palette = {
  /** 由多到少的主色（hex，形如 '#f3c9d8'）。取不到任何不透明像素时为空数组。 */
  colors: string[]
  /** 不透明像素占比 0~1。透明 PNG 会很低 —— 调用方据此加大底色的柔和度。 */
  ratio: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 附件走同源 /api/files，加这个不影响；外链图若没开 CORS 会读不了像素 —— 见下方 catch
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`图片加载失败：${src}`))
    img.src = src
  })
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/**
 * 量一张图的主色。任何一步失败（外链跨域、解码失败、canvas 被污染）都返回 null，
 * 调用方退回不做色底 —— 视觉降级，绝不因为取色失败让图显示不出来。
 */
export async function extractPalette(src: string, count = 4): Promise<Palette | null> {
  if (!src) return null
  try {
    const img = await loadImage(src)
    const nw = img.naturalWidth || img.width
    const nh = img.naturalHeight || img.height
    if (!nw || !nh) return null

    // 缩到 48px 以内再统计：够代表整体色调，又不至于逐像素跑满
    const scale = Math.min(1, 48 / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * scale))
    const h = Math.max(1, Math.round(nh * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)

    // 按每通道 32 分桶（= 粗量化），统计出现最多的几种颜色
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
    let opaque = 0
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]
      if (a < 16) continue // 全透明像素不参与 —— 透明 PNG 的「主色」不该是空气
      opaque++
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5)
      const cur = buckets.get(key)
      if (cur) {
        cur.n++
        cur.r += r
        cur.g += g
        cur.b += b
      } else {
        buckets.set(key, { n: 1, r, g, b })
      }
    }
    const total = data.length / 4
    if (!opaque) return { colors: [], ratio: 0 }

    const colors = [...buckets.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, count)
      .map((c) => toHex(Math.round(c.r / c.n), Math.round(c.g / c.n), Math.round(c.b / c.n)))

    return { colors, ratio: opaque / total }
  } catch {
    return null
  }
}

/**
 * 取 GIF（或任意图）的**首帧**，转成静态 dataURL。
 * 失败返回 null —— 调用方退回直接用原图（那就只能一直播放了，但至少能看见）。
 */
export async function firstFrameOf(src: string): Promise<string | null> {
  if (!src) return null
  try {
    const img = await loadImage(src)
    const nw = img.naturalWidth || img.width
    const nh = img.naturalHeight || img.height
    if (!nw || !nh) return null
    const scale = Math.min(1, 720 / nw)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(nw * scale))
    canvas.height = Math.max(1, Math.round(nh * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** 是不是 GIF（按扩展名判断；附件 URL 形如 /api/files/xx/orig/m-1a2b.gif）。 */
export function isGif(src: string): boolean {
  return /\.gif(\?|#|$)|[?&]format=gif(?:&|#|$)|^data:image\/gif;/i.test(src)
}

/** 主色阵列 → 一条柔和的横向渐变，用作占位区的色底。 */
export function paletteGradient(colors: string[]): string {
  if (!colors.length) return 'transparent'
  if (colors.length === 1) return colors[0]
  // 首尾各重复一次，让色带从两边化开、不在正中形成一条硬缝
  const stops = [colors[0], ...colors, colors[colors.length - 1]]
  return `linear-gradient(100deg, ${stops.join(', ')})`
}
