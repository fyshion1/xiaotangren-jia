// 角色头像（《项目要求》§8）：有 avatar 图就用图，没有就退回 emoji 占位。
// 聊天气泡、群聊分段说话人、会话列表共用这一处 —— 别再各写一份「有图用图不然 emoji」。
// 拿不到角色档案（例如群聊分段只给了名字）时由调用方传 name/emoji，这里只负责渲染。

type Props = {
  /** 角色名：img 的 alt，以及 emoji 兜底时的可读性保障。 */
  name: string
  /** 头像图片 URL（未填则用 emoji）。 */
  avatar?: string
  /** 兜底 emoji（未填则用名字首字）。 */
  emoji?: string
  /** 直径（px）。 */
  size?: number
  className?: string
  title?: string
}

export default function Avatar({ name, avatar, emoji, size = 28, className = '', title }: Props) {
  const style = { width: size, height: size }
  const label = emoji || [...name][0] || '？'

  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        title={title ?? name}
        style={style}
        className={`shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-2)] object-cover ${className}`}
      />
    )
  }

  return (
    <span
      title={title ?? name}
      style={{ ...style, fontSize: Math.round(size * 0.56) }}
      className={`flex shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--pink-soft)] leading-none ${className}`}
    >
      {label}
    </span>
  )
}
