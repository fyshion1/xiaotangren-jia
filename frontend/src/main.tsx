import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import '#theme/style.css'
import './visual/core-appearance.css'
import {applyCorePalette,readCorePalette} from './visual/coreAppearance'
import {AppearanceProvider} from './visual/appearanceState'
import {themeInstalled} from '#theme/config'
import './visual/core-layout.css'

// Visual selection context for design feedback; never loaded in production.
if (import.meta.env.DEV) {
  import('react-grab').catch((error) => {
    console.warn('[react-grab] Visual selection could not be loaded.', error)
  })
}

applyCorePalette(readCorePalette())
if (!themeInstalled) document.documentElement.dataset.coreUi='true'
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppearanceProvider><App /></AppearanceProvider>
  </StrictMode>,
)
