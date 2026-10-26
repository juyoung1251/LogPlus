// import { useState } from 'react'
// import reactLogo from './assets/react.svg'
// import viteLogo from '/vite.svg'
// import './App.css'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard'
import Logs from './pages/Logs'
import Login from './pages/Login'
import Register from './pages/Register'
import Settings from './pages/Settings'

function AppRoutes() {
  return (
    <Routes>
      {/* 기본 화면은 대시보드 */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/logs" element={<Logs />} />
      {/* 예전 주소로 들어와도 대시보드로 보낸다 */}
      <Route path="/index" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  );
}

function App() {
  return (
    <>
      <Router>
        <AppRoutes />
      </Router>
    </>
  );
}

export default App
