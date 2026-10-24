import type {ComponentType} from 'react'

export type PersonalDatabaseAPI=Pick<typeof import('../api/client'),
  'archivePersonalDbFile'|'createPersonalDbFile'|'createSelfBlock'|'fetchPersonalDbFile'|
  'fetchPersonalDbHistory'|'fetchPersonalDbTree'|'movePersonalDbPath'|'renamePersonalDbFile'|
  'renamePersonalDbFolder'|'restorePersonalDbVersion'|'savePersonalDbFile'|'saveSelfBlock'|
  'copyToAiLayer'|'approveAiLayer'|'summarizePersonalDb'>
export type PersonalDatabasePanelProps={personaId:string;api:PersonalDatabaseAPI;
  KnowledgeLibrary:ComponentType<{personaId:string;onOpen:(path:string)=>void}>;
  EmbeddingSettings:ComponentType}
export type {PersonalDbEntry} from '../api/client'
