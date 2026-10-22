import type { CSSProperties } from 'react'
import type { CharacterProfile } from '../data/characters'
import { resolveForm } from '../lib/forms'
import { profileSignature } from '../lib/profileDisplay'

const accents: Record<string, { color: string; soft: string }> = {
  dashiyin: { color: '#e34c8c', soft: '#fff0f6' },
  xiaoshiyin: { color: '#e88b3c', soft: '#fff5e9' },
  xiaobai: { color: '#a975d3', soft: '#f8f0ff' },
  xizi: { color: '#4c9fc1', soft: '#edf8ff' },
}
export default function CharacterStage({ p, onChat }: { p: CharacterProfile; onChat?: () => void }) {
  const v = resolveForm(p).profile
  const purpleForm = p.id === 'dashiyin' && /紫/.test(v.hairColor || '')
  const accent = (purpleForm ? { color: '#8c63cb', soft: '#ece7fc' } : accents[p.id]) || {
    color: 'var(--pink-deep)',
    soft: 'var(--pink-soft)',
  }
  const description = v.aboutZh?.trim() || v.about?.trim()
  const signature = profileSignature(v)
  return (
    <div
      className="character-design"
      style={{ '--role': accent.color, '--role-soft': accent.soft } as CSSProperties}
    >
      <section className={'character-stage role-' + p.id}>
        <div className="stage-art">
          {v.portrait && !v.hiddenFields?.includes('portrait') ? (
            <>
              <img className="art-echo" src={v.portrait} alt="" aria-hidden="true" />
              <img className="art-main" src={v.portrait} alt={v.name} />
            </>
          ) : (
            <div className="art-empty" aria-label={v.name}>
              {v.emoji}
            </div>
          )}
        </div>
        <div className="stage-intro">
          <h1>{v.name}</h1>
          {!v.hiddenFields?.includes('signature') && signature && <div className="stage-sign">{signature}</div>}
          <div className="stage-story" hidden={v.hiddenFields?.includes('about')}>
            <p>
              {description
                ? description.slice(0, 240) + (description.length > 240 ? '…' : '')
                : (!v.hiddenFields?.includes('catchphrase') && v.catchphrase) || '欢迎认识家里的这一位。'}
            </p>
          </div>
          {onChat && <div className="stage-actions">
            <button className="stage-chat-invite" data-invite="c2" onClick={onChat}>
              <span>和她聊聊</span>
              <span className="invite-arrow" aria-hidden="true">
                ↗
              </span>
            </button>
          </div>}
        </div>
      </section>
    </div>
  )
}
