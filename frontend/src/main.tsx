import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Visual selection context for design feedback; never loaded in production.
if (import.meta.env.DEV) {
  import('react-grab').catch((error) => {
    console.warn('[react-grab] Visual selection could not be loaded.', error)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
