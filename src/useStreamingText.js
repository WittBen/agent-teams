import { useEffect, useRef, useState } from 'react';

// Smooth presentation only. Parsing, ticket persistence and model completion
// consume the original stream immediately and never wait for this animation.
export default function useStreamingText(text) {
  const [visible, setVisible] = useState('');
  const shown = useRef('');
  useEffect(() => {
    let frame;
    let previous = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = now => {
      if (now - previous >= 32) {
        previous = now;
        const next = text || '';
        const current = next.startsWith(shown.current) ? shown.current : '';
        const remaining = next.length - current.length;
        let end = Math.min(next.length, current.length + Math.max(12, Math.ceil(remaining / 5)));
        // Do not reveal half of an emoji/surrogate pair.
        if (end < next.length && /[\uD800-\uDBFF]/.test(next[end - 1])) end += 1;
        const value = reducedMotion ? next : next.slice(0, end);
        if (value !== shown.current) { shown.current = value; setVisible(value); }
      }
      if (shown.current !== (text || '')) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [text]);
  return visible;
}
