// import { useState } from 'react'
// import reactLogo from './assets/react.svg'
// import viteLogo from '/vite.svg'
// import './App.css'
import type { ReactElement } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard'
import Logs from './pages/Logs'
import Login from './pages/Login'
import Register from './pages/Register'
import Settings from './pages/Settings'
import useUserStore from './store/store'

// 로그인 정보는 sessionStorage에서 동기적으로 복원되므로 첫 렌더부터 판단할 수 있다.
// 로그인되어 있지 않으면 팝업 없이 렌더 단계에서 바로 로그인 페이지로 보낸다.
// (effect 안에서 alert를 띄우면 StrictMode 개발 모드에서 effect가 두 번 실행되어 팝업이 두 번 뜬다)
function RequireAuth({ children }: { children: ReactElement }) {
  const userInfo = useUserStore((s) => s.userInfo);
  if (!userInfo) return <Navigate to="/login" replace />;
  return children;
}

// 기본 주소로 들어오면 로그인 여부에 따라 대시보드 또는 로그인 페이지로 보낸다
function HomeRedirect() {
  const userInfo = useUserStore((s) => s.userInfo);
  return <Navigate to={userInfo ? "/dashboard" : "/login"} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/index" element={<HomeRedirect />} />
      <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/logs" element={<RequireAuth><Logs /></RequireAuth>} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
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
