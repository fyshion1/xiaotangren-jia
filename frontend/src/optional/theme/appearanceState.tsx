import type {ReactNode} from 'react'
export function AppearanceProvider({children}: {children:ReactNode}) { return children }
export const useAppearance = () => ({icons: 'regular' as const})
