import type {CharacterProfile} from '../../data/characters'
function profile(id:string,name:string):CharacterProfile {
 return {id,name,alias:'可自定义',emoji:'💬',about:'',jp:'',birthday:'',age:'',height:'',
 bloodType:'',constellation:'',personality:[],likes:[],dislikes:[],catchphrase:'',
 bodyType:'',eyeColor:'',hairstyle:'',hairColor:'',bust:'',hip:'',clothing:'',
 occupation:'',relationships:'',specialFeatures:'',weight:'',measurements:'',
 secret:'',weakPoint:'',privateWish:'',asCharacter:false,forms:[]}
}
export const PROFILE_FALLBACK = [profile('assistant','助手')]
export const PERSONA_FALLBACK = [profile('dalaoda','用户')]
