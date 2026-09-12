import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './css/login.css';
import axios from 'axios';
import useUserStore from '../store/store';
import { API_BASE_URL } from '../config';

const LoginPage: React.FC = () => {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const response = await axios.post(`${API_BASE_URL}/user/login`, { users_id: userId, password: password });
    const data = response.data;

    if(data) {
      if(data.status === "fail") {
        alert(`${data.message}`);
      }
      else {
        const user_id = data.user_info.users_id;
        const username = data.user_info.username;
        const team_id = data.user_info.team_id;

        useUserStore.getState().setUserInfo(user_id, username, team_id);

        alert("로그인 성공! 홈으로 이동합니다.");
        navigate("/index");
      }
    }
  };

  return (
    <div className="container">
      <form className="loginCard" onSubmit={handleLogin}>
        <h2 className="title">Login</h2>
        
        <div className="inputGroup">
          <label htmlFor="userId">ID</label>
          <input
            type="text"
            id="userId"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="아이디를 입력하세요"
            required
          />
        </div>

        <div className="inputGroup">
          <label htmlFor="password">Password</label>
          <input
            type="password"
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호를 입력하세요"
            required
          />
        </div>

        <button type="submit" className="loginButton">로그인</button>
        
        <div className="footer">
          <span>계정이 없으신가요?</span>
          <button type="button" onClick={() => navigate('/register')} className="linkButton">
            회원가입
          </button>
        </div>
      </form>
    </div>
  );
};

export default LoginPage;
