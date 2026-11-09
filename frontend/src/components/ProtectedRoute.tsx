// VOS adaptation: explain platform sign-in instead of showing a local password form.
import VosSignIn from './VosSignIn';
import { isVosMode } from '../services/vosAuthService';
import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  redirectPath?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  redirectPath = '/login'
}) => {
  const { t } = useTranslation();
  const { auth } = useAuth();

  if (auth.loading) {
    return <div className="flex items-center justify-center h-screen">{t('app.loading')}</div>;
  }

  if (!auth.isAuthenticated) {
    if (isVosMode()) return <VosSignIn />;
    return <Navigate to={redirectPath} replace />;
  }

  return <Outlet />;
};

export default ProtectedRoute;