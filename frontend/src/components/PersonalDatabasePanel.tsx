import {lazy,Suspense} from 'react'
import {available} from '#personal-database/availability'
import {usePersonalPanel} from '../plugins/usePersonalPanel'
import OptionalPanelBoundary from '../plugins/OptionalPanelBoundary'
import * as client from '../api/client'
import KnowledgeLibrary from './KnowledgeLibrary'
import EmbeddingSettings from './EmbeddingSettings'
import PatrolPanel from './PatrolPanel'
import type {PersonalDatabaseAPI} from '../plugins/personalDatabaseContract'

const Editor=lazy(()=>import('#personal-database/PersonalDatabasePanel'))
const api:PersonalDatabaseAPI={archivePersonalDbFile:client.archivePersonalDbFile,createPersonalDbFile:client.createPersonalDbFile,
  createSelfBlock:client.createSelfBlock,fetchPersonalDbFile:client.fetchPersonalDbFile,fetchPersonalDbHistory:client.fetchPersonalDbHistory,
  fetchPersonalDbTree:client.fetchPersonalDbTree,movePersonalDbPath:client.movePersonalDbPath,renamePersonalDbFile:client.renamePersonalDbFile,
  renamePersonalDbFolder:client.renamePersonalDbFolder,restorePersonalDbVersion:client.restorePersonalDbVersion,
  savePersonalDbFile:client.savePersonalDbFile,saveSelfBlock:client.saveSelfBlock,copyToAiLayer:client.copyToAiLayer,
  approveAiLayer:client.approveAiLayer,summarizePersonalDb:client.summarizePersonalDb}

export default function PersonalDatabasePanel({personaId}:{personaId:string}) {
  const {enabled,error}=usePersonalPanel('personal_database',available)
  if(error)return <p role="alert">{error}</p>
  return enabled?<OptionalPanelBoundary key={personaId}><Suspense fallback={<p role="status">正在加载个人数据库…</p>}>
    <Editor personaId={personaId} api={api} KnowledgeLibrary={KnowledgeLibrary} EmbeddingSettings={EmbeddingSettings}/>
  </Suspense><PatrolPanel/></OptionalPanelBoundary>:null
}
