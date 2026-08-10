'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  type User,
  type AuthState,
  getCurrentUser,
  getAuthTokens,
  saveAuthTokens,
  saveCurrentUser,
  clearAuthTokens,
  loginWithGoogle as authLoginWithGoogle,
  logout as authLogout,
  isUserAdmin,
} from '@/lib/utils/auth';
import { config } from '@/lib/utils/config';
import { clearAIModelsCache } from '@/hooks/features/useAIModels';

import { logger } from '@/lib/utils/logger';
interface AuthContextType extends AuthState {
  login: (user: User, accessToken: string, refreshToken: string) => void;
  logout: () => void;
  loginWithGoogle: (input?: unknown) => void;
  isLoading: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    accessToken: null,
    refreshToken: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  // Load auth state from localStorage on mount and validate token
  useEffect(() => {
    const validateAndRestoreAuth = async () => {
      const tokens = getAuthTokens();
      const cachedUser = getCurrentUser();

      if (!tokens || !cachedUser) {
        if (process.env.NEXT_PUBLIC_LOCAL_SINGLE_USER_MODE === 'true') {
          try {
            const response = await fetch(
              `${config.apiUrl}/auth/local-session`,
              { method: 'POST' }
            );
            if (response.ok) {
              const result = await response.json();
              const data = result?.data ?? result;
              saveAuthTokens({
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
              });
              saveCurrentUser(data.user);
              setAuthState({
                user: data.user,
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
              });
            }
          } catch (error) {
            logger.warn('Local single-user session bootstrap failed', error);
          }
        }
        setIsLoading(false);
        return;
      }

      try {
        // Direct backend URL to bypass CDN proxy (CDN 503 must not log users out)
        const response = await fetch(`${config.streamApiUrl}/auth/me`, {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
          },
        });

        if (response.ok) {
          const result = await response.json();
          // API returns { success: true, data: user } format
          const user = result?.data ?? result;
          // Token 有效，更新用户信息
          saveCurrentUser(user);
          setAuthState({
            user,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          });
        } else if (response.status === 401) {
          // Only clear on explicit 401 (token rejected by backend)
          logger.warn('Token validation failed (401), clearing auth state');
          clearAuthTokens();
          // 与 logout 同理：token 失效后缓存里那份带 BYOK 的模型列表必须丢弃
          clearAIModelsCache();
        } else {
          // 5xx or other errors: keep cached state, don't log user out
          logger.warn(
            `Token validation returned ${response.status}, using cached user`
          );
          setAuthState({
            user: cachedUser,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          });
        }
      } catch (error) {
        // 网络错误时使用缓存的用户数据
        logger.warn(
          'Token validation failed due to network error, using cached user'
        );
        setAuthState({
          user: cachedUser,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
      }

      setIsLoading(false);
    };

    validateAndRestoreAuth();
  }, []);

  const login = (user: User, accessToken: string, refreshToken: string) => {
    saveAuthTokens({ accessToken, refreshToken });
    saveCurrentUser(user);
    setAuthState({
      user,
      accessToken,
      refreshToken,
    });
    // 2026-07-31：模型列表随登录态变化（带 token 才会并入用户自己的 BYOK 模型），
    // 但 useAIModels 的 effect 只依赖 revision、不依赖登录态——它内部那句
    // `cachedAuthState === currentAuth` 只有在重新挂载时才有机会生效。若匿名态下
    // 已缓存过一份（只含 admin 模型），登录后不主动失效就会一直沿用，用户看到
    // 「配了 BYOK 模型却不出现在下拉里」。这里主动 bump revision 触发重取。
    clearAIModelsCache();
  };

  const logout = () => {
    clearAuthTokens();
    setAuthState({
      user: null,
      accessToken: null,
      refreshToken: null,
    });
    // 反向同理：登出后必须丢弃带 BYOK 的那份缓存，否则下一个用户会看到上一个人的模型
    clearAIModelsCache();
    authLogout();
  };

  const loginWithGoogle = (input?: unknown) => {
    authLoginWithGoogle(input);
  };

  return (
    <AuthContext.Provider
      value={{
        ...authState,
        login,
        logout,
        loginWithGoogle,
        isLoading,
        isAdmin: isUserAdmin(authState.user),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
