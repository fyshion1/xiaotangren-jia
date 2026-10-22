import { useDismissableDetails } from './useDismissableDetails'
import UiIcon, { type IconName } from './UiIcon'
import { useAppearance, type Palette } from './appearanceState'
const palettes: { id: Palette; name: string; desc: string; colors: string[] }[] = [
  {
    id: 'rose',
    name: '玫瑰棉糖',
    desc: '现在这套粉色，轻盈而明亮',
    colors: ['#fff9fc', '#ed5b98', '#9fcde8'],
  },
  {
    id: 'cream',
    name: '奶油烘焙',
    desc: '原版暖色重绘，奶油、蜜桃与薄荷',
    colors: ['#fbf5eb', '#d49a79', '#9cbaad'],
  },
  {
    id: 'starlight',
    name: '夜间星轨',
    desc: '淡紫与蓝，夜间更安静',
    colors: ['#f6f4fc', '#a48ad0', '#8aaed5'],
  },
]
const samples: { name: IconName; label: string }[] = [
  { name: 'home', label: '小窝' },
  { name: 'person', label: '空间' },
  { name: 'characters', label: '角色' },
  { name: 'chat', label: '聊天' },
  { name: 'gallery', label: '画廊' },
  { name: 'book', label: '世界书' },
  { name: 'memory', label: '记忆' },
  { name: 'game', label: '一起玩' },
  { name: 'mic', label: '语音' },
  { name: 'settings', label: '设置' },
  { name: 'heart', label: '羁绊' },
  { name: 'spark', label: '灵感' },
]
export default function AppearanceSwitcher() {
  const { palette, setPalette, icons, setIcons } = useAppearance()
  const detailsRef = useDismissableDetails()
  return (
    <details ref={detailsRef} className="appearance-switcher">
      <summary aria-label="主题">
        <UiIcon name="palette" />
        <span>主题</span>
      </summary>
      <div className="appearance-panel">
        <h2>给日常，换一种温度。</h2>
        <p>色彩主题</p>
        <div className="palette-options">
          {palettes.map((p) => (
            <button key={p.id} onClick={() => setPalette(p.id)} aria-pressed={palette === p.id}>
              <span className="palette-colors">
                {p.colors.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>{p.desc}</small>
              </span>
              {palette === p.id && <UiIcon name="check" size={17} />}
            </button>
          ))}
        </div>
        <p>图标样式</p>
        <div className="icon-style-options">
          <button aria-pressed={icons === 'duotone'} onClick={() => setIcons('duotone')}>
            柔彩双层
          </button>
          <button aria-pressed={icons === 'regular'} onClick={() => setIcons('regular')}>
            轻盈线条
          </button>
        </div>
        <div className="icon-sampler">
          {samples.map((s) => (
            <div key={s.name}>
              <UiIcon name={s.name} size={24} />
              <span>{s.label}</span>
            </div>
          ))}
        </div>
        <small className="appearance-hint">日间 / 夜间可独立切换，选择会保存在本机。</small>
      </div>
    </details>
  )
}
