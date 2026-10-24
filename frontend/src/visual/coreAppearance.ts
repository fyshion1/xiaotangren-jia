export const corePalettes = [
  {id:'slate',name:'石墨灰',colors:['#f7f8fa','#64748b']},
  {id:'blue',name:'经典蓝',colors:['#f5f8fd','#3563a8']},
  {id:'green',name:'森林绿',colors:['#f5f9f6','#32785d']},
  {id:'warm',name:'暖米色',colors:['#faf7f1','#986a3f']},
] as const
export type CorePalette = typeof corePalettes[number]['id']
const key='xtr.core.palette'
export function readCorePalette():CorePalette {
  try {
    const stored=localStorage.getItem(key)
    return corePalettes.find(palette=>palette.id===stored)?.id||'warm'
  } catch {return 'warm'}
}
export function applyCorePalette(palette:CorePalette) {
  document.documentElement.dataset.corePalette=palette
  try {localStorage.setItem(key,palette)} catch { /* Session-only when storage is unavailable. */ }
}
