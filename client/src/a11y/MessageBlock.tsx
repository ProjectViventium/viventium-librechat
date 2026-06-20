import React from 'react';
import { sanitizeLiveAnnouncementText } from './sanitizeLiveAnnouncementText';

const offScreenStyle: React.CSSProperties = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  padding: 0,
  width: '1px',
  position: 'absolute',
};

interface MessageBlockProps {
  message: string;
  'aria-live': 'polite' | 'assertive';
}

const MessageBlock: React.FC<MessageBlockProps> = ({ message, 'aria-live': ariaLive }) => (
  <div style={offScreenStyle} role="log" aria-live={ariaLive}>
    {/* === VIVENTIUM START ===
     * Feature: User-facing GlassHive signed-link hygiene.
     * Purpose: Offscreen log text is user-facing for privacy; strip signed links/tokens.
     * === VIVENTIUM END === */}
    {sanitizeLiveAnnouncementText(message)}
  </div>
);

export default MessageBlock;
