import React from 'react'
import { createRoot } from 'react-dom/client'
import { BackendUatPanel } from '../../src/features/uat/BackendUatPanel'
import '../../src/features/uat/UatStudio.css'
createRoot(document.getElementById('root')!).render(<div className="uat-studio is-xianxia"><BackendUatPanel themeMode="xianxia" /></div>)
