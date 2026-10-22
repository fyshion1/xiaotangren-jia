import { useEffect, useState } from 'react'
import UiIcon from '../visual/UiIcon'

type Props = {
  context: { role: string; content: string; images?: string[] }[]
  lastSent?: { model: string; messages: { role: string; text: string; image_count: number }[] }
  historyLimit: number
  onInspect: () => void
  onClose: () => void
}

export default function MemoryPanel({ context, lastSent, historyLimit, onInspect, onClose }: Props) {
  const [tab, setTab] = useState<'context' | 'sent'>('context')
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const images = context.reduce((n,m) => n + (m.images?.length || 0),0)
  return <div className="memory-backdrop" onClick={onClose}>
    <section className="context-notebook" role="dialog" aria-modal="true" aria-labelledby="context-title" onClick={e => e.stopPropagation()}>
      <header className="context-heading"><span className="context-emblem"><UiIcon name="memory" size={23}/></span><div><span className="memory-eyebrow">此刻记得的事</span><h2 id="context-title">短期记忆 · 当前会话</h2></div><button className="btn sm ghost" onClick={onClose}>关闭</button></header>
      <p className="context-intro">聊天与图片、视频自动保存在本地。这里查看她们下一轮能读到的上下文，无需手动挑选。</p>
      <div className="context-metrics"><span><b>{context.length}</b>条上下文</span><span><b>{images}</b>张图片 / 视频帧</span><span><b>{historyLimit > 0 ? historyLimit : '全部'}</b>历史窗口</span></div>
      <nav className="memory-tabs"><button className={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}>下一轮上下文</button><button className={tab === 'sent' ? 'active' : ''} onClick={() => setTab('sent')}>最近实际发送</button></nav>
      <div className="context-scroll">
        {tab === 'context' && (context.length ? context.map((m,i) => <article className={`context-message ${m.role}`} key={i}>
          <div className="context-message-label"><span>{m.role === 'user' ? '你' : '小糖人'}</span><small>#{i + 1}</small></div>
          <details open={m.role === 'user' || m.content.length < 220}><summary>{m.role === 'user' ? '原始消息' : '对话内容'} · {m.content.length} 字</summary><p>{m.content}</p></details>
          {!!m.images?.length && <div className="context-images">{m.images.map((url,j) => <a href={url} target="_blank" rel="noreferrer" key={j}><img src={url} alt={`上下文图片 ${j+1}`}/></a>)}</div>}
        </article>) : <div className="memory-empty">还没有对话，聊点今天发生的事吧。</div>)}
        {tab === 'sent' && <><p className="context-note">{lastSent ? `模型：${lastSent.model}` : '本次打开页面后暂无发送记录。'} · 记录表示请求包含的内容，不代表上游已成功识图。</p>{lastSent?.messages.map((m,i) => <details className="context-message" key={i}><summary>{i+1}. {m.role} · {m.image_count} 张图片 · {m.text.length} 字</summary><p>{m.text}</p></details>)}</>}
      </div>
      <footer className="context-footer"><span>当天事件会自动整理，前往私人空间的 03 审核。</span><button className="btn sm ghost" onClick={onInspect}>核对完整提示词</button></footer>
    </section>
  </div>
}
