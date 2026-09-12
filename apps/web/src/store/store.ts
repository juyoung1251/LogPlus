import { create } from 'zustand';

interface User  {
  userInfo : {
    userName: string;
    userId: string;
    team_id: string;
  } | null,
    setUserInfo: (id : string, name: string, team_id: string) => void;
    reset: () => void;
}

const useUserStore = create<User>((set) => ({
  userInfo : null,
  setUserInfo: (id, name, team_id) => set({ userInfo: {userId: id, userName: name, team_id: team_id} }),
  reset: () => set({ userInfo : null}),
}));

export default useUserStore;