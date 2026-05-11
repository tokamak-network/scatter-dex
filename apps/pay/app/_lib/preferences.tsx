"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface Preferences {
  /** When false (default), the Stealth menu, address-book stealth
   *  field, and stealth-derivation paths are hidden so the wizard
   *  works with verified plain ETH addresses only. Users who need
   *  the stealth flow can opt in via the settings page. */
  stealthEnabled: boolean;
}

const DEFAULTS: Preferences = {
  stealthEnabled: false,
};

const STORAGE_KEY = "pay.preferences.v1";

interface PreferencesContextValue {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function loadFromStorage(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return DEFAULTS;
    // Type-narrow each field rather than spreading. A stale or
    // tampered key (`stealthEnabled: "yes"`) shouldn't slip through
    // — fall back to default when the shape doesn't match.
    const p = parsed as Record<string, unknown>;
    return {
      stealthEnabled:
        typeof p.stealthEnabled === "boolean"
          ? p.stealthEnabled
          : DEFAULTS.stealthEnabled,
    };
  } catch {
    return DEFAULTS;
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  // Start with defaults on the server; hydrate from localStorage on
  // mount to keep SSR output deterministic. The brief mismatch
  // (one render with `stealthEnabled=false` even when stored true)
  // is acceptable — toggling stealth-only UI on the same tick the
  // value lands is enough.
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);

  useEffect(() => {
    setPrefs(loadFromStorage());
  }, []);

  const setPref = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setPrefs((prev) => {
        const next = { ...prev, [key]: value };
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Quota / private-mode failures are non-fatal — the
          // in-memory state stays consistent for this session.
        }
        return next;
      });
    },
    [],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({ prefs, setPref }),
    [prefs, setPref],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within PreferencesProvider");
  }
  return ctx;
}
