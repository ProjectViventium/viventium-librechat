import React, { useEffect, useContext } from 'react';
import AnnouncerContext from '~/Providers/AnnouncerContext';
import { sanitizeLiveAnnouncementText } from './sanitizeLiveAnnouncementText';

interface LiveMessageProps {
  message: string;
  'aria-live': 'polite' | 'assertive';
  clearOnUnmount?: boolean | 'true' | 'false';
}

const LiveMessage: React.FC<LiveMessageProps> = ({
  message,
  'aria-live': ariaLive,
  clearOnUnmount,
}) => {
  const { announceAssertive, announcePolite } = useContext(AnnouncerContext);
  const announcement = sanitizeLiveAnnouncementText(message);

  useEffect(() => {
    if (ariaLive === 'assertive') {
      announceAssertive({ message: announcement });
    } else if (ariaLive === 'polite') {
      announcePolite({ message: announcement });
    }
  }, [announcement, ariaLive, announceAssertive, announcePolite]);

  useEffect(() => {
    return () => {
      if (clearOnUnmount === true || clearOnUnmount === 'true') {
        announceAssertive({ message: '' });
        announcePolite({ message: '' });
      }
    };
  }, [clearOnUnmount, announceAssertive, announcePolite]);

  return null;
};

export default LiveMessage;
