/**
 * Live2D 素材清单（§36）。
 *
 * 模型文件放在仓库根的 `assets/live2d/`（Vite 用 `publicDir` 指过去，见 vite.config.ts），
 * 运行时以 `/assets/...` 取 —— **不进前端构建产物**，只在本机 dev server 里按需拉取。
 *
 * ⚠️ Haru / Hiyori 是 Live2D 官方样例（Free Material License）：**仅限本机私人使用，
 * 禁止再分发**。详见 `assets/LICENSE.md`。所以：该目录受 `publicDirExclude` 保护，
 * 打包（vite build）时不复制；对外发布前必须换成自产/可分发素材。
 */

export type Live2DAsset = {
  /** key：角色数据里 `live2d.model` 存的就是这个。 */
  id: string
  name: string
  /** 相对仓库根 assets/live2d 的 .model3.json 路径（会拼成 /assets 下的 URL）。 */
  model3: string
  /** 有值就用它当待机动作组名，没有则用模型自带的第一个动作组。 */
  idleMotion?: string
  /** 打开展示用的默认表情名。 */
  expression?: string
}

/** 仓库根 assets/ 在 dev server 下的访问前缀（跟 vite.config.ts 的 publicDir 对齐）。 */
export const ASSETS_BASE = '/assets'

export const LIVE2D_ASSETS: Live2DAsset[] = [
  {
    id: 'cubism-haru',
    name: 'Haru（Cubism 官方样例）',
    model3: 'live2d/CubismSamples/Haru/Haru.model3.json',
    idleMotion: 'Idle',
    expression: 'F03',
  },
  {
    id: 'cubism-hiyori',
    name: 'Hiyori（Cubism 官方样例）',
    model3: 'live2d/CubismSamples/Hiyori/Hiyori.model3.json',
  },
]

export function resolveLive2DAsset(id: string | undefined): Live2DAsset | null {
  if (!id) return null
  return LIVE2D_ASSETS.find((a) => a.id === id) ?? null
}

/** 模型清单项的地址：`/assets/live2d/.../X.model3.json`。 */
export function live2dUrl(asset: Live2DAsset): string {
  return `${ASSETS_BASE}/${asset.model3}`
}
