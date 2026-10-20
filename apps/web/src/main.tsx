import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Tenders from './pages/Tenders'
import TenderWorkspace from './pages/TenderWorkspace'
import Knowledge from './pages/Knowledge'
import { Proposals, Quality, Settings } from './pages/Other'
import DeckView from './pages/DeckView'
import Templates from './pages/Templates'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="tenders" element={<Tenders />} />
          <Route path="tenders/:id" element={<TenderWorkspace />} />
          <Route path="knowledge" element={<Knowledge />} />
          <Route path="proposals" element={<Proposals />} />
          <Route path="templates" element={<Templates />} />
          <Route path="decks/:deckId" element={<DeckView />} />
          <Route path="quality" element={<Quality />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
)
