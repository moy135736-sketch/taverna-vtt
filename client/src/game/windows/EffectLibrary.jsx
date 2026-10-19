// Готовые эффекты: мастер отмечает нужные и добавляет к столу; потом их можно поправить в редакторе маркера
import { useState } from 'preact/hooks';
import { useApp } from '../hooks.js';
import { Modal, Button, toast } from '../../ui/components.jsx';
import { EFFECT_LIBRARY, libraryToDef } from '../effectLibrary.js';
import { markerDefs, markerLook, describeEffect } from '../effects.js';
import { MarkerLookView } from './MarkerEditor.jsx';

const GROUPS = [
  { sys: 'dnd2024', title: 'D&D 2024', hint: 'Меняют поля листа «D&D 2024» Таверны: КД, скорость, временные хиты, добавки к атакам и спасброскам.' },
  { sys: 'any', title: 'Для любой системы', hint: 'Меняют сам токен (свет, зрение, размер, невидимость) или действуют каждый ход: урон, лечение, спасбросок.' },
];

export function EffectLibrary({ onClose }) {
  const app = useApp();
  const { store, net } = app;
  const list = store.settings.markers || [];
  const have = new Set(list.map((m) => m?.id));
  const defs = markerDefs(store);
  const sheet = `${store.game?.sheetName || ''} ${store.game?.sheetRef || ''}`;
  const isDnd2024 = /dnd\s*2024|d&d\s*2024/i.test(sheet);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id, on) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const add = async () => {
    const items = EFFECT_LIBRARY.filter((e) => picked.has(e.id) && !have.has(e.id)).map(libraryToDef);
    if (!items.length) return onClose(null);
    setBusy(true);
    const r = await net.request('settings', { markers: [...list, ...items] });
    setBusy(false);
    if (r?.error) return toast(r.error, 'error');
    toast(`Добавлено эффектов: ${items.length}. Их можно поправить в «Маркеры и эффекты».`, 'ok');
    onClose(items.length);
  };

  const count = [...picked].filter((id) => !have.has(id)).length;
  return (
    <Modal title="Готовые эффекты" onClose={() => onClose(null)} width={640} class="effect-library">
      <p class="small muted fxl-intro">
        Отметьте нужные — они появятся среди маркеров стола. Ставятся через «+» у выделенного токена, кнопкой «Наложить» под броском заклинания в чате или макросом <code>/effect Название</code>.
      </p>
      {GROUPS.map((g) => {
        const ids = EFFECT_LIBRARY.filter((e) => e.sys === g.sys && !have.has(e.id)).map((e) => e.id);
        const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
        return (
        <section class="fxl-group" aria-label={g.title}>
          <div class="fxl-head">
            <h4 class="sub-h">{g.title}</h4>
            {ids.length > 0 && (
              <button
                type="button"
                class="link-btn small"
                onClick={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    for (const id of ids) {
                      if (allOn) n.delete(id);
                      else n.add(id);
                    }
                    return n;
                  })
                }
              >
                {allOn ? 'снять все' : 'отметить все'}
              </button>
            )}
          </div>
          <p class="small muted fxl-hint">
            {g.hint}
            {g.sys === 'dnd2024' && !isDnd2024 ? ' За этим столом другой лист — после добавления поменяйте названия полей в редакторе эффекта.' : ''}
          </p>
          <ul class="fxl-list">
            {EFFECT_LIBRARY.filter((e) => e.sys === g.sys).map((e) => {
              const added = have.has(e.id);
              const desc = describeEffect(e);
              return (
                <li class={added ? 'added' : ''}>
                  <label class="fxl-item">
                    <input type="checkbox" checked={added || picked.has(e.id)} disabled={added} onChange={(ev) => toggle(e.id, ev.currentTarget.checked)} />
                    <MarkerLookView look={markerLook(e, defs)} size={26} />
                    <span class="fxl-text">
                      <span class="fxl-name">
                        <span class="fxl-title">{e.name}</span>
                        {e.alias && <span class="fxl-alias"> {e.alias}</span>}
                        {added && <span class="fxl-have"> — уже за столом</span>}
                      </span>
                      {e.note && <span class="fxl-note">{e.note}</span>}
                      {desc && <span class="fxl-desc">{desc}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
        );
      })}
      <div class="modal-actions">
        <span class="grow small muted">{count ? `Выбрано: ${count}` : 'Ничего не выбрано'}</span>
        <Button onClick={() => onClose(null)}>Отмена</Button>
        <Button kind="primary" disabled={!count || busy} onClick={add}>
          Добавить
        </Button>
      </div>
    </Modal>
  );
}
