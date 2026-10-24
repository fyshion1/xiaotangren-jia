import { lazy, Suspense, type ComponentProps } from 'react'
const View = lazy(() => import('#tavern/components/CardImportDialog'))
type Props = ComponentProps<typeof import('#tavern/components/CardImportDialog').default>
export default function CardImportDialog(props: Props) {
  return <Suspense fallback={null}><View {...props} /></Suspense>
}
