import { useState, useEffect, useRef } from 'preact/hooks';
import { Modal, Button } from '../../ui/components.jsx';
import { decodeEntities } from '@shared/text.js';

/** Запрос Roll20 ?{Вопрос|...} */
export function QueryDialog({ q, onDone }) {
  const [v, setV] = useState(q.type === 'select' ? '0' : decodeEntities(q.default || ''));
  const ref = useRef();
  useEffect(() => {
    setTimeout(() => {
      ref.current?.focus();
      ref.current?.select?.();
    }, 30);
  }, []);
  const submit = (e) => {
    e?.preventDefault();
    if (q.type === 'select') onDone(q.options[Number(v)]?.value ?? '');
    else onDone(v);
  };
  return (
    <Modal title={decodeEntities(q.prompt) || 'Запрос'} onClose={() => onDone(null)} width={400} class="query-modal">
      <form onSubmit={submit}>
        {q.type === 'select' ? (
          <select ref={ref} class="input" value={v} onChange={(e) => setV(e.currentTarget.value)} size={Math.min(8, q.options.length)} onDblClick={submit}>
            {q.options.map((o, i) => (
              <option value={String(i)}>{decodeEntities(o.label)}</option>
            ))}
          </select>
        ) : (
          <input ref={ref} class="input" value={v} onInput={(e) => setV(e.currentTarget.value)} />
        )}
        <div class="modal-actions">
          <Button type="button" onClick={() => onDone(null)}>
            Отмена
          </Button>
          <Button kind="primary" type="submit">
            Бросить
          </Button>
        </div>
      </form>
    </Modal>
  );
}
