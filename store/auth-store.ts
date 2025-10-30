import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { User, Organization, Project } from "@/types"

interface AuthState {
  user: User | null
  currentOrg: Organization | null
  currentProject: Project | null
  setUser: (user: User | null) => void
  setCurrentOrg: (org: Organization | null) => void
  setCurrentProject: (project: Project | null) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      currentOrg: null,
      currentProject: null,
      setUser: (user) => set({ user }),
      setCurrentOrg: (org) => set({ currentOrg: org }),
      setCurrentProject: (project) => set({ currentProject: project }),
      logout: () => set({ user: null, currentOrg: null, currentProject: null }),
    }),
    {
      name: "kolaybase-auth",
    },
  ),
)
