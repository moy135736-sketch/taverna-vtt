// Маркеры выделенного токена прямо на столе: значки сбоку от токена, щелчок — число, срок, «Снять»;
// «+» — поставить любой маркер, в том числе свой (с картинкой и эффектом)
import { useState, useEffect, useRef, useReducer } from 'preact/hooks';
import { useApp, useStoreEvents } from './hooks.js';
import { Button, IconButton } from '../ui/components.jsx';
import { MARKERS } from '@shared/defaults.js';
import { markerDefs, markerLook, markerEntries, markerEntry, roundsLeft, describeChanges, describeEffect, describeTurn, addMarker, removeMarker, setMarkerLevel, setMarkerRounds } from './effects.js';
import { MarkerLookView } from './windows/MarkerEditor.jsx';

const TOKEN_TYPES = new Set(['image', 'shape']);

export function MarkerHud() {
  const app = useApp();
  const { store } = app;
  const [open, setOpen] = useState(null); // id маркера, '+' — выбор маркера
  const [, force] = useReducer((x) => x + 1, 0);
  const ref = useRef();
  const sel = store.selectedObjs();
  const o = sel.length === 1 ? sel[0] : null;
  // фильтр подписки создаётся один раз — поэтому смотрим на текущее выделение, а не на o из первой отрисовки
  useStoreEvents(store, ['selection', 'col:obj', 'game', 'camera', 'tool', 'page'], (ev, a, id) => ev !== 'col:obj' || store.ui.selected.has(id));
  // после перетаскивания значки возвращаются
  useEffect(() => {
    const up = () => setTimeout(force, 0);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  // закрыть всплывающее окно при щелчке мимо и при смене выделения
  useEffect(() => {
    if (!open) return;
    const down = (e) => ref.current && !ref.current.contains(e.target) && setOpen(null);
    // Esc закрывает только окошко маркера — выделение токена остаётся
    const esc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(null);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  useEffect(() => setOpen(null), [o?.id]);

  const board = app.board();
  if (!o || !board || !TOKEN_TYPES.has(o.type) || o.pageId !== store.ui.pageId || !store.canControlObj(o) || store.ui.tool !== 'select') return null;
  if (board.dragging?.moved && board.dragging.kind !== 'pan') return null;
  const defs = markerDefs(store);
  const list = markerEntries(o);
  const a = board.worldToScreen(o.x + o.w, o.y);
  const b = board.worldToScreen(o.x, o.y);
  const width = board.root.clientWidth;
  const left = a.x + 46 > width ? Math.max(4, b.x - 34) : a.x + 8;
  const top = Math.max(4, a.y);
  const flip = left < a.x;

  return (
    <div class={'mk-hud' + (flip ? ' flip' : '')} ref={ref} style={{ left: left + 'px', top: top + 'px' }} onPointerDown={(e) => e.stopPropagation()}>
      {list.map((m) => {
        const def = defs.get(m.id);
        const left = roundsLeft(store, m);
        return (
          <div class="mk-hud-item" key={m.id}>
            <button
              type="button"
              class={'mk-chip' + (open === m.id ? ' on' : '') + (m.conc ? ' conc' : '')}
              title={(def?.name || m.id) + (m.conc ? ' (концентрация)' : '') + ' — число, срок, снять'}
              aria-label={'Маркер ' + (def?.name || m.id)}
              onClick={() => setOpen(open === m.id ? null : m.id)}
            >
              <MarkerLookView look={markerLook(def, defs)} size={24} />
              {m.n !== undefined && m.n !== '' && <b>{m.n}</b>}
              {left !== null ? <i>{Math.max(0, left)}</i> : m.ends ? <i aria-label="до следующего хода">↻</i> : null}
            </button>
            {open === m.id && <MarkerPop o={o} id={m.id} def={def} defs={defs} close={() => setOpen(null)} />}
          </div>
        );
      })}
      <div class="mk-hud-item">
        <button type="button" class={'mk-chip mk-add' + (open === '+' ? ' on' : '')} title="Поставить маркер состояния" aria-label="Поставить маркер состояния" onClick={() => setOpen(open === '+' ? null : '+')}>
          +
        </button>
        {open === '+' && <MarkerPicker o={o} defs={defs} close={() => setOpen(null)} />}
      </div>
    </div>
  );
}

/** Число на маркере, срок в раундах, «Снять» */
function MarkerPop({ o, id, def, defs, close }) {
  const app = useApp();
  const { store } = app;
  const e = markerEntry(o, id);
  const [n, setN] = useState(e?.n ?? '');
  const left = roundsLeft(store, e);
  const [r, setR] = useState(left === null ? '' : String(Math.max(0, left)));
  useEffect(() => setN(e?.n ?? ''), [e?.n]);
  useEffect(() => setR(left === null ? '' : String(Math.max(0, left))), [left]);
  if (!e) return null;
  const level = (v) => setMarkerLevel(app, store.col.obj.get(o.id) || o, id, v);
  const step = (d) => {
    const cur = Number(e.n) || 0;
    const v = cur + d;
    level(v <= 0 ? '' : v);
  };
  const rounds = (v) => setMarkerRounds(app, store.col.obj.get(o.id) || o, id, v);
  const desc = describeChanges(def);
  const turn = describeTurn(def);
  const custom = (store.settings.markers || []).some((m) => m.id === id);
  const src = e.src && e.src !== o.id ? store.col.obj.get(e.src) : null;
  const srcName = src ? src.name || (src.represents && store.col.char.get(src.represents)?.name) || 'токен' : '';
  return (
    <div class="mk-pop" role="dialog" aria-label={'Маркер ' + (def?.name || id)}>
      <div class="mk-pop-head">
        <MarkerLookView look={markerLook(def, defs)} size={26} />
        <b>{def?.name || id}</b>
      </div>
      {def?.note && <p class="small muted">{def.note}</p>}
      {desc && <p class="small mk-desc">Меняет: {desc}</p>}
      {turn && <p class="small mk-desc">{turn.charAt(0).toUpperCase() + turn.slice(1)}</p>}
      {e.ends && <p class="small mk-when">{e.ends.when === 'start' ? 'До начала следующего хода' : 'До конца следующего хода'}</p>}
      {(e.conc || srcName) && (
        <p class="small mk-when">
          {srcName ? `Наложил: ${srcName}` : 'Наложил сам'}
          {e.conc ? ' — держится на его концентрации' : ''}
        </p>
      )}
      <div class="mk-row">
        <span class="small muted">Число</span>
        <IconButton icon="minus" size={14} title="Меньше" onClick={() => step(-1)} />
        <input
          class="input input-sm"
          value={n}
          inputMode="numeric"
          aria-label="Число на маркере"
          onInput={(ev) => setN(ev.currentTarget.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()}
          onBlur={() => String(n) !== String(e.n ?? '') && level(String(n).trim())}
        />
        <IconButton icon="plus" size={14} title="Больше" onClick={() => step(1)} />
      </div>
      <div class="mk-row">
        <span class="small muted">Раундов</span>
        <IconButton icon="minus" size={14} title="На раунд меньше" disabled={left === null} onClick={() => rounds(Math.max(0, (left ?? 1) - 1))} />
        <input
          class="input input-sm"
          value={r}
          inputMode="numeric"
          placeholder="∞"
          aria-label="Сколько раундов осталось (пусто — без срока)"
          onInput={(ev) => setR(ev.currentTarget.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && ev.currentTarget.blur()}
          onBlur={() => r !== (left === null ? '' : String(Math.max(0, left))) && rounds(r.trim())}
        />
        <IconButton icon="plus" size={14} title="На раунд больше" onClick={() => rounds((left ?? 0) + 1)} />
      </div>
      <div class="mk-row mk-actions">
        <Button
          size="sm"
          kind="danger"
          onClick={async () => {
            close();
            await removeMarker(app, store.col.obj.get(o.id) || o, id);
          }}
        >
          Снять
        </Button>
        {store.isGM && custom && (
          <Button
            size="sm"
            kind="ghost"
            onClick={() => {
              close();
              app.editMarker(id);
            }}
          >
            Изменить маркер…
          </Button>
        )}
      </div>
    </div>
  );
}

/** Выбор маркера: свои — первыми, поиск по названию */
function MarkerPicker({ o, defs, close }) {
  const app = useApp();
  const { store } = app;
  const [q, setQ] = useState('');
  const custom = (store.settings.markers || []).filter((m) => m && m.id);
  const all = [...custom, ...MARKERS.filter((m) => !custom.some((c) => c.id === m.id))];
  const shown = q.trim() ? all.filter((m) => (m.name || '').toLowerCase().includes(q.trim().toLowerCase())) : all;
  const toggle = async (id) => {
    const cur = store.col.obj.get(o.id) || o;
    if (markerEntry(cur, id)) await removeMarker(app, cur, id);
    else await addMarker(app, cur, id);
  };
  return (
    <div class="mk-pop mk-picker" role="dialog" aria-label="Маркеры состояния">
      <input class="input input-sm" placeholder="Найти маркер" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Найти маркер" autoFocus />
      <div class="mk-grid">
        {shown.map((m) => {
          const on = !!markerEntry(o, m.id);
          const desc = describeEffect(m);
          return (
            <button type="button" class={'mk-icon' + (on ? ' on' : '')} aria-pressed={on} title={m.name + (desc ? ' — ' + desc : '')} onClick={() => toggle(m.id)}>
              <MarkerLookView look={markerLook(m, defs)} size={22} />
              <span>{m.name}</span>
            </button>
          );
        })}
        {!shown.length && <p class="small faint">Не нашлось</p>}
      </div>
      {store.isGM && (
        <div class="row row-wrap" style={{ gap: '4px' }}>
          <Button
            size="sm"
            icon="plus"
            onClick={async () => {
              close();
              const id = await app.editMarker(null);
              const cur = store.col.obj.get(o.id);
              if (id && cur) await addMarker(app, cur, id);
            }}
          >
            Свой…
          </Button>
          <Button
            size="sm"
            icon="sparkles"
            onClick={() => {
              close();
              app.openEffectLibrary();
            }}
          >
            Готовые эффекты…
          </Button>
        </div>
      )}
    </div>
  );
}
