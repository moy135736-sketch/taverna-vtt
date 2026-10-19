import { useState, useEffect } from 'preact/hooks';
import { useApp } from '../hooks.js';
import { rollTooltipHtml } from './format.js';
import { parseTemplateProps } from '@shared/text.js';

/** Подсказка с деталями броска при наведении на inline-бросок */
export function RollTooltip() {
  const { store } = useApp();
  const [tip, setTip] = useState(null);
  useEffect(() => {
    const over = (e) => {
      const el = e.target.closest?.('.inlinerollresult[data-mid]');
      if (!el) return;
      const msg = store.messages.find((m) => m.id === el.dataset.mid);
      if (!msg) return;
      const idx = el.dataset.roll === '' ? null : Number(el.dataset.roll);
      const roll = idx !== null ? msg.inlinerolls?.[idx] : null;
      let computed;
      if (el.dataset.computed && msg.computed) {
        for (const [k, i] of Object.entries(msg.rollKeys || {})) if (i === idx && msg.computed[k] !== undefined) computed = msg.computed[k];
        if (computed === undefined) computed = el.textContent;
      }
      if (!roll && computed === undefined) return;
      const r = el.getBoundingClientRect();
      setTip({ html: rollTooltipHtml(roll || { expression: '', parts: [], total: computed }, computed), x: r.left + r.width / 2, y: r.top });
    };
    const out = (e) => {
      if (e.target.closest?.('.inlinerollresult[data-mid]')) setTip(null);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
    };
  }, []);
  if (!tip) return null;
  const left = Math.min(Math.max(8, tip.x - 160), window.innerWidth - 328);
  const below = tip.y < 140;
  return <div class={'roll-tip ' + (below ? 'below' : '')} style={{ left: left + 'px', top: (below ? tip.y + 26 : tip.y - 8) + 'px' }} dangerouslySetInnerHTML={{ __html: tip.html }} role="tooltip" />;
}
