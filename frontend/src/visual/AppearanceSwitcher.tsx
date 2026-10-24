import {useState} from 'react'
import {useDismissableDetails} from './useDismissableDetails'
import {applyCorePalette,corePalettes,readCorePalette} from './coreAppearance'

export default function AppearanceSwitcher() {
  const [palette,setPalette]=useState(readCorePalette)
  const ref=useDismissableDetails()
  return <details ref={ref} className="core-appearance">
    <summary aria-label="外观">外观</summary>
    <section aria-label="外观预设" className="core-appearance-panel">
      <h2>外观</h2><p>选择常用配色，日夜模式沿用当前设置。偏好保存在此浏览器。</p>
      <div className="core-palette-options">{corePalettes.map(item=><button type="button" key={item.id} aria-pressed={palette===item.id} onClick={()=>{setPalette(item.id);applyCorePalette(item.id)}}>
        <span aria-hidden="true" className="core-palette-swatches">{item.colors.map(color=><i key={color} style={{background:color}}/>)}</span>
        {item.name}<span aria-hidden="true">{palette===item.id?' ✓':''}</span>
      </button>)}</div>
    </section>
  </details>
}
