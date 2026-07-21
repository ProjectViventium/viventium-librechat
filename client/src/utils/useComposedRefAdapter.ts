// VIVENTIUM START — Browser-only compatibility adapter derived from use-composed-ref.
// Attribution and exact upstream MIT declaration: ./useComposedRefAdapter.NOTICE.md
import { useCallback } from 'react';
import type { MutableRefObject, Ref } from 'react';

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    (ref as MutableRefObject<T | null>).current = value;
  }
}

/** Browser-build compatibility surface for react-textarea-autosize's two-ref contract. */
export default function useComposedRef<T>(
  internalRef: MutableRefObject<T | null>,
  externalRef?: Ref<T>,
) {
  return useCallback(
    (value: T | null) => {
      internalRef.current = value;
      assignRef(externalRef, value);
    },
    [externalRef, internalRef],
  );
}
// VIVENTIUM END
