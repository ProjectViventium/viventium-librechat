import { useState, useRef, useMemo, useLayoutEffect, useEffect } from 'react';
import { Tools } from 'librechat-data-provider';
import type { MemoryArtifact, TAttachment } from 'librechat-data-provider';
import MemoryInfo from './MemoryInfo';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type MemoryWriterHealthState = {
  kind: 'memory_writer_health';
  status: 'degraded' | 'recovered';
  reason: 'auth' | 'quota';
  provider: string;
  model: string;
  cooldownUntil: string;
  errorType?: string;
};

type MemoryWriterHealthNotice = MemoryWriterHealthState;

const memoryWriterAuthErrorTypes = new Set([
  'provider_auth',
  'provider_auth_missing',
  'provider_unauthorized',
  'provider_access_denied',
  'authentication_error',
]);
const memoryWriterQuotaErrorTypes = new Set([
  'usage_limit_reached',
  'insufficient_quota',
  'billing_hard_limit_reached',
  'provider_quota_exhausted',
]);

function parseMemoryWriterHealthNotice(artifact: MemoryArtifact): MemoryWriterHealthNotice | null {
  if (artifact.type !== 'error') {
    return null;
  }
  try {
    const details: {
      errorType?: string;
      healthState?: Partial<MemoryWriterHealthState>;
    } = JSON.parse(String(artifact.value ?? ''));
    const healthState = details.healthState;
    const errorType = typeof details.errorType === 'string' ? details.errorType.trim() : '';
    if (
      healthState?.kind !== 'memory_writer_health' ||
      (healthState.status !== 'degraded' && healthState.status !== 'recovered') ||
      (healthState.reason !== 'auth' && healthState.reason !== 'quota') ||
      typeof healthState.provider !== 'string' ||
      !healthState.provider.trim() ||
      typeof healthState.model !== 'string' ||
      !healthState.model.trim() ||
      typeof healthState.cooldownUntil !== 'string' ||
      !healthState.cooldownUntil.trim()
    ) {
      return null;
    }
    if (healthState.status === 'recovered' && errorType !== 'writer_recovered') {
      return null;
    }
    if (
      healthState.status === 'degraded' &&
      healthState.reason === 'auth' &&
      !memoryWriterAuthErrorTypes.has(errorType)
    ) {
      return null;
    }
    if (
      healthState.status === 'degraded' &&
      healthState.reason === 'quota' &&
      !memoryWriterQuotaErrorTypes.has(errorType)
    ) {
      return null;
    }
    if (
      healthState.status === 'degraded' &&
      typeof healthState.errorType === 'string' &&
      healthState.errorType !== errorType
    ) {
      return null;
    }
    return {
      kind: healthState.kind,
      status: healthState.status,
      reason: healthState.reason,
      provider: healthState.provider,
      model: healthState.model,
      cooldownUntil: healthState.cooldownUntil,
      ...(typeof healthState.errorType === 'string' ? { errorType: healthState.errorType } : {}),
    };
  } catch {
    return null;
  }
}

