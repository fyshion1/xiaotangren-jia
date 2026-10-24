import {lazy,Suspense} from 'react'
import {available} from '#gemini-sync/availability'
import {useOptionalPlugin} from '../plugins/useOptionalPlugin'
const Panel=lazy(()=>import('#gemini-sync/GeminiSyncPanel'))
export default function GeminiSyncPanel(){
  const enabled=useOptionalPlugin('gemini_sync',available)
  return enabled?<Suspense fallback={<p role="status">正在加载同步插件…</p>}><Panel/></Suspense>:null
}
