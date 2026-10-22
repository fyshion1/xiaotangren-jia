import { useAppearance } from './appearanceState'
import { HouseLine } from '@phosphor-icons/react/dist/csr/HouseLine'
import { UserCircle } from '@phosphor-icons/react/dist/csr/UserCircle'
import { UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree'
import { ChatCircleDots } from '@phosphor-icons/react/dist/csr/ChatCircleDots'
import { PawPrint } from '@phosphor-icons/react/dist/csr/PawPrint'
import { GearSix } from '@phosphor-icons/react/dist/csr/GearSix'
import { Palette } from '@phosphor-icons/react/dist/csr/Palette'
import { MoonStars } from '@phosphor-icons/react/dist/csr/MoonStars'
import { Sun } from '@phosphor-icons/react/dist/csr/Sun'
import { Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle'
import { Images } from '@phosphor-icons/react/dist/csr/Images'
import { Brain } from '@phosphor-icons/react/dist/csr/Brain'
import { PaintBrush } from '@phosphor-icons/react/dist/csr/PaintBrush'
import { Microphone } from '@phosphor-icons/react/dist/csr/Microphone'
import { SpeakerHigh } from '@phosphor-icons/react/dist/csr/SpeakerHigh'
import { StopCircle } from '@phosphor-icons/react/dist/csr/StopCircle'
import { Phone } from '@phosphor-icons/react/dist/csr/Phone'
import { VideoCamera } from '@phosphor-icons/react/dist/csr/VideoCamera'
import { Trash } from '@phosphor-icons/react/dist/csr/Trash'
import { IdentificationCard } from '@phosphor-icons/react/dist/csr/IdentificationCard'
import { LockKey } from '@phosphor-icons/react/dist/csr/LockKey'
import { LockKeyOpen } from '@phosphor-icons/react/dist/csr/LockKeyOpen'
import { BookOpen } from '@phosphor-icons/react/dist/csr/BookOpen'
import { GameController } from '@phosphor-icons/react/dist/csr/GameController'
import { Wrench } from '@phosphor-icons/react/dist/csr/Wrench'
import { Mailbox } from '@phosphor-icons/react/dist/csr/Mailbox'
import { RocketLaunch } from '@phosphor-icons/react/dist/csr/RocketLaunch'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
import { Heart } from '@phosphor-icons/react/dist/csr/Heart'
import { FlowerLotus } from '@phosphor-icons/react/dist/csr/FlowerLotus'
import { Coffee } from '@phosphor-icons/react/dist/csr/Coffee'
import { Cookie } from '@phosphor-icons/react/dist/csr/Cookie'
import { MusicNotes } from '@phosphor-icons/react/dist/csr/MusicNotes'
import { ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft'
import { PaperPlaneRight } from '@phosphor-icons/react/dist/csr/PaperPlaneRight'
import { DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple'
import { ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise'
import { LinkSimple } from '@phosphor-icons/react/dist/csr/LinkSimple'
import { Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { FolderSimple } from '@phosphor-icons/react/dist/csr/FolderSimple'
import { NotePencil } from '@phosphor-icons/react/dist/csr/NotePencil'
import { CalendarBlank } from '@phosphor-icons/react/dist/csr/CalendarBlank'
import { ChatTeardropText } from '@phosphor-icons/react/dist/csr/ChatTeardropText'
import { WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle'
import { Diamond } from '@phosphor-icons/react/dist/csr/Diamond'
const icons = {
  home: HouseLine,
  person: UserCircle,
  characters: UsersThree,
  chat: ChatCircleDots,
  paw: PawPrint,
  settings: GearSix,
  palette: Palette,
  moon: MoonStars,
  sun: Sun,
  spark: Sparkle,
  gallery: Images,
  memory: Brain,
  paint: PaintBrush,
  mic: Microphone,
  speak: SpeakerHigh,
  stop: StopCircle,
  phone: Phone,
  video: VideoCamera,
  delete: Trash,
  card: IdentificationCard,
  lock: LockKey,
  unlock: LockKeyOpen,
  book: BookOpen,
  game: GameController,
  tools: Wrench,
  inbox: Mailbox,
  rocket: RocketLaunch,
  search: MagnifyingGlass,
  heart: Heart,
  flower: FlowerLotus,
  coffee: Coffee,
  cookie: Cookie,
  music: MusicNotes,
  arrow: ArrowLeft,
  send: PaperPlaneRight,
  download: DownloadSimple,
  refresh: ArrowsClockwise,
  link: LinkSimple,
  plus: Plus,
  check: CheckCircle,
  folder: FolderSimple,
  note: NotePencil,
  calendar: CalendarBlank,
  voice: ChatTeardropText,
  warning: WarningCircle,
  gem: Diamond,
}
export type IconName = keyof typeof icons
export default function UiIcon({
  name,
  size = 19,
  className = '',
}: {
  name: IconName
  size?: number
  className?: string
}) {
  const { icons: weight } = useAppearance()
  const Icon = icons[name]
  return (
    <Icon
      data-icon={name}
      className={'ui-icon ' + className}
      size={size}
      weight={weight}
      aria-hidden="true"
      focusable="false"
    />
  )
}
const labels: Record<string, IconName> = {
  '🏠': 'home',
  '🏡': 'home',
  '🐻': 'person',
  '💬': 'chat',
  '🐾': 'paw',
  '⚙️': 'settings',
  '⚙': 'settings',
  '🌙': 'moon',
  '☀️': 'sun',
  '☀': 'sun',
  '🖼️': 'gallery',
  '🖼': 'gallery',
  '🧠': 'memory',
  '🎨': 'paint',
  '🎙️': 'mic',
  '🎙': 'mic',
  '🎤': 'mic',
  '🔊': 'speak',
  '🔈': 'speak',
  '⏹': 'stop',
  '📞': 'phone',
  '🎞': 'video',
  '🗑️': 'delete',
  '🗑': 'delete',
  '🎴': 'card',
  '🔒': 'lock',
  '🔓': 'unlock',
  '📖': 'book',
  '🎮': 'game',
  '🛠': 'tools',
  '📬': 'inbox',
  '🚀': 'rocket',
  '🔍': 'search',
  '❤️': 'heart',
  '❤': 'heart',
  '✨': 'spark',
  '🪄': 'spark',
  '🍬': 'cookie',
  '📚': 'book',
  '📝': 'note',
  '📎': 'link',
  '🔄': 'refresh',
  '🔁': 'refresh',
  '📥': 'download',
  '📁': 'folder',
  '🗣': 'voice',
  '🎀': 'characters',
  '✅': 'check',
}
const pattern = new RegExp(
  '(' +
    Object.keys(labels)
      .sort((a, b) => b.length - a.length)
      .join('|') +
    ')',
  'gu',
)
export function UiLabel({ text }: { text: string }) {
  return (
    <>
      {text
        .split(pattern)
        .map((part, i) => (labels[part] ? <UiIcon key={i} name={labels[part]} /> : part))}
    </>
  )
}
