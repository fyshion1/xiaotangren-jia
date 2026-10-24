import type {CharacterProfile} from '../data/characters'
import type {SelfBlock,SelfBlockMeta} from '../api/client'

/** Host-owned HTTP facade. The panel never receives database or filesystem handles. */
export type PersonalProfileAPI = {
  fetchCharacters:()=>Promise<CharacterProfile[]>
  fetchSelfBlocks:(personaId:string)=>Promise<SelfBlockMeta[]>
  fetchSelfBlock:(personaId:string,filename:string)=>Promise<SelfBlock>
  saveSelfBlock:(personaId:string,filename:string,body:Pick<SelfBlock,'title'|'inject'|'visible_to'|'content'>)=>Promise<SelfBlock>
  createSelfBlock:(personaId:string,title:string)=>Promise<SelfBlockMeta>
  deleteSelfBlock:(personaId:string,filename:string)=>Promise<void>
  exportBlocks:(personaId:string)=>void
}
export type PersonalProfilePanelProps = {personaId:string;api:PersonalProfileAPI}
export type {SelfBlock,SelfBlockMeta}
