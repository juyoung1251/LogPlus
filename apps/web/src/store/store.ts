import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface User  {
  userInfo : {
    userId: string;
    team_id: string;
  } | null,
    setUserInfo: (id : string, team_id: string) => void;
    reset: () => void;
}

// 로고를 누르면 브라우저 전체를 새로고침하므로 로그인 정보를 sessionStorage에 둔다.
// 탭을 닫으면 지워지고, 로그아웃(reset)하면 저장된 값도 null로 바뀐다
const useUserStore = create<User>()(
  persist(
    (set) => ({
      userInfo : null,
      setUserInfo: (id, team_id) => set({ userInfo: {userId: id, team_id: team_id} }),
      reset: () => set({ userInfo : null}),
    }),
    {
      name: 'logplus-user',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ userInfo: state.userInfo }),
    }
  )
);

export default useUserStore;
