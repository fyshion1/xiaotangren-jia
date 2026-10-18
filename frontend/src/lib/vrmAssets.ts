/**
 * 3D 素材清单（§36）：VRM 人形模型。
 *
 * 文件和 Live2D 一样放在仓库根 `assets/models/vrm/`，dev server 以
 * `/assets/models/vrm/xxx.vrm` 取（见 vite.config.ts 的 publicDir）。
 *
 * ⚠️ 授权：`AliciaSolid` / `VRM1_Constraint_Twist_Sample` 都是**仅本机使用**的样例素材，
 * 详见 `assets/LICENSE.md`。真要当大诗音用，后续用 VRoid Studio 自产 VRM（授权自持）。
 */

export type VrmAsset = {
  id: string
  name: string
  /** 相对仓库根 assets/models/vrm 的文件名。 */
  file: string
  /** 面板上写一句这个模型是干嘛的 / 有什么限制。 */
  note: string
}

import { ASSETS_BASE } from './live2dAssets'

export const VRM_ASSETS: VrmAsset[] = [
  {
    id: 'vrm1-constraint-sample',
    name: 'VRM1 约束样例（pixiv）',
    file: 'VRM1_Constraint_Twist_Sample.vrm',
    note: 'VRM 1.0 + SpringBone 技术样例，机械性测试模型 —— 用来验证导入管线通不通。',
  },
  {
    id: 'alicia',
    name: 'Alicia Solid（完整人形）',
    file: 'AliciaSolid_vrm-0.51.vrm',
    note: 'VRM 0.x 完整人形，形象完整但授权条款不明确，仅本机预览。',
  },
]

export function resolveVrmAsset(id: string | undefined): VrmAsset | null {
  if (!id) return null
  return VRM_ASSETS.find((a) => a.id === id) ?? null
}

export function vrmUrl(asset: VrmAsset): string {
  return `${ASSETS_BASE}/models/vrm/${asset.file}`
}
