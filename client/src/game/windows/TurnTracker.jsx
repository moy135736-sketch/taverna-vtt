import { useState } from 'preact/hooks';
import { AppCtx, useApp, useStoreEvents } from '../hooks.js';
import { FloatingWindow, Button, IconButton, Modal, Field, showModal, toast } from '../../ui/components.jsx';
import { Icon } from '../../ui/icons.jsx';

/** Карта инициативы: «K♠», «10♥», джокеры JR/JB */
function CardBadge({ card }) {
  const joker = card === 'JR' || card === 'JB';
  const red = card === 'JR' || /[♥♦]$/.test(card);
  return (
    <span class={'turn-card' + (red ? ' red' : '')} title={joker ? 'Джокер: ходит когда угодно, +2 ко всем броскам' : 'Карта инициативы'}>
      {joker ? 'Джокер' : card}
    </span>
  );
}

/** Своя запись: название, значение и формула (+1 каждый раз, когда до неё доходит очередь) */
function CustomEntryDialog({ onDone }) {
  const [name, setName] = useState('');
  const [pr, setPr] = useState('0');
  const [formula, setFormula] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onDone({ name: name.trim(), pr: isNaN(Number(pr)) ? pr : Number(pr), formula: formula.trim() });
  };
  return (
    <Modal title="Своя запись в порядке ходов" onClose={() => onDone(null)} width={400}>
      <form onSubmit={submit}>
        <Field label="Название">
          <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="Например, «Кубик эскалации» или «Обвал»" autoFocus />
        </Field>
        <div class="grid-2">
          <Field label="Значение">
            <input class="input" value={pr} onInput={(e) => setPr(e.currentTarget.value)} />
          </Field>
          <Field label="Формула" hint="+1 — прибавлять, когда до записи доходит ход">
            <input class="input" value={formula} onInput={(e) => setFormula(e.currentTarget.value)} placeholder="+1" />
          </Field>
        </div>
        <div class="modal-actions">
          <Button onClick={() => onDone(null)}>Отмена</Button>
          <Button kind="primary" type="submit" disabled={!name.trim()}>
            Добавить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TurnTracker({ winKey }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['game', 'col:obj', 'selection']);
  const st = store.state;
  const list = st.turnorder || [];
  const gm = store.isGM;
  const op = (o) => net.request('turn', o).then((r) => r?.error && toast(r.error, 'error'));

  const label = (e) => {
    if (e.tokenId) {
      const o = store.col.obj.get(e.tokenId);
      return o ? o.name || (o.represents ? store.col.char.get(o.represents)?.name : '') || 'Токен' : '(удалён)';
    }
    return e.name || '?';
  };
  const img = (e) => {
    const o = e.tokenId && store.col.obj.get(e.tokenId);
    if (!o) return null;
    if (o.type === 'image' && o.src && !/\.(webm|mp4)/i.test(o.src)) return o.src;
    return null;
  };

  const addSelected = () => {
    const sel = store.selectedObjs().filter((o) => o.type !== 'wall' && store.canControlObj(o));
    if (!sel.length) return toast('Выделите токены на карте', 'error');
    for (const o of sel) op({ t: 'add', tokenId: o.id, pr: 0 });
  };
  // бонус инициативы берём из листа, если такой атрибут есть (D&D 5E: initiative_bonus)
  const INIT_ATTRS = ['initiative_bonus', 'initiative', 'init', 'initiative_mod', 'init_bonus'];
  const rollSelected = async () => {
    const sel = store.selectedObjs().filter((o) => o.type !== 'wall' && store.canControlObj(o));
    if (!sel.length) return toast('Выделите токены на карте', 'error');
    for (const o of sel) {
      const ch = o.represents && store.col.char.get(o.represents);
      let bonus = '';
      if (ch && store.canControlChar(ch)) {
        try {
          const attrs = await net.ensureAttrs(ch.id);
          for (const n of INIT_ATTRS) {
            const a = attrs.get(n);
            const v = a && Number(a.current);
            if (a && a.current !== '' && Number.isFinite(v)) {
              bonus = v >= 0 ? `+${v}` : String(v);
              break;
            }
          }
        } catch {
          /* нет доступа к атрибутам */
        }
      }
      app.runMacro(`/r 1d20${bonus}[инициатива] &{tracker}`, { selected: [o.id], as: ch && store.canControlChar(ch) ? { type: 'char', id: ch.id } : undefined });
    }
  };
  const mine = (e) => {
    const o = e.tokenId && store.col.obj.get(e.tokenId);
    return gm || (o && store.canControlObj(o));
  };
  const focus = (e) => {
    const o = e.tokenId && store.col.obj.get(e.tokenId);
    if (!o) return;
    if (o.pageId !== store.ui.pageId && gm) store.setPage(o.pageId);
    if (o.pageId === store.ui.pageId) {
      app.board()?.centerOn(o.x + o.w / 2, o.y + o.h / 2);
      if (store.canControlObj(o)) store.setSelection([o.id]);
    }
  };

  return (
    <FloatingWindow id="turn" title={`Порядок ходов — раунд ${st.round || 1}`} onClose={() => app.closeWin(winKey)} width={330} height={460} icon="clock">
      <div class="turn-body">
        <ol class="turn-list">
          {list.map((e, i) => (
            <li class={'turn-row ' + (i === 0 ? 'current' : '')} onDblClick={() => focus(e)}>
              <span class="turn-av">{img(e) ? <img src={img(e)} alt="" /> : <Icon name={e.tokenId ? 'user' : 'flag'} size={16} />}</span>
              <span class="grow turn-name">
                {label(e)}
                {e.formula && <span class="turn-formula" title="Формула: применяется, когда до записи доходит ход">{e.formula}</span>}
              </span>
              {e.card ? (
                <CardBadge card={e.card} />
              ) : mine(e) ? (
                <input
                  class="input input-sm turn-pr"
                  value={e.pr}
                  aria-label="Инициатива"
                  onChange={(ev) => {
                    const v = ev.currentTarget.value;
                    op({ t: 'update', id: e.id, pr: isNaN(Number(v)) ? v : Number(v) });
                  }}
                />
              ) : (
                <span class="turn-pr ro">{e.pr}</span>
              )}
              {mine(e) && <IconButton icon="x" title="Убрать" size={14} onClick={() => op({ t: 'remove', id: e.id })} />}
            </li>
          ))}
        </ol>
        {!list.length && <p class="empty small">Добавьте выделенные токены или бросьте инициативу с &#123;tracker&#125; — например, кнопкой инициативы в листе.</p>}
        <div class="turn-actions">
          {(gm || (list[0] && mine(list[0]))) && (
            <Button kind="primary" size="sm" icon="chevRight" onClick={() => op({ t: 'next' })}>
              {gm ? 'Следующий ход' : 'Завершить ход'}
            </Button>
          )}
          {gm && <IconButton icon="chevLeft" title="Предыдущий ход" onClick={() => op({ t: 'prev' })} />}
          {gm && <IconButton icon="list" title="Сортировать по убыванию" onClick={() => op({ t: 'sort', asc: false })} />}
          <IconButton icon="plus" title="Добавить выделенные токены" onClick={addSelected} />
          <IconButton icon="dice" title="Бросить инициативу за выделенные (d20 + бонус из листа)" onClick={rollSelected} />
          {gm && (
            <IconButton
              icon="flag"
              title="Своя запись (например, «Ловушка» или «Кубик эскалации» с формулой +1)"
              onClick={() =>
                showModal((close) => (
                  <AppCtx.Provider value={app}>
                    <CustomEntryDialog
                      onDone={(v) => {
                        close();
                        if (v) op({ t: 'add', name: v.name, pr: v.pr, formula: v.formula });
                      }}
                    />
                  </AppCtx.Provider>
                ))
              }
            />
          )}
          {gm && <IconButton icon="shuffle" title="Раздать карты инициативы (Savage Worlds, Deadlands): каждому токену — карта, ходят от старшей" onClick={() => op({ t: 'deal' })} />}
          {gm && <IconButton icon="trash" title="Очистить" onClick={() => op({ t: 'clear' })} />}
        </div>
      </div>
    </FloatingWindow>
  );
}
