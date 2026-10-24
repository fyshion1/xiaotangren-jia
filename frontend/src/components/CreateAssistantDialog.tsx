import {useEffect,useRef,useState} from 'react'
import type {CharacterProfile} from '../data/characters'
import {createCharacter} from '../api/client'
import {emptyProfile} from '../lib/emptyProfile'

export default function CreateAssistantDialog({onCreated,onClose}:{onCreated:(profile:CharacterProfile)=>void;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null)
  const [name,setName]=useState(''),[about,setAbout]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{ref.current?.showModal()},[])
  return <dialog ref={ref} aria-labelledby="create-assistant-title" className="core-assistant-dialog" onCancel={event=>{event.preventDefault();if(!busy)onClose()}}>
    <form onSubmit={async event=>{
      event.preventDefault();if(busy||!name.trim())return
      setBusy(true);setError('')
      try {const saved=await createCharacter({...emptyProfile(),name:name.trim(),about:about.trim(),emoji:'💬'});onCreated(saved)}
      catch(error){setError(error instanceof Error?error.message:String(error))}
      finally {setBusy(false)}
    }}>
      <span className="eyebrow">从一次相识开始</span><h2 id="create-assistant-title">创建助手</h2>
      <p>先取一个名字。头像、角色设定与其他资料，创建后都可以继续编辑。</p>
      <label>助手名称<input className="input" aria-label="助手名称" autoFocus required maxLength={120} value={name} onChange={event=>setName(event.target.value)} placeholder="你想怎么称呼这位助手？" disabled={busy}/></label>
      <label>角色设定 <small>可选</small><textarea className="input" aria-label="角色设定" rows={4} maxLength={16000} value={about} onChange={event=>setAbout(event.target.value)} placeholder="性格、擅长的事情，或希望如何交流" disabled={busy}/></label>
      <p className="core-local-note">资料保存在本机。使用云端模型聊天时，角色设定会作为上下文发送。</p>
      {error&&<p role="alert">{error}</p>}
      <footer><button type="button" className="btn ghost" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="btn" disabled={busy||!name.trim()}>{busy?'创建中…':'创建并开始聊天'}</button></footer>
    </form>
  </dialog>
}
