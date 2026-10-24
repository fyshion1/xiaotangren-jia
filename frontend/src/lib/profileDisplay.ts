import type { CharacterProfile } from '../data/characters'

import {signatures,kana} from '#theme/signatures'
export function profileSignature(p: CharacterProfile) {
  const value = p.signature ?? p.jp ?? ''
  return /[\u3040-\u30ff]/.test(value) ? signatures[p.id] || kana[value] || '' : value
}
