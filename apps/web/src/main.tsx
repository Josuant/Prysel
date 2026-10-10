// El anfitrión (y el `acquireVsCodeApi` que espera el lienzo) va primero: el lienzo lo pide al cargarse.
import { host } from './shim.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './Shell.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Falta #root')
createRoot(root).render(
  <StrictMode>
    <Shell host={host} />
  </StrictMode>,
)
