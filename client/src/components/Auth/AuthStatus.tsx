/* === VIVENTIUM START ===
 * Share the pending/retry view across authenticated routes without treating an outage as logout.
 * === VIVENTIUM END === */
import { Button, Spinner } from '@librechat/client';
import { useAuthContext, useLocalize } from '~/hooks';

export default function AuthStatus() {
  const { isAuthUnavailable, retryAuthentication } = useAuthContext();
  const localize = useLocalize();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-primary p-6 text-text-primary">
      {isAuthUnavailable ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <p role="status">{localize('com_auth_service_unavailable')}</p>
          <Button onClick={retryAuthentication}>{localize('com_ui_retry')}</Button>
        </div>
      ) : (
        <div role="status" className="flex items-center gap-3">
          <Spinner className="size-6" />
          <span>{localize('com_ui_connecting')}</span>
        </div>
      )}
    </main>
  );
}
