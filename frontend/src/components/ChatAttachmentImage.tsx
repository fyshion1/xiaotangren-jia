import { useState } from 'react'
import type { ChatMessage } from '../data/chats'

type Props = Pick<ChatMessage, 'image' | 'imageOrig' | 'imageSource'>

/** JPEG thumbnails cannot animate. QQ may also label GIF bytes as PNG. */
export default function ChatAttachmentImage(props: Props) {
  return <AttachmentImage key={`${props.imageOrig}:${props.image}:${props.imageSource}`} {...props} />
}

function AttachmentImage({ image, imageOrig, imageSource }: Props) {
  const [failedOriginal, setFailedOriginal] = useState(false)
  const animated = /\.(?:gif|webp|apng)(?:[?#]|$)/i.test(imageOrig || '')
  const useOriginal = imageSource !== 'video' && (animated || imageSource === 'qq' || imageSource === 'sticker')
  const original = useOriginal && imageOrig && imageOrig !== image ? imageOrig : undefined
  return <img src={!failedOriginal && original ? original : image} alt="图片" className="max-h-48 rounded-lg"
    onError={() => { if (original && !failedOriginal) setFailedOriginal(true) }} />
}
