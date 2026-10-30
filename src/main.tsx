import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { registerOfflineServiceWorker } from './pwa/registerServiceWorker'
import './styles/variables.css'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Coquille applicative disponible hors-ligne après le premier chargement (P0-7).
registerOfflineServiceWorker()
