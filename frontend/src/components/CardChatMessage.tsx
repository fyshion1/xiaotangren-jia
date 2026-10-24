import { lazy, Suspense, type ComponentProps } from 'react'
const View = lazy(() => import('#tavern/components/CardChatMessage'))
type Props = ComponentProps<typeof import('#tavern/components/CardChatMessage').default>
export default function CardChatMessage(props: Props) {
  return <Suspense fallback={null}><View {...props} /></Suspense>
}
