import { lazy, Suspense, type ComponentProps } from 'react'
const View = lazy(() => import('#tavern/components/CardHtmlPreview'))
type Props = ComponentProps<typeof import('#tavern/components/CardHtmlPreview').default>
export default function CardHtmlPreview(props: Props) {
  return <Suspense fallback={null}><View {...props} /></Suspense>
}
