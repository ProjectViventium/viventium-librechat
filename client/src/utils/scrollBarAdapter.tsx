import { useLayoutEffect } from 'react';

export const zeroRightClassName = 'right-scroll-bar-position';
export const fullWidthClassName = 'width-before-scroll-bar';
export const noScrollbarsClassName = 'with-scroll-bars-hidden';
export const removedBarSizeVariable = '--removed-body-scroll-bar-size';
export const lockAttribute = 'data-scroll-locked';

type GapMode = 'margin' | 'padding';

export function getGapWidth(gapMode: GapMode = 'margin') {
  if (typeof window === 'undefined') return { left: 0, top: 0, right: 0, gap: 0 };
  const computed = window.getComputedStyle(document.body);
  const read = (property: string) => Number.parseInt(property, 10) || 0;
  const left = read(gapMode === 'padding' ? computed.paddingLeft : computed.marginLeft);
  const top = read(gapMode === 'padding' ? computed.paddingTop : computed.marginTop);
  const right = read(gapMode === 'padding' ? computed.paddingRight : computed.marginRight);
  return {
    left,
    top,
    right,
    gap: Math.max(0, window.innerWidth - document.documentElement.clientWidth + right - left),
  };
}

let activeLocks = 0;
let activeStyle: HTMLStyleElement | null = null;

function lockStyles(
  gapMode: GapMode,
  noRelative: boolean | undefined,
  noImportant: boolean | undefined,
) {
  const { left, top, right, gap } = getGapWidth(gapMode);
  const important = noImportant ? '' : ' !important';
  const bodyGap =
    gapMode === 'padding'
      ? `padding-right: ${gap}px${important};`
      : `padding-left: ${left}px; padding-top: ${top}px; padding-right: ${right}px; margin-left: 0; margin-top: 0; margin-right: ${gap}px${important};`;
  return `
.${noScrollbarsClassName} { overflow: hidden${important}; padding-right: ${gap}px${important}; }
body[${lockAttribute}] { overflow: hidden${important}; overscroll-behavior: contain; ${
    noRelative ? '' : `position: relative${important};`
  } ${bodyGap} ${removedBarSizeVariable}: ${gap}px; }
.${zeroRightClassName} { right: ${gap}px${important}; }
.${fullWidthClassName} { margin-right: ${gap}px${important}; }
.${zeroRightClassName} .${zeroRightClassName} { right: 0${important}; }
.${fullWidthClassName} .${fullWidthClassName} { margin-right: 0${important}; }
`;
}

export function RemoveScrollBar({
  noRelative,
  noImportant,
  gapMode = 'margin',
}: {
  noRelative?: boolean;
  noImportant?: boolean;
  gapMode?: GapMode;
}) {
  useLayoutEffect(() => {
    activeLocks += 1;
    document.body.setAttribute(lockAttribute, String(activeLocks));
    if (activeLocks === 1) {
      activeStyle = document.createElement('style');
      activeStyle.dataset.viventiumScrollLock = 'true';
      activeStyle.textContent = lockStyles(gapMode, noRelative, noImportant);
      document.head.appendChild(activeStyle);
    }

    return () => {
      activeLocks = Math.max(0, activeLocks - 1);
      if (activeLocks === 0) {
        document.body.removeAttribute(lockAttribute);
        activeStyle?.remove();
        activeStyle = null;
      } else {
        document.body.setAttribute(lockAttribute, String(activeLocks));
      }
    };
  }, [gapMode, noImportant, noRelative]);

  return null;
}
