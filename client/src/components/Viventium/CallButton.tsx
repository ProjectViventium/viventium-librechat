/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: LibreChat Voice Calls - Call Button
 *
 * Purpose:
 * - Add a modern, accessible Call entrypoint in LibreChat
 * - Opens LiveKit Agents Playground in a new tab/window (minimal coupling)
 *
 * Added: 2026-01-08
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { TooltipAnchor } from '@librechat/client';
import { request } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import store from '~/store';
import { cn } from '~/utils';

type CallState = 'idle' | 'connecting' | 'active' | 'error';

export default function CallButton({ className }: { className?: string }) {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const agentId = conversation?.agent_id;
  const conversationId = conversation?.conversationId;
  const { token } = useAuthContext();

  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const callWindowRef = useRef<Window | null>(null);

  const enabled = typeof agentId === 'string' && agentId.length > 0;

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
    console.log('[VIVENTIUM][CallButton] startCall clicked', { enabled, state, agentId, conversationId });

    if (!enabled || state === 'connecting') {
      console.log('[VIVENTIUM][CallButton] Early return - not enabled or connecting');
      return;
    }

    // If a call tab is already open, focus it.
    if (callWindowRef.current && !callWindowRef.current.closed) {
      console.log('[VIVENTIUM][CallButton] Focusing existing window');
      callWindowRef.current.focus();
      return;
    }

    setState('connecting');
    setError(null);

    try {
      console.log('[VIVENTIUM][CallButton] Calling /api/viventium/calls');
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

      console.log('[VIVENTIUM][CallButton] Response status:', resp.status);

      if (!resp.ok) {
        const msg = await resp.text().catch(() => '');
        console.error('[VIVENTIUM][CallButton] API error:', msg);
        throw new Error(msg || `Call session failed (${resp.status})`);
      }

      const data = await resp.json();
      console.log('[VIVENTIUM][CallButton] Response data:', data);

      const url = data?.playgroundUrl;
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('Missing playgroundUrl');
      }

      console.log('[VIVENTIUM][CallButton] Opening playground:', url);

      // Use simpler window.open to avoid popup blocker issues
      const w = window.open(url, '_blank');

      if (!w) {
        console.warn('[VIVENTIUM][CallButton] Popup blocked, copying URL');
        setState('error');
        setError('Popup blocked. URL copied to clipboard.');
        await navigator.clipboard.writeText(url);
        // Also show alert with the URL
        alert(`Popup blocked! Open this URL manually:\n${url}`);
        return;
      }

      callWindowRef.current = w;
      setState('active');
      w.focus();
      console.log('[VIVENTIUM][CallButton] Window opened successfully');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Call failed';
      console.error('[VIVENTIUM][CallButton] Error:', e);
      setState('error');
      setError(msg);
      alert(`Voice call error: ${msg}`);
    } finally {
      // If active, we keep it active until window closes; otherwise return to idle shortly.
      setTimeout(() => {
        setState((s) => (s === 'active' ? 'active' : 'idle'));
      }, 800);
    }
  }, [agentId, conversationId, enabled, state]);

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

  const label = isActive ? 'End voice call' : 'Start voice call';
  const title =
    state === 'idle'
      ? 'Start voice call'
      : state === 'connecting'
        ? 'Connecting…'
        : state === 'active'
          ? 'End voice call'
          : error || 'Error';

  return (
    <TooltipAnchor
      description={title}
      render={
        <button
          type="button"
          onClick={isActive ? endCall : startCall}
          disabled={isConnecting}
          aria-label={label}
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
  );
}

/* === VIVENTIUM NOTE === */
