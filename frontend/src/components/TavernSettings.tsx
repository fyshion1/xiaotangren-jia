import { lazy, Suspense } from 'react'
const Settings = lazy(() => import('#tavern/components/TavernSettings'))
export default function TavernSettings() {
  return <Suspense fallback={null}><Settings /></Suspense>
}
