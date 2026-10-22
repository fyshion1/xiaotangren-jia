import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
export type Palette = 'rose' | 'cream' | 'starlight'
export type IconStyle = 'duotone' | 'regular'
const State = createContext<{
  palette: Palette
  setPalette: (v: Palette) => void
  icons: IconStyle
  setIcons: (v: IconStyle) => void
}>({ palette: 'rose', setPalette: () => {}, icons: 'duotone', setIcons: () => {} })
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState<Palette>(() => {
    try {
      const v = localStorage.getItem('xtr.visual.palette')
      return v === 'cream' || v === 'starlight' ? v : 'rose'
    } catch {
      return 'rose'
    }
  })
  const [icons, setIcons] = useState<IconStyle>(() => {
    try {
      return localStorage.getItem('xtr.visual.icons') === 'regular' ? 'regular' : 'duotone'
    } catch {
      return 'duotone'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.palette = palette
    document.documentElement.dataset.iconStyle = icons
    try {
      localStorage.setItem('xtr.visual.palette', palette)
      localStorage.setItem('xtr.visual.icons', icons)
    } catch {}
  }, [palette, icons])
  return (
    <State.Provider value={{ palette, setPalette, icons, setIcons }}>{children}</State.Provider>
  )
}
export const useAppearance = () => useContext(State)
