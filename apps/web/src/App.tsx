// import { useState } from 'react'
// import reactLogo from './assets/react.svg'
// import viteLogo from '/vite.svg'
// import './App.css'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Index from './pages/Index'
import Login from './pages/Login'
import Register from './pages/Register'
import User from './pages/User'

function App() {
  return (
    <>
      <Router>
        <Routes>
          <Route path="/index" element={<Index />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/User" element={<User />} />
        </Routes>
      </Router>
    </>
  );
}

export default App
