import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './visual/design.css'
import './visual/design-options.css'
import {AppearanceProvider} from './visual/appearanceState'

// Visual selection context for design feedback; never loaded in production.
if (import.meta.env.DEV) {
  import('react-grab').catch((error) => {
    console.warn('[react-grab] Visual selection could not be loaded.', error)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppearanceProvider><App /></AppearanceProvider>
  </StrictMode>,
)
