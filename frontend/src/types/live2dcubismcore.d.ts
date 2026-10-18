/**
 * Live2D Cubism Core 的类型声明（§36）。
 *
 * 运行时只有一份压缩过的原生 JS（`live2dcubismcore.min.js`，挂在 `window.Live2DCubismCore`），
 * 官方**没有**随包发 TypeScript 声明、npm 上也没有 `@types/live2dcubismcore`，
 * 所以这里只写我们真正用到的部分，够编译过即可 —— 需要别的 API 时按
 * 《Cubism Native API 手册》补形状就行。
 */

declare namespace Live2DCubismCore {
  interface CanvasInfo {
    CanvasWidth: number
    CanvasHeight: number
    PixelsPerUnit: number
  }

  interface Model {
    canvasinfo: CanvasInfo
    getDrawableCount(): number
    getDrawableIds(): string[]
    getDrawableIndex(id: string): number
    getDrawableVertices(index: number): Float32Array
    getDrawableVertexCount(index: number): number
    getParameterCount(): number
    getParameterId(index: number): string
    getParameterIndex(id: string): number
    getParameterValueByIndex(index: number): number
    setParameterValueByIndex(index: number, value: number, weight?: number): void
    addParameterValueByIndex(index: number, value: number, weight?: number): void
    update(): void
    release(): void
  }

  interface Moc {
    fromArrayBuffer(buffer: ArrayBuffer): Model
    prototype: Moc
  }

  interface Core {
    Version: string
    csmGetVersion(): number
    Moc: Moc
  }
}

interface Window {
  Live2DCubismCore?: Live2DCubismCore.Core
}
