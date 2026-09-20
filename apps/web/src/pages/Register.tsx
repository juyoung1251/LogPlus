import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './css/register.css'
import axios from 'axios';
import { API_BASE_URL } from '../config';

const RegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    userId: '',
    password: '',
    confirmPassword: '',
    team_id: '',
  });

  const { userId, password, confirmPassword, team_id } = formData;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();

    console.log("formData : ", formData);
    if (password !== confirmPassword) {
      alert("비밀번호가 일치하지 않습니다.");
      return;
    }

    console.log("회원가입 데이터:", formData);
    try {
      const response = await axios.post(`${API_BASE_URL}/user/register`, { users_id: userId, password: password, team_id: team_id, role: "user" });

      console.log("response : ", response);
      alert("회원가입이 완료되었습니다!");
      navigate('/login');
    } catch (error: unknown) {
      console.error("회원가입 요청 실패:", error);
      const detail = axios.isAxiosError(error) && typeof error.response?.data?.detail === "string"
        ? error.response.data.detail
        : "회원가입 중 오류가 발생했습니다.";
      alert(detail);
    }
  };

  return (
    <div className="container">
      <form className="registerCard" onSubmit={handleRegister}>
        <h2 className="title">Sign Up</h2>

        <div className="inputGroup">
          <label>ID</label>
          <input name="userId" value={userId} onChange={handleChange} placeholder="아이디" required />
        </div>

        <div className="inputGroup">
          <label>team</label>
          <input name="team_id" value={team_id} onChange={handleChange} placeholder="등록된 팀 ID" required />
        </div>

        <div className="inputGroup">
          <label>Password</label>
          <input type="password" name="password" value={password} onChange={handleChange} placeholder="비밀번호" required />
        </div>

        <div className="inputGroup">
          <label>Confirm Password</label>
          <input type="password" name="confirmPassword" value={confirmPassword} onChange={handleChange} placeholder="비밀번호 확인" required />
        </div>

        <button type="submit" className="registerButton">가입하기</button>

        <div className="footer">
          <span>이미 계정이 있으신가요?</span>
          <button type="button" onClick={() => navigate('/login')} className="linkButton">로그인</button>
        </div>
      </form>
    </div>
  );
};

export default RegisterPage;
