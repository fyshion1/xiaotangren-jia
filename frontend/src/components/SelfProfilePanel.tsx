import {lazy,Suspense} from 'react'
import {available} from '#personal-profile/availability'
import {fetchCharacters,fetchSelfBlocks,fetchSelfBlock,saveSelfBlock,createSelfBlock,deleteSelfBlock} from '../api/client'
import {usePersonalPanel} from '../plugins/usePersonalPanel'
import OptionalPanelBoundary from '../plugins/OptionalPanelBoundary'
import type {PersonalProfileAPI} from '../plugins/personalProfileContract'

const Editor=lazy(()=>import('#personal-profile/SelfProfilePanel'))
const api:PersonalProfileAPI={fetchCharacters,fetchSelfBlocks,fetchSelfBlock,saveSelfBlock,createSelfBlock,deleteSelfBlock,
  exportBlocks:personaId=>{window.open(`/api/self/export?persona_id=${encodeURIComponent(personaId)}`,'_blank','noopener')}}

/** Optional personal-data slot; the host suspends this source when disabled. */
export default function SelfProfilePanel({personaId}:{personaId:string}) {
  const {enabled,error}=usePersonalPanel('personal_profile',available)
  if(error)return <p role="alert">{error}</p>
  return enabled?<OptionalPanelBoundary key={personaId}><Suspense fallback={<p role="status">正在加载个人档案管理…</p>}><Editor personaId={personaId} api={api}/></Suspense></OptionalPanelBoundary>:null
}
