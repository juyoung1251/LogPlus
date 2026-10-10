import { create } from 'zustand';

interface User  {
  userInfo : {
    userId: string;
    team_id: string;
  } | null,
    setUserInfo: (id : string, team_id: string) => void;
    reset: () => void;
}

const useUserStore = create<User>((set) => ({
  userInfo : null,
  setUserInfo: (id, team_id) => set({ userInfo: {userId: id, team_id: team_id} }),
  reset: () => set({ userInfo : null}),
}));

export default useUserStore;