export default function MemoryArtifacts({ attachments }: { attachments?: TAttachment[] }) {
  const localize = useLocalize();
  const [showInfo, setShowInfo] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const prevShowInfoRef = useRef<boolean>(showInfo);

  const { hasErrors, hasDegraded, healthNotices, memoryArtifacts } = useMemo(() => {
    let hasErrors = false;
    let hasDegraded = false;
    const result: MemoryArtifact[] = [];
    const notices: MemoryWriterHealthNotice[] = [];

    if (!attachments || attachments.length === 0) {
      return { hasErrors, hasDegraded, healthNotices: notices, memoryArtifacts: result };
    }

    for (const attachment of attachments) {
      if (attachment?.[Tools.memory] != null) {
        const artifact = attachment[Tools.memory];
        const healthNotice = parseMemoryWriterHealthNotice(artifact);
        if (healthNotice) {
          notices.push(healthNotice);
          if (healthNotice.status === 'degraded') {
            hasDegraded = true;
          }
          continue;
        }
        result.push(artifact);

        if (!hasErrors && artifact.type === 'error') {
          hasErrors = true;
        }
      }
    }

    return { hasErrors, hasDegraded, healthNotices: notices, memoryArtifacts: result };
  }, [attachments]);

  const degradedLabel = `${localize('com_ui_memory')} · ${localize('com_ui_unavailable')}`;
  const degradedCopy = {
    auth: `${localize('com_ui_reconnect')} ${localize('com_ui_memory')}`,
    quota: `${localize('com_ui_provider')} · ${localize('com_ui_unavailable')}`,
  };
  let buttonLabel = localize('com_ui_memory_updated');
  let buttonStateClass = 'text-text-secondary-alt hover:text-text-primary';
  if (hasDegraded) {
    buttonLabel = degradedLabel;
    buttonStateClass = 'text-text-warning hover:text-text-primary';
  }
  if (hasErrors) {
    buttonLabel = localize('com_ui_memory_error');
    buttonStateClass = 'text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-500';
  }

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

  if (memoryArtifacts.length === 0 && healthNotices.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex items-center">
        <div className="inline-block">
          <button
            className={cn(
              'outline-hidden my-1 flex items-center gap-1 text-sm font-semibold transition-colors',
              buttonStateClass,
            )}
            type="button"
            onClick={() => setShowInfo((prev) => !prev)}
            aria-expanded={showInfo}
            aria-label={buttonLabel}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="mb-[-1px]"
            >
              <path
                d="M6 3C4.89543 3 4 3.89543 4 5V13C4 14.1046 4.89543 15 6 15L6 3Z"
                fill="currentColor"
              />
              <path
                d="M7 3V15H8.18037L8.4899 13.4523C8.54798 13.1619 8.69071 12.8952 8.90012 12.6858L12.2931 9.29289C12.7644 8.82153 13.3822 8.58583 14 8.58578V3.5C14 3.22386 13.7761 3 13.5 3H7Z"
                fill="currentColor"
              />
              <path
                d="M11.3512 15.5297L9.73505 15.8529C9.38519 15.9229 9.07673 15.6144 9.14671 15.2646L9.46993 13.6484C9.48929 13.5517 9.53687 13.4628 9.60667 13.393L12.9996 10C13.5519 9.44771 14.4473 9.44771 14.9996 10C15.5519 10.5523 15.5519 11.4477 14.9996 12L11.6067 15.393C11.5369 15.4628 11.448 15.5103 11.3512 15.5297Z"
                fill="currentColor"
              />
            </svg>
            {buttonLabel}
          </button>
        </div>
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
            'overflow-hidden rounded-xl border border-border-light bg-surface-primary-alt shadow-md',
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
            {showInfo && (
              <>
                {healthNotices.length > 0 && (
                  <div className="space-y-2 p-4">
                    {healthNotices.map((notice, index) => {
                      const isDegraded = notice.status === 'degraded';
                      const noticeLabel = isDegraded
                        ? degradedLabel
                        : localize('com_ui_memory_updated');
                      return (
                        <div
                          key={`${notice.status}-${notice.provider ?? ''}-${notice.model ?? ''}-${notice.cooldownUntil ?? ''}-${index}`}
                          data-testid={`memory-health-${notice.status}`}
                          role="status"
                          className={cn(
                            'rounded-md p-3 text-sm',
                            isDegraded
                              ? 'bg-amber-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200'
                              : 'bg-surface-secondary text-text-primary',
                          )}
                        >
                          <div className="font-semibold">{noticeLabel}</div>
                          {isDegraded && <div className="mt-1">{degradedCopy[notice.reason]}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {memoryArtifacts.length > 0 && (
                  <MemoryInfo key="memory-info" memoryArtifacts={memoryArtifacts} />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
