import { lazy, Suspense, type ComponentProps } from 'react'
const View = lazy(() => import('#tavern/components/WorldbookPanel'))
type Props = ComponentProps<typeof import('#tavern/components/WorldbookPanel').default>
export default function WorldbookPanel(props: Props) {
  return <Suspense fallback={null}><View {...props} /></Suspense>
}
