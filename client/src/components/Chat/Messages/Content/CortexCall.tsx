/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Component: CortexCall - Display cortex activation/brewing/insight events
 * Added: 2026-01-03
 */
import { useMemo, useState, useEffect, useRef, useLayoutEffect } from 'react';
import ProgressText from './ProgressText';
import type { CortexStatus } from 'librechat-data-provider';
import CortexCallInfo from './CortexCallInfo';
import { cn } from '~/utils';

export default function CortexCall({
  cortex_id: _cortex_id,
  cortex_name,
  status,
  confidence,
  reason,
  insight,
  silent = false,
  no_response = false,
  isLast = false,
}: {
  cortex_id: string;
  cortex_name: string;
  status: CortexStatus;
  confidence?: number;
  reason?: string;
  insight?: string;
  silent?: boolean;
  no_response?: boolean;
  isLast?: boolean;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevShowInfoRef = useRef<boolean>(showInfo);

  // Determine if we have expandable content
  const hasInfo = useMemo(
    () => (insight?.length ?? 0) > 0 || (reason?.length ?? 0) > 0,
    [insight, reason],
  );

  // Progress state: 0-1 based on status
  const progress = useMemo(() => {
    switch (status) {
      case 'activating':
        return 0.2;
      case 'brewing':
        return 0.6;
      case 'complete':
        return 1;
      case 'skipped':
      case 'error':
        return 1;
      default:
        return 0.1;
    }
  }, [status]);

  const isComplete = status === 'complete';
  const isSkipped = status === 'skipped';
  const isError = status === 'error';
  const cancelled = isError;
  const isSilentComplete = isComplete && !hasInfo && (silent || no_response);

  // Get display text based on status
  const getText = () => {
    switch (status) {
      case 'activating':
        return `Checking ${cortex_name}...`;
      case 'brewing':
        return `Analyzing with ${cortex_name}...`;
      case 'complete':
        return `Insight from ${cortex_name}`;
      case 'skipped':
        return `${cortex_name} skipped`;
      case 'error':
        return `${cortex_name} error`;
      default:
        return cortex_name;
    }
  };

  // Animation for expandable content
  useLayoutEffect(() => {
    if (showInfo !== prevShowInfoRef.current) {
      prevShowInfoRef.current = showInfo;
      setIsAnimating(true);

      if (showInfo && contentRef.current) {
        requestAnimationFrame(() => {
          if (contentRef.current) {
            const height = contentRef.current.scrollHeight;
            setContentHeight(height + 4);
          }
        });
      } else {
        setContentHeight(0);
      }

      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 400);

      return () => clearTimeout(timer);
    }
  }, [showInfo]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }
    const resizeObserver = new ResizeObserver((entries) => {
      if (showInfo && !isAnimating) {
        for (const entry of entries) {
          if (entry.target === contentRef.current) {
            setContentHeight(entry.contentRect.height + 4);
          }
        }
      }
    });
    resizeObserver.observe(contentRef.current);
    return () => {
      resizeObserver.disconnect();
    };
  }, [showInfo, isAnimating]);

  // Don't show skipped cortices unless they have info to show
  if (isSilentComplete || (isSkipped && !hasInfo && !isLast)) {
    return null;
  }

  const text = getText();

  return (
    <>
      <div className="relative my-2.5 flex h-5 shrink-0 items-center gap-2.5">
        <ProgressText
          progress={progress}
          onClick={hasInfo ? () => setShowInfo((prev) => !prev) : undefined}
          inProgressText={text}
          finishedText={isComplete ? `Insight from ${cortex_name}` : text}
          hasInput={hasInfo}
          isExpanded={showInfo}
          error={cancelled}
        />
      </div>
      <div
        className="relative"
        style={{
          height: showInfo ? contentHeight : 0,
          overflow: 'hidden',
          transition:
            'height 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          opacity: showInfo ? 1 : 0,
          transformOrigin: 'top',
          willChange: 'height, opacity',
          perspective: '1000px',
          backfaceVisibility: 'hidden',
          WebkitFontSmoothing: 'subpixel-antialiased',
        }}
      >
        <div
          className={cn(
            'overflow-hidden rounded-xl border border-border-light bg-surface-secondary shadow-md',
            showInfo && 'shadow-lg',
          )}
          style={{
            transform: showInfo ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.98)',
            opacity: showInfo ? 1 : 0,
            transition:
              'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div ref={contentRef}>
            {showInfo && hasInfo && (
              <CortexCallInfo
                key="cortex-call-info"
                cortex_name={cortex_name}
                status={status}
                confidence={confidence}
                reason={reason}
                insight={insight}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* === VIVENTIUM NOTE === */
