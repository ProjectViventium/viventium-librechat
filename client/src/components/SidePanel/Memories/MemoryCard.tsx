import type { TUserMemory } from 'librechat-data-provider';
import MemoryCardActions from './MemoryCardActions';
import { cn } from '~/utils';

interface MemoryCardProps {
  memory: TUserMemory;
  hasUpdateAccess: boolean;
}

export default function MemoryCard({ memory, hasUpdateAccess }: MemoryCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg px-3 py-2.5',
        'border border-border-light bg-transparent',
        'hover:bg-surface-secondary',
      )}
    >
      {/* === VIVENTIUM START === Exact saved content leads; technical details stay in Edit. === */}
      <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
        {memory.value}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 break-all text-xs text-text-secondary">{memory.key}</span>
        {hasUpdateAccess && (
          <div className="shrink-0">
            <MemoryCardActions memory={memory} />
          </div>
        )}
      </div>
      {/* === VIVENTIUM END === */}
    </div>
  );
}
