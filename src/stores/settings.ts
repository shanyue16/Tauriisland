import { create } from "zustand";
import {
  type Settings,
  type IslandState,
  DEFAULT_SETTINGS,
} from "../types";

interface SettingsStore {
  settings: Settings;
  state: IslandState;
  currentPage: number;
  setState: (s: IslandState) => void;
  setCurrentPage: (p: number) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  resetSettings: () => void;
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  state: "minimal",
  currentPage: 0,
  setState: (s) => set({ state: s }),
  setCurrentPage: (p) => set({ currentPage: p }),
  updateSettings: (partial) =>
    set((st) => ({ settings: { ...st.settings, ...partial } })),
  resetSettings: () => set({ settings: DEFAULT_SETTINGS }),
}));
