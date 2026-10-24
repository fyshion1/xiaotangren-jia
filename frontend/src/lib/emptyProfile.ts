import type {CharacterProfile} from '../data/characters'

export function emptyProfile(): Omit<CharacterProfile, 'id'> {
  return {
    name: '',
    jp: '',
    alias: '',
    emoji: '🌟',
    about: '',
    birthday: '',
    age: '',
    height: '',
    bloodType: '',
    constellation: '',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '',
    hip: '',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '',
    secret: '',
    weakPoint: '',
    privateWish: '',
    relation: '',
    // 新档案默认**不当**可聊角色（§22）：多数身份只是「换个视角说话」，
    // 想让她现身当角色，去编辑面板把开关打开。
    asCharacter: false,
  }
}
