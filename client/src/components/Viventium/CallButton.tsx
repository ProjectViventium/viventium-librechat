/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: LibreChat Voice Calls - Call Button
 *
 * Purpose:
 * - Add a modern, accessible Call entrypoint in LibreChat
 * - Opens the exact configured Viventium voice surface in a new tab/window (minimal coupling)
 *
 * Added: 2026-01-08
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { TooltipAnchor } from '@librechat/client';
import { request } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';
import { cn } from '~/utils';
import { readVoiceCallFailureMessage } from './voiceCallError';

type CallState = 'idle' | 'connecting' | 'active' | 'error';

export default function CallButton({ className }: { className?: string }) {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const agentId = conversation?.agent_id;
  const conversationId = conversation?.conversationId;
  const { token } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();

  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const callWindowRef = useRef<Window | null>(null);
  const errorId = useId();

  /* === VIVENTIUM START ===
   * Feature: Voice readiness and privacy guard.
   * Purpose: Missing or disabled Voice capability must not expose a working-looking call action.
   * === VIVENTIUM END === */
  const voiceEnabled = startupConfig?.viventiumVoiceEnabled === true;
  const enabled = voiceEnabled && typeof agentId === 'string' && agentId.length > 0;

  // Reset to idle once the call window is closed.
  useEffect(() => {
    const t = window.setInterval(() => {
      const w = callWindowRef.current;
      if (w && w.closed) {
        callWindowRef.current = null;
        setState('idle');
      }
    }, 1000);

    return () => window.clearInterval(t);
  }, []);

  const startCall = useCallback(async () => {
    if (!enabled || state === 'connecting') {
      return;
    }

    // If a call tab is already open, focus it.
    if (callWindowRef.current && !callWindowRef.current.closed) {
      callWindowRef.current.focus();
      return;
    }

    setState('connecting');
    setError(null);

    try {
      const makeRequest = async (bearerToken?: string) => {
        return await fetch('/api/viventium/calls', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
          },
          body: JSON.stringify({
            conversationId: conversationId ?? 'new',
            agentId,
          }),
        });
      };

      let resp = await makeRequest(token);
      if (resp.status === 401) {
        // Match existing SSE behavior: refresh token and retry once.
        const refreshResponse = await request.refreshToken();
        const newToken = refreshResponse?.token ?? '';
        if (newToken) {
          request.dispatchTokenUpdatedEvent(newToken);
          resp = await makeRequest(newToken);
        }
      }

      if (!resp.ok) {
        setState('error');
        setError(await readVoiceCallFailureMessage(resp));
        return;
      }

      const data = await resp.json();

      const url = data?.playgroundUrl;
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('Missing playgroundUrl');
      }

      // Use simpler window.open to avoid popup blocker issues
      const w = window.open(url, '_blank');

      if (!w) {
        setState('error');
        let copied = false;
        try {
          await navigator.clipboard?.writeText(url);
          copied = true;
        } catch {
          // The visible recovery copy below remains usable when clipboard permission is denied.
        }
        setError(
          copied
            ? 'Your browser blocked the Voice window. The secure link was copied; paste it into a new tab.'
            : 'Your browser blocked the Voice window. Allow pop-ups for Viventium, then try again.',
        );
        return;
      }

      callWindowRef.current = w;
      setState('active');
      w.focus();
    } catch {
      setState('error');
      setError('Voice could not start. Try again. If it keeps happening, check Viventium Status.');
    } finally {
      // If active, we keep it active until window closes; otherwise return to idle shortly.
      setTimeout(() => {
        setState((s) => (s === 'active' ? 'active' : 'idle'));
      }, 800);
    }
  }, [agentId, conversationId, enabled, state, token]);

  const endCall = useCallback(() => {
    const w = callWindowRef.current;
    if (w && !w.closed) {
      w.close();
    }
    callWindowRef.current = null;
    setState('idle');
  }, []);

  if (!enabled) {
    return null;
  }

  const isConnecting = state === 'connecting';
  const isActive = state === 'active';

  const label = isActive ? 'End voice call' : error ? 'Retry voice call' : 'Start voice call';
  const title =
    error ||
    (state === 'idle'
      ? 'Start voice call'
      : state === 'connecting'
        ? 'Connecting…'
        : state === 'active'
          ? 'End voice call'
          : 'Voice could not start');

  return (
    <div className="flex items-center gap-2">
      <TooltipAnchor
        description={title}
        render={
          <button
            type="button"
            onClick={isActive ? endCall : startCall}
            disabled={isConnecting}
            aria-label={label}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              'flex items-center justify-center rounded-lg p-2 transition-all duration-200',
              'hover:bg-surface-secondary focus:outline-none focus:ring-2 focus:ring-offset-2',
              state === 'idle' && 'text-text-secondary hover:text-text-primary',
              state === 'connecting' && 'text-yellow-500 cursor-wait',
              state === 'active' &&
                'text-green-500 bg-green-500/10 hover:bg-red-500/10 hover:text-red-500',
              state === 'error' && 'text-red-500',
              className,
            )}
          >
            {state === 'connecting' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : state === 'active' ? (
              <PhoneOff className="h-5 w-5" />
            ) : (
              <Phone className="h-5 w-5" />
            )}
          </button>
        }
      />
      {error ? (
        <span id={errorId} role="alert" className="max-w-64 text-xs leading-tight text-red-500">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/* === VIVENTIUM NOTE === */
