/**
 * 角色 → 本机实机模型的绑定（§36 试点）。
 *
 * 为什么不写进后端档案：`live2d` / `vrm` 里的值只是**素材清单的 key**
 * （见 `live2dAssets.ts` / `vrmAssets.ts`），而素材放在仓库根 `assets/`、
 * 只在本机 dev server 可取，且 Cubism 官方样例**不可再分发**（assets/LICENSE.md）。
 * 也就是说这份绑定跟这台机器强相关，留在前端、跟素材清单放一起最不容易漂。
 * 将来要对外发布时，把这里换成自产素材的 key 即可。
 *
 * 优先级：角色档案里自己填了 `live2d.model` / `vrm.model` 就用档案的；
 * 没填才落到这张表 —— 这样以后给角色配模型可以先在编辑器里改，不用动代码。
 */
export type ModelBinding = {
  live2d?: string
  vrm?: string
}

export {MODEL_BINDINGS} from '#theme/modelBindings'
import {MODEL_BINDINGS} from '#theme/modelBindings'

export function modelBindingFor(charId: string | undefined): ModelBinding {
  if (!charId) return {}
  return MODEL_BINDINGS[charId] ?? {}
}
