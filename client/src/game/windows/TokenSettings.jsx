import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, useStoreEvents } from '../hooks.js';
import { FloatingWindow, Tabs, Button, IconButton, Field, Toggle, ColorInput, toast, confirmDialog } from '../../ui/components.jsx';
import { Icon } from '../../ui/icons.jsx';
import { MARKERS, LAYER_NAMES, MOVE_STYLES, newBar, BAR_COLORS } from '@shared/defaults.js';
import { SHAPES } from '../board/objview.js';
import { lc, attrString } from '@shared/attrs.js';
import { newId } from '@shared/ids.js';
import { markerDefs, markerLook, markerEntries, markerEntry, roundsLeft, describeEffect, addMarker, removeMarker, setMarkerLevel, setMarkerRounds } from '../effects.js';
import { MarkerLookView } from './MarkerEditor.jsx';

/** Поле, которое сохраняется при потере фокуса / Enter */
function LazyInput({ value, onCommit, type = 'text', ...rest }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value ?? '');
  }, [value]);
  const commit = () => {
    if (String(v) !== String(value ?? '')) onCommit(type === 'number' ? (v === '' ? '' : Number(v)) : v);
  };
  return (
    <input
      class="input input-sm"
      type={type}
      value={v}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onInput={(e) => setV(e.currentTarget.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      {...rest}
    />
  );
}

export function TokenSettings({ winKey, id, tab: wantTab, t }) {
  const app = useApp();
  const { store, net } = app;
  // свой токен, а также пассажиры, которые к нему прицепляются или отцепляются
  useStoreEvents(store, ['col:obj', 'col:char', 'col:macro', 'members', 'attrs'], (ev, a, b, old) => (ev === 'col:obj' ? b === id || a?.attachedTo === id || old?.attachedTo === id : true));
  const o = store.col.obj.get(id);
  const [tab, setTab] = useState(wantTab || 'main');
  // окно уже открыто, а его просят открыть на другой вкладке
  useEffect(() => {
    if (wantTab) setTab(wantTab);
  }, [wantTab, t]);
  if (!o) return null;
  const gm = store.isGM;
  const owner = o.ownerId === store.me.id;
  const upd = (patch) => net.update('obj', id, patch).then((r) => r?.error && toast(r.error, 'error'));
  const isWall = o.type === 'wall';
  const tabs = [
    { id: 'main', label: 'Основное' },
    { id: 'bars', label: 'Бары' },
    { id: 'markers', label: 'Маркеры' },
    { id: 'actions', label: 'Макросы' },
    { id: 'look', label: 'Вид' },
    ...(gm ? [{ id: 'light', label: 'Свет и зрение' }] : []),
    { id: 'notes', label: 'Заметки' },
  ];
  const title = (o.name || (o.type === 'shape' ? SHAPES[o.shape || 'rect']?.name : o.type === 'text' ? 'Текст' : 'Токен')) + ' — настройки';
  return (
    <FloatingWindow id="token-settings" title={title} onClose={() => app.closeWin(winKey)} width={560} height={640} icon="cog">
      {isWall ? (
        <WallSettings o={o} upd={upd} />
      ) : (
        <div class="tok-settings">
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
          <div class="tok-tab">
            {tab === 'main' && <MainTab o={o} upd={upd} gm={gm} owner={owner} />}
            {tab === 'bars' && <BarsTab o={o} upd={upd} gm={gm} />}
            {tab === 'markers' && <MarkersTab o={o} />}
            {tab === 'actions' && <ActionsTab o={o} upd={upd} />}
            {tab === 'look' && <LookTab o={o} upd={upd} gm={gm} />}
            {tab === 'light' && gm && <LightTab o={o} upd={upd} />}
            {tab === 'notes' && <NotesTab o={o} upd={upd} gm={gm} />}
          </div>
        </div>
      )}
    </FloatingWindow>
  );
}

function MainTab({ o, upd, gm, owner }) {
  const app = useApp();
  const { store } = app;
  const page = store.col.page.get(o.pageId) || store.page;
  const cs = page?.cellSize || 70;
  const chars = [...store.col.char.values()].filter((c) => gm || store.canControlChar(c)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const players = [...store.members.values()].filter((m) => m.role !== 'gm');
  const ctl = new Set(o.controlledBy || []);
  const toggleCtl = (uid) => {
    ctl.has(uid) ? ctl.delete(uid) : ctl.add(uid);
    upd({ controlledBy: [...ctl] });
  };
  const fileRef = useRef();
  const changeImage = async (e) => {
    const f = e.currentTarget.files[0];
    if (!f) return;
    const a = await app.upload([f], 'токены');
    if (a[0]) upd({ src: a[0].url });
  };
  const ch = o.represents ? store.col.char.get(o.represents) : null;
  return (
    <div>
      <Field label="Имя">
        <LazyInput value={o.name} onCommit={(v) => upd({ name: v })} />
      </Field>
      <div class="row row-wrap" style={{ gap: '16px', marginBottom: '10px' }}>
        <Toggle checked={o.showName} onChange={(v) => upd({ showName: v })} label="Показывать имя" />
        {gm && <Toggle checked={o.showNameToPlayers !== false} onChange={(v) => upd({ showNameToPlayers: v })} label="Имя видно игрокам" />}
      </div>
      <Field label="ID токена" hint="Уникален для каждого токена. В макросах: @{selected|token_id}">
        <div class="row">
          <code class="id-pill">{o.id}</code>
          <IconButton icon="copy" title="Копировать ID" onClick={() => navigator.clipboard?.writeText(o.id).then(() => toast('ID скопирован', 'ok'))} />
        </div>
      </Field>
      <Field label="Анкета (персонаж)">
        <div class="row">
          <select class="input input-sm" value={o.represents || ''} disabled={!gm && !owner} onChange={(e) => upd({ represents: e.currentTarget.value })}>
            <option value="">— не связан —</option>
            {chars.map((c) => (
              <option value={c.id}>{c.name || 'Без имени'}</option>
            ))}
          </select>
          {ch && (
            <Button size="sm" onClick={() => app.openCharacter(ch.id)}>
              Открыть
            </Button>
          )}
        </div>
      </Field>
      <div class="grid-2">
        <Field label="Ширина, клеток">
          <LazyInput type="number" step="0.25" min="0.1" value={Math.round((o.w / cs) * 100) / 100} onCommit={(v) => v > 0 && upd({ w: v * cs })} />
        </Field>
        <Field label="Высота, клеток">
          <LazyInput type="number" step="0.25" min="0.1" value={Math.round((o.h / cs) * 100) / 100} onCommit={(v) => v > 0 && upd({ h: v * cs })} />
        </Field>
        <Field label="Поворот, °">
          <LazyInput type="number" value={o.rot || 0} onCommit={(v) => upd({ rot: Number(v) || 0 })} />
        </Field>
        <Field label="Прозрачность">
          <input type="range" min={0.1} max={1} step={0.05} value={o.opacity ?? 1} onChange={(e) => upd({ opacity: Number(e.currentTarget.value) })} />
        </Field>
      </div>
      {o.type === 'image' && (gm || owner || store.canControlObj(o)) && (
        <div class="row row-wrap" style={{ marginBottom: '10px' }}>
          <input type="file" accept="image/*,video/*" hidden ref={fileRef} onChange={changeImage} />
          <Button size="sm" icon="image" onClick={() => fileRef.current.click()}>
            Сменить картинку
          </Button>
          <select class="input input-sm" style={{ width: '170px' }} value={o.frame || ''} onChange={(e) => upd({ frame: e.currentTarget.value })} aria-label="Рамка">
            <option value="">Без рамки</option>
            <option value="circle">Круглый</option>
            <option value="square">Квадратная рамка</option>
          </select>
          <Toggle checked={o.flipH} onChange={(v) => upd({ flipH: v })} label="Отразить" />
        </div>
      )}
      {o.type === 'shape' && (
        <div>
          <div class="row row-wrap shapes-row" style={{ marginBottom: '8px' }}>
            {Object.entries(SHAPES).map(([k, s]) => (
              <button type="button" class={'chip ' + ((o.shape || 'rect') === k ? 'on' : '')} onClick={() => upd({ shape: k })}>
                {s.name}
              </button>
            ))}
          </div>
          <div class="row row-wrap" style={{ gap: '14px', marginBottom: '8px' }}>
            <span class="small muted">Заливка</span>
            <ColorInput value={o.fill} onChange={(v) => upd({ fill: v })} />
            <span class="small muted">Контур</span>
            <ColorInput value={o.stroke} onChange={(v) => upd({ stroke: v })} />
            <input type="range" min={0} max={20} value={o.strokeWidth ?? 3} onChange={(e) => upd({ strokeWidth: Number(e.currentTarget.value) })} title="Толщина контура" />
          </div>
          <Field label="Надпись на фигуре">
            <LazyInput value={o.text} onCommit={(v) => upd({ text: v })} />
          </Field>
        </div>
      )}
      {o.type === 'text' && (
        <div>
          <Field label="Текст">
            <LazyInput value={o.text} onCommit={(v) => upd({ text: v })} />
          </Field>
          <div class="row">
            <ColorInput value={o.color} onChange={(v) => upd({ color: v })} />
            <LazyInput type="number" value={o.fontSize || 24} onCommit={(v) => upd({ fontSize: Number(v) || 24 })} style={{ width: '80px' }} />
          </div>
        </div>
      )}
      {gm && (
        <Field label="Слой">
          <select class="input input-sm" value={o.layer} onChange={(e) => upd({ layer: e.currentTarget.value })}>
            {['map', 'objects', 'foreground', 'gm', 'walls'].map((l) => (
              <option value={l}>{LAYER_NAMES[l]}</option>
            ))}
          </select>
        </Field>
      )}
      {o.type !== 'path' && o.type !== 'text' && (
        <Field label="Как другие видят перемещение">
          <select class="input input-sm" value={o.moveStyle || ''} onChange={(e) => upd({ moveStyle: e.currentTarget.value })}>
            <option value="">Как в настройках стола — {MOVE_STYLES[store.settings.moveStyle || 'instant'].toLowerCase()}</option>
            {Object.entries(MOVE_STYLES).map(([k, n]) => (
              <option value={k}>{n}</option>
            ))}
          </select>
        </Field>
      )}
      <AttachInfo o={o} upd={upd} />
      {gm && (
        <div class="perm-box">
          <h4>Кто может двигать и менять токен</h4>
          {ch && (ch.controlledBy || []).length > 0 && <p class="small muted">Через анкету уже управляют: {(ch.controlledBy || []).map((u) => (u === 'all' ? 'все игроки' : store.memberName(u))).join(', ')}</p>}
          <Toggle checked={ctl.has('all')} onChange={() => toggleCtl('all')} label="Все игроки" />
          {players.map((m) => (
            <Toggle checked={ctl.has(m.id)} onChange={() => toggleCtl(m.id)} label={m.displayName} />
          ))}
          <Toggle checked={!!o.locked} onChange={(v) => upd({ locked: v })} label="Закрепить на месте" />
        </div>
      )}
    </div>
  );
}

function BarsTab({ o, upd, gm }) {
  const app = useApp();
  const { store, net, sheets } = app;
  const bars = Array.isArray(o.bars) ? o.bars : [];
  const ch = o.represents ? store.col.char.get(o.represents) : null;
  const canChar = ch && store.canControlChar(ch);
  const [attrsReady, setAttrsReady] = useState(false);
  useEffect(() => {
    if (ch) net.ensureAttrs(ch.id).then(() => setAttrsReady(true)).catch(() => {});
  }, [ch?.id]);
  const attrNames = attrsReady && ch ? [...(store.attrMap(ch.id)?.values() || [])].map((a) => a.name).filter((n) => !/^repeating_/i.test(n) && !/^_/.test(n)).sort() : [];
  const setBars = (nb) => upd({ bars: nb });
  const setBar = (i, patch) => setBars(bars.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const setValue = (i, field, v) => {
    const b = bars[i];
    if (b.link && canChar) {
      // значение связанного бара хранится в атрибуте анкеты
      sheets.setAttrs(ch.id, { [field === 'max' ? b.link + '_max' : b.link]: v }, { source: 'player' });
    } else setBar(i, { [field]: v });
  };
  const link = (i, name) => {
    const patch = { link: name };
    if (name && ch) {
      const a = store.getAttr(ch.id, name);
      if (a) {
        patch.value = a.current;
        patch.max = a.max;
      }
      if (!bars[i].name) patch.name = name.toUpperCase().slice(0, 6);
    }
    setBar(i, patch);
  };
  const move = (i, d) => {
    const nb = [...bars];
    const j = i + d;
    if (j < 0 || j >= nb.length) return;
    [nb[i], nb[j]] = [nb[j], nb[i]];
    setBars(nb);
  };
  return (
    <div>
      <div class="row row-wrap bar-place">
        <label class="small muted" for={'barpos-' + o.id}>
          Положение у этого токена
        </label>
        <select id={'barpos-' + o.id} class="input input-sm" value={o.barPosition || ''} onChange={(e) => upd({ barPosition: e.currentTarget.value })}>
          <option value="">Как в настройках стола</option>
          <option value="above">Над токеном</option>
          <option value="top">Сверху на токене</option>
          <option value="bottom">Снизу на токене</option>
          <option value="below">Под токеном</option>
        </select>
        <select class="input input-sm" value={o.barStyle || ''} onChange={(e) => upd({ barStyle: e.currentTarget.value })} aria-label="Размер баров у этого токена">
          <option value="">Размер как в настройках</option>
          <option value="standard">Обычные</option>
          <option value="compact">Тонкие</option>
        </select>
      </div>
      <p class="small muted" style={{ marginTop: 0 }}>
        Баров может быть сколько угодно, любого цвета. Связанный бар показывает атрибут анкеты (например, hp) — изменения сразу видны в листе. В макросах бары доступны как @&#123;selected|bar1&#125;, @&#123;selected|bar2|max&#125;…
      </p>
      {bars.map((b, i) => (
        <div class="bar-edit">
          <div class="row">
            <span class="bar-swatch-num">bar{i + 1}</span>
            <ColorInput value={b.color} onChange={(v) => setBar(i, { color: v })} allowTransparent={false} />
            <LazyInput value={b.name} placeholder="Подпись (HP, мана…)" onCommit={(v) => setBar(i, { name: v })} />
            <IconButton icon="chevUp" title="Выше" size={14} onClick={() => move(i, -1)} />
            <IconButton icon="chevDown" title="Ниже" size={14} onClick={() => move(i, 1)} />
            {(gm || o.ownerId === store.me.id) && <IconButton icon="trash" title="Удалить бар" size={15} onClick={() => setBars(bars.filter((_, j) => j !== i))} />}
          </div>
          <div class="row">
            <span class="small muted">Значение</span>
            <LazyInput value={attrString(b.value)} onCommit={(v) => setValue(i, 'value', v)} style={{ width: '90px' }} />
            <span class="small muted">из</span>
            <LazyInput value={attrString(b.max)} onCommit={(v) => setValue(i, 'max', v)} style={{ width: '90px' }} />
            {b.link && <span class="link-tag" title="Связан с атрибутом анкеты"><Icon name="link" size={13} /> {b.link}</span>}
          </div>
          {(gm || canChar) && (
            <div class="row row-wrap">
              <span class="small muted">Атрибут</span>
              {ch ? (
                <>
                  <input class="input input-sm" list={'attrs-' + o.id} value={b.link || ''} placeholder="hp" onChange={(e) => link(i, e.currentTarget.value.trim())} style={{ width: '150px' }} />
                  <datalist id={'attrs-' + o.id}>
                    {attrNames.map((n) => (
                      <option value={n} />
                    ))}
                  </datalist>
                </>
              ) : (
                <span class="small faint">свяжите токен с анкетой на вкладке «Основное»</span>
              )}
            </div>
          )}
          {gm && (
            <div class="row row-wrap">
              <select class="input input-sm" value={b.visibility || 'all'} onChange={(e) => setBar(i, { visibility: e.currentTarget.value })} aria-label="Кто видит">
                <option value="all">Видят все</option>
                <option value="owners">Видят владельцы</option>
                <option value="gm">Видит только мастер</option>
              </select>
              <select class="input input-sm" value={b.editable || 'owners'} onChange={(e) => setBar(i, { editable: e.currentTarget.value })} aria-label="Кто меняет">
                <option value="owners">Меняют владельцы</option>
                <option value="gm">Меняет только мастер</option>
              </select>
              <select class="input input-sm" value={b.showText || 'inherit'} onChange={(e) => setBar(i, { showText: e.currentTarget.value })} aria-label="Числа">
                <option value="inherit">Числа как в настройках</option>
                <option value="always">Числа всегда</option>
                <option value="hover">Числа при наведении</option>
                <option value="never">Без чисел</option>
              </select>
            </div>
          )}
        </div>
      ))}
      {(gm || o.ownerId === store.me.id) && (
        <div class="row row-wrap">
          <Button size="sm" icon="plus" onClick={() => setBars([...bars, newBar(bars.length, { name: bars.length ? '' : 'HP', color: bars.length ? BAR_COLORS[bars.length % BAR_COLORS.length] : '#d63a3a', link: '' })])}>
            Добавить бар
          </Button>
          {ch && !bars.some((b) => lc(b.link) === 'hp') && store.getAttr(ch.id, 'hp') && (
            <Button
              size="sm"
              onClick={() => {
                const a = store.getAttr(ch.id, 'hp');
                setBars([...bars, newBar(bars.length, { name: 'HP', color: '#d63a3a', link: a.name, value: a.current, max: a.max })]);
              }}
            >
              Бар HP из анкеты
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function MarkersTab({ o }) {
  const app = useApp();
  const { store } = app;
  const defs = markerDefs(store);
  const custom = (store.settings.markers || []).filter((m) => m && m.id);
  const all = [...custom, ...MARKERS.filter((m) => !custom.some((c) => c.id === m.id))];
  const entries = markerEntries(o);
  const cur = () => store.col.obj.get(o.id) || o;
  return (
    <div>
      <div class="marker-grid">
        {all.map((m) => {
          const on = !!markerEntry(o, m.id);
          const desc = describeEffect(m);
          const mine = custom.includes(m);
          return (
            <div class="marker-cell" key={m.id}>
              <button
                type="button"
                class={'marker-btn ' + (on ? 'on' : '')}
                onClick={() => (on ? removeMarker(app, cur(), m.id) : addMarker(app, cur(), m.id))}
                title={m.name + (desc ? ' — ' + desc : '') + (m.note ? '\n' + m.note : '')}
                aria-pressed={on}
              >
                <MarkerLookView look={markerLook(m, defs)} size={20} />
                <span class="mk-name">{m.name}</span>
                {desc && <Icon name="sparkles" size={12} />}
              </button>
              {mine && store.isGM && <IconButton icon="pencil" size={13} class="mk-edit" title={'Изменить маркер «' + m.name + '»'} onClick={() => app.editMarker(m.id)} />}
            </div>
          );
        })}
        {store.isGM && (
          <button
            type="button"
            class="marker-btn mk-new"
            onClick={async () => {
              const id = await app.editMarker(null);
              if (id) addMarker(app, cur(), id);
            }}
          >
            <Icon name="plus" size={16} />
            <span class="mk-name">Свой маркер или эффект</span>
          </button>
        )}
        {store.isGM && (
          <button type="button" class="marker-btn mk-new" onClick={() => app.openEffectLibrary()}>
            <Icon name="sparkles" size={16} />
            <span class="mk-name">Готовые эффекты…</span>
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <div class="marker-nums">
          <p class="small muted">Число на маркере (уровень, стопки) и сколько раундов он ещё длится — пусто, если без срока:</p>
          {entries.map((e) => (
            <MarkerRow key={e.id} o={o} e={e} def={defs.get(e.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MarkerRow({ o, e, def }) {
  const app = useApp();
  const { store } = app;
  const left = roundsLeft(store, e);
  const cur = () => store.col.obj.get(o.id) || o;
  const extra = [e.ends ? (e.ends.when === 'start' ? 'до начала след. хода' : 'до конца след. хода') : '', e.conc ? 'концентрация' : ''].filter(Boolean).join(', ');
  return (
    <div class="row small marker-row">
      <span class="grow">
        {def?.name || e.id}
        {extra && <span class="muted"> — {extra}</span>}
      </span>
      <LazyInput value={e.n ?? ''} placeholder="число" aria-label={'Число на маркере ' + (def?.name || e.id)} onCommit={(v) => setMarkerLevel(app, cur(), e.id, String(v).trim())} style={{ width: '70px' }} />
      <LazyInput value={left === null ? '' : Math.max(0, left)} placeholder="∞" aria-label={'Раундов осталось: ' + (def?.name || e.id)} onCommit={(v) => setMarkerRounds(app, cur(), e.id, String(v).trim())} style={{ width: '60px' }} />
      <IconButton icon="x" size={14} title="Снять" onClick={() => removeMarker(app, cur(), e.id)} />
    </div>
  );
}

/** Поле текста, которое сохраняется при потере фокуса */
function LazyArea({ value, onCommit, ...rest }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value ?? '');
  }, [value]);
  return (
    <textarea
      class="input mono"
      value={v}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        if (v !== (value ?? '')) onCommit(v);
      }}
      onInput={(e) => setV(e.currentTarget.value)}
      {...rest}
    />
  );
}

/** Макросы токена: кнопки над панелью макросов, когда этот токен выделен */
function ActionsTab({ o, upd }) {
  const app = useApp();
  const { store } = app;
  const list = Array.isArray(o.actions) ? o.actions : [];
  const ch = o.represents ? store.col.char.get(o.represents) : null;
  const macros = [...store.col.macro.values()].sort((a, b) => a.name.localeCompare(b.name));
  const set = (nl) => upd({ actions: nl });
  const patch = (i, p) => set(list.map((a, j) => (j === i ? { ...a, ...p } : a)));
  const move = (i, d) => {
    const nl = [...list];
    const j = i + d;
    if (j < 0 || j >= nl.length) return;
    [nl[i], nl[j]] = [nl[j], nl[i]];
    set(nl);
  };
  const run = (a) => app.runMacro(a.action, { selected: [o.id], charId: ch && store.canControlChar(ch) ? ch.id : undefined, as: ch && store.canControlChar(ch) ? { type: 'char', id: ch.id } : undefined });
  return (
    <div class="tok-actions">
      <p class="small muted" style={{ marginTop: 0 }}>
        Кнопки появляются внизу стола, когда этот токен выделен, — у мастера и у тех, кто управляет токеном. В тексте работает всё, что и в макросах: броски [[1d20+5]], запросы ?&#123;…&#125;, @&#123;selected|bar1&#125;, %&#123;персонаж|способность&#125; и #имя-макроса.
        Макрос из коллекции и кнопку броска из листа можно просто перетащить на токен.
      </p>
      {list.map((a, i) => (
        <div class="tok-action" key={a.id}>
          <div class="row">
            <LazyInput value={a.name} placeholder="Подпись кнопки" onCommit={(v) => patch(i, { name: v || 'действие' })} aria-label="Подпись кнопки" />
            <IconButton icon="play" title="Проверить" size={15} onClick={() => run(a)} />
            <IconButton icon="chevUp" title="Выше" size={14} onClick={() => move(i, -1)} />
            <IconButton icon="chevDown" title="Ниже" size={14} onClick={() => move(i, 1)} />
            <IconButton icon="trash" title="Удалить макрос токена" size={15} onClick={() => set(list.filter((_, j) => j !== i))} />
          </div>
          <LazyArea rows={3} value={a.action} placeholder="/em бросает топор: [[1d20+5]]" onCommit={(v) => patch(i, { action: v })} aria-label={'Текст макроса ' + (a.name || '')} />
        </div>
      ))}
      {!list.length && <p class="small faint">У этого токена пока нет своих макросов.</p>}
      <div class="row row-wrap">
        <Button size="sm" icon="plus" onClick={() => set([...list, { id: newId(), name: 'Атака', action: '' }])}>
          Новый макрос
        </Button>
        {macros.length > 0 && (
          <select
            class="input input-sm"
            value=""
            aria-label="Добавить макрос из коллекции"
            onChange={(e) => {
              const m = store.col.macro.get(e.currentTarget.value);
              e.currentTarget.value = '';
              if (m && !list.some((a) => a.action === '#' + m.name)) set([...list, { id: newId(), name: m.name, action: '#' + m.name }]);
            }}
          >
            <option value="">Добавить из коллекции…</option>
            {macros.map((m) => (
              <option value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** На ком едет токен и кого везёт он сам */
function AttachInfo({ o, upd }) {
  const app = useApp();
  const { store, net } = app;
  const carrier = o.attachedTo ? store.col.obj.get(o.attachedTo) : null;
  const riders = store.objsOnPage(o.pageId).filter((r) => r.attachedTo === o.id);
  if (!carrier && !riders.length) return null;
  const nm = (x) => x.name || 'без имени';
  return (
    <div class="attach-box">
      <Icon name="link" size={15} />
      <div class="grow">
        {carrier && (
          <div class="row">
            <span>
              Едет на «{nm(carrier)}» — двигается вместе с ним. Если передвинуть этот токен самому, он отцепится.
            </span>
            <Button size="sm" onClick={() => upd({ attachedTo: '' })}>
              Отцепить
            </Button>
          </div>
        )}
        {riders.length > 0 && (
          <div class="row">
            <span>Везёт: {riders.map(nm).join(', ')}</span>
            <Button size="sm" onClick={() => riders.forEach((r) => store.canControlObj(r) && net.update('obj', r.id, { attachedTo: '' }))}>
              Высадить
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const EFFECTS = [
  ['glow', 'Свечение'],
  ['pulse', 'Пульсация'],
  ['float', 'Парение'],
  ['bob', 'Покачивание'],
  ['spin', 'Вращение'],
  ['shake', 'Дрожь'],
  ['flicker', 'Мерцание'],
  ['ghost', 'Призрачность'],
  ['gray', 'Окаменение (серый)'],
  ['burning', 'Горение'],
  ['frozen', 'Заморозка'],
  ['invisible', 'Невидимость (видят только владельцы и мастер)'],
];

function LookTab({ o, upd, gm }) {
  const fx = o.effects || {};
  const auras = Array.isArray(o.auras) ? o.auras : [];
  const setAura = (i, patch) => upd({ auras: auras.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const { store } = useApp();
  const page = store.page;
  return (
    <div>
      <h4 class="sub-h">Анимации и эффекты</h4>
      <div class="effects-grid">
        {EFFECTS.map(([k, n]) => (
          <Toggle checked={!!fx[k]} onChange={(v) => upd({ effects: { ...fx, [k]: v } })} label={n} />
        ))}
      </div>
      {fx.glow && (
        <div class="row" style={{ marginTop: '6px' }}>
          <span class="small muted">Цвет свечения</span>
          <ColorInput value={fx.glowColor || '#ffd76a'} onChange={(v) => upd({ effects: { ...fx, glowColor: v } })} allowTransparent={false} />
        </div>
      )}
      {o.type === 'image' && (
        <div class="row" style={{ marginTop: '10px' }}>
          <span class="small muted">Оттенок</span>
          <ColorInput value={o.tint} onChange={(v) => upd({ tint: v })} />
        </div>
      )}
      <h4 class="sub-h">Ауры</h4>
      <p class="small muted">Радиус — в единицах сцены ({page?.units || 'фт'}) от края токена.</p>
      {auras.map((a, i) => (
        <div class="row row-wrap aura-row">
          <LazyInput type="number" min="0" value={a.radius} onCommit={(v) => setAura(i, { radius: Number(v) || 0 })} style={{ width: '80px' }} aria-label="Радиус" />
          <ColorInput value={a.color} onChange={(v) => setAura(i, { color: v })} allowTransparent={false} />
          <input type="range" min={0.05} max={0.9} step={0.05} value={a.opacity ?? 0.3} onChange={(e) => setAura(i, { opacity: Number(e.currentTarget.value) })} title="Прозрачность" />
          <Toggle checked={!!a.square} onChange={(v) => setAura(i, { square: v })} label="Квадрат" />
          {gm && <Toggle checked={a.visibleToPlayers !== false} onChange={(v) => setAura(i, { visibleToPlayers: v })} label="Видна игрокам" />}
          <IconButton icon="trash" size={15} title="Убрать ауру" onClick={() => upd({ auras: auras.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => upd({ auras: [...auras, { radius: 10, color: '#ffcc00', opacity: 0.3, square: false, visibleToPlayers: true }] })}>
        Аура
      </Button>
    </div>
  );
}

function LightTab({ o, upd }) {
  const l = o.light || {};
  const v = o.vision || {};
  const { store } = useApp();
  const u = store.page?.units || 'фт';
  const setL = (p) => upd({ light: { ...l, ...p } });
  const setV = (p) => upd({ vision: { ...v, ...p } });
  return (
    <div>
      {!store.page?.lighting?.enabled && <p class="opt-note">Динамический свет на этой сцене выключен — включите его в настройках сцены.</p>}
      <h4 class="sub-h">Зрение</h4>
      <Toggle checked={!!v.enabled} onChange={(x) => setV({ enabled: x })} label="Токен видит (для владельцев)" />
      {store.isGM && <Toggle checked={!!v.shared} onChange={(x) => setV({ shared: x })} label="Общий обзор: глазами токена видят все игроки (союзник, фамильяр, разведчик)" />}
      <div class="grid-2">
        <Field label={`Дальность, ${u} (0 — без ограничения)`}>
          <LazyInput type="number" min="0" value={v.range || 0} onCommit={(x) => setV({ range: Number(x) || 0 })} />
        </Field>
        <Field label={`Тёмное зрение, ${u}`}>
          <LazyInput type="number" min="0" value={v.darkvision || 0} onCommit={(x) => setV({ darkvision: Number(x) || 0 })} />
        </Field>
        <Field label="Угол обзора, °">
          <LazyInput type="number" min="1" max="360" value={v.angle || 360} onCommit={(x) => setV({ angle: Number(x) || 360 })} />
        </Field>
      </div>
      <div class="row row-wrap chips-wrap" style={{ marginTop: '6px' }}>
        {[
          ['Обычное', { enabled: true, darkvision: 0 }],
          ['Тёмное зрение 60', { enabled: true, darkvision: 60 }],
          ['Тёмное зрение 120', { enabled: true, darkvision: 120 }],
        ].map(([n, p]) => (
          <button type="button" class="chip" onClick={() => setV(p)}>
            {n}
          </button>
        ))}
      </div>
      <h4 class="sub-h">Источник света</h4>
      <div class="row row-wrap chips-wrap" style={{ marginBottom: '8px' }}>
        {[
          ['Свеча', { enabled: true, bright: 5, dim: 5, angle: 360, color: '#ffd28a' }],
          ['Факел', { enabled: true, bright: 20, dim: 20, angle: 360, color: '#ffb060' }],
          ['Фонарь', { enabled: true, bright: 30, dim: 30, angle: 360, color: '#ffe0a0' }],
          ['Направленный фонарь', { enabled: true, bright: 60, dim: 60, angle: 60, color: '#ffe6b0' }],
          ['Заклинание «Свет»', { enabled: true, bright: 20, dim: 20, angle: 360, color: '#ffffff' }],
          ['Погасить', { enabled: false }],
        ].map(([n, p]) => (
          <button type="button" class="chip" onClick={() => setL(p)}>
            {n}
          </button>
        ))}
      </div>
      <Toggle checked={!!l.enabled} onChange={(x) => setL({ enabled: x })} label="Излучает свет" />
      <div class="grid-2">
        <Field label={`Яркий свет, ${u}`}>
          <LazyInput type="number" min="0" value={l.bright || 0} onCommit={(x) => setL({ bright: Number(x) || 0 })} />
        </Field>
        <Field label={`Тусклый свет, ${u}`}>
          <LazyInput type="number" min="0" value={l.dim || 0} onCommit={(x) => setL({ dim: Number(x) || 0 })} />
        </Field>
        <Field label="Угол луча, °">
          <LazyInput type="number" min="1" max="360" value={l.angle || 360} onCommit={(x) => setL({ angle: Number(x) || 360 })} />
        </Field>
        <Field label="Яркость">
          <input type="range" min={0.1} max={1} step={0.05} value={l.intensity ?? 1} onChange={(e) => setL({ intensity: Number(e.currentTarget.value) })} />
        </Field>
        <Field label="Цвет света (белый — без оттенка)">
          <ColorInput value={l.color || '#ffffff'} onChange={(v) => setL({ color: v || '#ffffff' })} allowTransparent={false} />
        </Field>
      </div>
    </div>
  );
}

function NotesTab({ o, upd, gm }) {
  const [notes, setNotes] = useState(o.notes || '');
  const [gmn, setGmn] = useState(o.gmnotes || '');
  return (
    <div>
      <Field label="Заметки">
        <textarea class="input" rows={6} value={notes} onInput={(e) => setNotes(e.currentTarget.value)} onBlur={() => notes !== (o.notes || '') && upd({ notes })} />
      </Field>
      {gm && (
        <Field label="Заметки мастера">
          <textarea class="input" rows={6} value={gmn} onInput={(e) => setGmn(e.currentTarget.value)} onBlur={() => gmn !== (o.gmnotes || '') && upd({ gmnotes: gmn })} />
        </Field>
      )}
    </div>
  );
}

function WallSettings({ o, upd }) {
  return (
    <div class="tok-settings" style={{ padding: '14px' }}>
      <Field label="Тип">
        <select class="input input-sm" value={o.wallType || 'wall'} onChange={(e) => upd({ wallType: e.currentTarget.value })}>
          <option value="wall">Стена — закрывает обзор, свет и проход</option>
          <option value="door">Дверь — можно открыть</option>
          <option value="window">Окно — видно насквозь, но не пройти</option>
          <option value="terrain">Невидимая преграда — только проход</option>
        </select>
      </Field>
      {o.wallType === 'door' && (
        <div class="row" style={{ gap: '16px' }}>
          <Toggle checked={!!o.open} onChange={(v) => upd({ open: v })} label="Открыта" />
          <Toggle checked={!!o.locked} onChange={(v) => upd({ locked: v })} label="Заперта (игроки не откроют)" />
        </div>
      )}
      <p class="small muted">Точек: {(o.pts || []).length / 2}. Перетаскивайте точки на слое «Стены и свет».</p>
    </div>
  );
}
