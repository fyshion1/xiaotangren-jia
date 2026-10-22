import type { CharacterProfile } from '../data/characters'

const signatures: Record<string, string> = {
  dalaoda: 'Big Boss', dashiyin: 'Kahoruzuki Shion', xiaoshiyin: 'Koshion',
  xiaobai: 'Shiro', xiaohongshutou: 'Guripan', xizi: 'Shioko',
}
const kana: Record<string, string> = {
  'ビッグボス': 'Big Boss', 'かほるずき しおん': 'Kahoruzuki Shion', 'コシオン': 'Koshion',
  'シロ': 'Shiro', 'ぐりぱん': 'Guripan', 'しおこ / シオコ': 'Shioko',
}
export function profileSignature(p: CharacterProfile) {
  const value = p.signature ?? p.jp ?? ''
  return /[\u3040-\u30ff]/.test(value) ? signatures[p.id] || kana[value] || '' : value
}
