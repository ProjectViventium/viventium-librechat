import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext, usePreviousLocation } from '~/hooks';
import { DashboardContext } from '~/Providers';
import AuthStatus from '~/components/Auth/AuthStatus';
import store from '~/store';

export default function DashboardRoute() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuthContext();
  const prevLocationRef = usePreviousLocation();
  const clearConvoState = store.useClearConvoState();
  const [prevLocationPath, setPrevLocationPath] = useState('');

  useEffect(() => {
    setPrevLocationPath(prevLocationRef.current?.pathname || '');
  }, [prevLocationRef]);

  useEffect(() => {
    queryClient.removeQueries([QueryKeys.messages, 'new']);
    clearConvoState();
  }, [queryClient, clearConvoState]);

  if (!isAuthenticated) {
    return <AuthStatus />;
  }

  return (
    <DashboardContext.Provider value={{ prevLocationPath }}>
      <div className="h-screen w-full">
        <Outlet />
      </div>
    </DashboardContext.Provider>
  );
}
