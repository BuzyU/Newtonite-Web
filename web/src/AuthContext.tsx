import React, { createContext, useContext, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';

export interface UserTeam {
  teamId: string;
  teamName: string;
  teamSlug: string;
  prefix: string;
  role: 'viewer' | 'member' | 'lead' | 'admin';
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  is_org_admin: boolean;
  isOrgAdmin?: boolean;
  orgId?: string;
  orgName?: string;
  orgSlug?: string;
  mustChangePassword?: boolean;
  teams?: UserTeam[];
}

export interface AuthContextValue {
  user: UserProfile | null;
  isLoading: boolean;
  loading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  registerOrg: (payload: {
    orgName: string;
    orgSlug?: string;
    adminName: string;
    adminEmail: string;
    password: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  // Theme setup: Light mode is default
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('newtonite_theme') as 'light' | 'dark' | null;
    if (saved === 'light' || saved === 'dark') return saved;
    return 'light'; // Light by default
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('newtonite_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  // Verify active session on initial mount
  useEffect(() => {
    let isMounted = true;
    apiFetch<{ user: UserProfile }>('/api/v1/auth/me', { skipAuthRedirect: true })
      .then((res) => {
        if (isMounted) setUser(res.data.user);
      })
      .catch(() => {
        if (isMounted) setUser(null);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (email: string, password: string, remember: boolean = true) => {
    const res = await apiFetch<{ user: UserProfile }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, remember }),
      headers: { 'Content-Type': 'application/json' },
    });
    setUser(res.data.user);
  };

  const registerOrg = async (payload: {
    orgName: string;
    orgSlug?: string;
    adminName: string;
    adminEmail: string;
    password: string;
  }) => {
    const res = await apiFetch<{ user: UserProfile }>('/api/v1/auth/register-org', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    });
    setUser(res.data.user);
  };

  const logout = async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    queryClient.clear();
    setUser(null);
    window.location.href = '/login';
  };

  const refreshUser = async () => {
    try {
      const res = await apiFetch<{ user: UserProfile }>('/api/v1/auth/me');
      setUser(res.data.user);
    } catch {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        loading: isLoading,
        login,
        registerOrg,
        logout,
        refreshUser,
        theme,
        toggleTheme,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
