import { lazy, Suspense } from 'react'
const View = lazy(() => import('#tavern/components/JailbreakPanel'))
export default function JailbreakPanel() {
  return <Suspense fallback={null}><View /></Suspense>
}
