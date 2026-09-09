import Icon from './Icon';
import React, { useEffect, useRef } from 'react';
import { useI18n } from './i18n';

export default function ChatOptionsMenu({ children, label = 'Chat-Optionen', icon = 'settings', showLabel = false }) {
  const { t } = useI18n();
  const ref = useRef(null);
  useEffect(() => {
    const outside = event => {
      if (ref.current && !ref.current.contains(event.target)) ref.current.open = false;
    };
    const escape = event => {
      if (event.key === 'Escape' && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return <details className="chat-options-menu" ref={ref}>
    <summary className="icon-btn" title={t(label)} aria-label={t(label)}><Icon name={icon} />{showLabel && <span>{t(label)}</span>}</summary>
    <div className="chat-options-popover">
      <div className="chat-options-heading">{t(label)}</div>
      {children}
    </div>
  </details>;
}
