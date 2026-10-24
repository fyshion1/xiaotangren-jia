import {useEffect,useState} from 'react'
import {asJson} from '../api/client'

export function useOptionalPlugin(id:string,installed:boolean) {
  const [enabled,setEnabled]=useState(false)
  useEffect(()=>{
    if(!installed)return
    let alive=true,revision=0
    const refresh=()=>{
      const current=++revision
      void asJson<{items:{id:string;installed:boolean;enabled:boolean}[]}>('/api/plugins',{headers:{'X-Exploration-Dashboard':'1'}})
        .then(data=>{if(alive&&current===revision)setEnabled(data.items.some(item=>item.id===id&&item.installed&&item.enabled))})
        .catch(()=>{if(alive&&current===revision)setEnabled(false)})
    }
    refresh();window.addEventListener('plugins-changed',refresh)
    return ()=>{alive=false;window.removeEventListener('plugins-changed',refresh)}
  },[id,installed])
  return installed&&enabled
}
