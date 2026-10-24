import {useEffect, useState} from 'react'

type VoiceComponents = {installed:boolean;tts_available:boolean;local_asr_ready:boolean;cloud_configured:boolean}
const missing:VoiceComponents={installed:false,tts_available:false,local_asr_ready:false,cloud_configured:false}

export function useComponents() {
  const [voice,setVoice]=useState(missing)
  useEffect(()=>{
    const abort=new AbortController()
    fetch('/api/components',{signal:abort.signal}).then(async response=>{
      if(!response.ok)return
      const data=await response.json()
      const value=data?.voice
      if(!abort.signal.aborted && value && typeof value==='object')setVoice({
        installed:value.installed===true,tts_available:value.tts_available===true,
        local_asr_ready:value.local_asr_ready===true,cloud_configured:value.cloud_configured===true,
      })
    }).catch(()=>{})
    return ()=>abort.abort()
  },[])
  return {voice}
}
