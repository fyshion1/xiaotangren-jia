import { useState } from 'react'
import UiIcon from './UiIcon'

export default function NestWelcomeSettings() {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem('xtr.visual.boot-enabled') === 'true'
    } catch {
      return false
    }
  })
  const [who, setWho] = useState(() => {
    try {
      return localStorage.getItem('xtr.visual.boot-character') || 'current'
    } catch {
      return 'current'
    }
  })
  const [notice, setNotice] = useState('')
  return (
    <div className="nest-welcome-settings">
      <div className="nest-room-heading">
        <div>
          <span className="nest-section-note">让每次回来，都有一点喜欢</span>
          <h2>外观与入场</h2>
          <p>色彩、相册边的小贴纸，以及未来的入场问候。</p>
        </div>
      </div>
      <section className="nest-preference-card">
        <div className="nest-pref-icon">
          <UiIcon name="spark" size={25} />
        </div>
        <div className="nest-pref-copy">
          <h3>
            启动动画 <span className="nest-reserved">入口预留</span>
          </h3>
          <p>打开应用时，一段短短的角色问候。随时可以关闭。</p>
          <p className="nest-pref-caption">当前保存本机入场偏好，启动动画尚未接入播放。</p>
        </div>
        <button
          className="nest-toggle"
          role="switch"
          aria-label="启动动画"
          aria-checked={enabled}
          onClick={() => {
            const value = !enabled
            setEnabled(value)
            try {
              localStorage.setItem('xtr.visual.boot-enabled', String(value))
            } catch {}
            setNotice(
              value ? '已保存启用偏好；素材尚未接入，不会自动播放。' : '已保存：关闭启动动画。',
            )
          }}
        >
          <span />
        </button>
      </section>
      <div className="nest-boot-options">
        <label htmlFor="nest-boot-character">谁来迎接你</label>
        <select
          id="nest-boot-character"
          value={who}
          disabled={!enabled}
          onChange={(e) => {
            setWho(e.target.value)
            try {
              localStorage.setItem('xtr.visual.boot-character', e.target.value)
            } catch {}
          }}
        >
          <option value="current">跟随当前角色</option>
          <option value="random">随机一位</option>
          <option value="shiyin">大诗音</option>
          <option value="koshion">小诗音</option>
          <option value="shiro">小白</option>
        </select>
        <p>作为可调整的候选策略保存，具体动画素材后续确定。</p>
        <div className="nest-boot-principles">
          <span>
            <UiIcon name="check" size={16} />
            短暂、可跳过
          </span>
          <span>
            <UiIcon name="check" size={16} />
            静音起播
          </span>
          <span>
            <UiIcon name="check" size={16} />
            失败直接进入
          </span>
        </div>
      </div>
      {notice && (
        <p role="status" className="nest-saved-note">
          {notice}
        </p>
      )}
      <section className="nest-preference-card">
        <div className="nest-pref-icon">
          <UiIcon name="gallery" size={25} />
        </div>
        <div className="nest-pref-copy">
          <h3>页头小贴纸</h3>
          <p>左右贴纸仍由「共同回忆」画廊管理，支持分别选图与调整构图。</p>
          <p className="nest-pref-caption">可在共同回忆的「页头小贴纸」中选图、隐藏与调整构图。</p>
        </div>
      </section>
      <section className="nest-preference-card">
        <div className="nest-pref-icon">
          <UiIcon name="paint" size={25} />
        </div>
        <div className="nest-pref-copy">
          <h3>色彩主题</h3>
          <p>使用顶部「主题」切换玫瑰棉糖、奶油烘焙与夜间星轨，日夜模式独立切换。</p>
        </div>
      </section>
    </div>
  )
}
