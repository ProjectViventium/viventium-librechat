import type { TUserMemory } from 'librechat-data-provider';
import MemoryEmptyState from './MemoryEmptyState';
import MemoryCard from './MemoryCard';
import { useLocalize } from '~/hooks';

interface MemoryListProps {
  memories: TUserMemory[];
  hasUpdateAccess: boolean;
  isFiltered?: boolean;
}

/* === VIVENTIUM START ===
 * Feature: Duplicate memory-key tolerance
 * Purpose: The local dedupe migration is safe/dry-run first, so existing duplicate keys must not
 * make the Memory panel unstable before the user applies cleanup.
 * === VIVENTIUM END === */
const getMemoryRowKey = (memory: TUserMemory, index: number) =>
  (memory as TUserMemory & { _id?: string })._id ?? `${memory.key}:${memory.updated_at}:${index}`;

export default function MemoryList({
  memories,
  hasUpdateAccess,
  isFiltered = false,
}: MemoryListProps) {
  const localize = useLocalize();

  if (memories.length === 0) {
    return <MemoryEmptyState isFiltered={isFiltered} />;
  }

  return (
    <div className="space-y-2" role="list" aria-label={localize('com_ui_memories')}>
      {memories.map((memory, index) => (
        <div key={getMemoryRowKey(memory, index)} role="listitem">
          <MemoryCard memory={memory} hasUpdateAccess={hasUpdateAccess} />
        </div>
      ))}
    </div>
  );
}
