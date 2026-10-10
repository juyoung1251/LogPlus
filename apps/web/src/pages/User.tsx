import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './css/user.css';
import axios from 'axios';
import useUserStore from '../store/store';

const UserPage: React.FC = () => {
    const navigate = useNavigate();
    const userInfo = useUserStore(s => s.userInfo);

  return (
    <div className="container">
        {userInfo && (
            <h2>{`안녕하세요 ${userInfo.userId}님`}</h2>
        )}
    </div>
  );
};

export default UserPage;
