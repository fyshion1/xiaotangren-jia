import {useEffect,useState} from 'react'
import {asJson} from '../api/client'

export function usePersonalPanel(id:string,installed:boolean) {
  const [enabled,setEnabled]=useState(false)
  const [error,setError]=useState('')
  useEffect(()=>{
    let alive=true
    const refresh=()=>{
      if(!installed)return
      void asJson<{items:{id:string;enabled:boolean;hidden:boolean}[]}>('/api/personal-space/panels')
        .then(data=>{if(alive){setEnabled(data.items.some(panel=>panel.id===id&&panel.enabled&&!panel.hidden));setError('')}})
        .catch(()=>{if(alive){setEnabled(false);setError('个人资料插件状态读取失败；未读取资料内容。')}})
    }
    refresh();window.addEventListener('plugins-changed',refresh)
    return ()=>{alive=false;window.removeEventListener('plugins-changed',refresh)}
  },[id,installed])
  return {enabled,error}
}
