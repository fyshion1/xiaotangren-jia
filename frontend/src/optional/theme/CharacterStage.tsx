import type {CharacterProfile} from '../../data/characters'
import {resolveForm} from '../../lib/forms'
export default function CharacterStage({p,onChat}:{p:CharacterProfile;onChat?:()=>void}) {
 const profile=resolveForm(p).profile
 return <section className="core-character"><h1>{profile.name}</h1>
 <p>{profile.aboutZh || profile.about}</p>{onChat && <button className="btn" onClick={onChat}>开始聊天</button>}</section>
}
