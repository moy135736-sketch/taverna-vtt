import { useState, useEffect } from 'preact/hooks';
import { useApp, useStoreEvents, useLocalStorage } from './hooks.js';
import { useMacroBar } from './panels/CollectionPanel.jsx';
import { openContextMenu, toast } from '../ui/components.jsx';
import { gmOnly } from '@shared/bestiary.js';

const MIME = 'application/x-taverna';

/** Элемент панели: id макроса (строка) или кнопка листа {t:'roll', charId, ref, label} */
function entryKey(e) {
  return typeof e === 'string' ? e : `${e.t}:${e.charId}:${e.ref}`;
}

export function MacroBar() {
  const app = useApp();
  const { store } = app;
  useStoreEvents(store, ['selection', 'col:macro', 'col:char', 'col:obj']);
  const [bar, setBar] = useMacroBar(store);
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  // броски монстров из бестиария — только мастеру (переключатель во вкладке «Статблок»)
  const [sbWhisper] = useLocalStorage('tv:sbwhisper', false);

  // показываем место для сброса, пока что-то тянут из листа или журнала
  useEffect(() => {
    let timer = null;
    const on = (e) => {
      if (!e.dataTransfer?.types?.includes(MIME)) return;
      setDragging(true);
      clearTimeout(timer);
      timer = setTimeout(() => setDragging(false), 400);
    };
    const off = () => {
      clearTimeout(timer);
      setDragging(false);
      setOver(false);
    };
    window.addEventListener('dragover', on, true);
    window.addEventListener('drop', off, true);
    window.addEventListener('dragend', off, true);
    return () => {
      window.removeEventListener('dragover', on, true);
      window.removeEventListener('drop', off, true);
      window.removeEventListener('dragend', off, true);
      clearTimeout(timer);
    };
  }, []);

  const items = bar
    .map((e) => {
      if (typeof e === 'string') {
        const m = store.col.macro.get(e);
        return m ? { key: e, label: m.name, title: m.action, run: () => app.runMacro(m.action, {}) } : null;
      }
      if (e && e.t === 'roll') {
        const ch = store.col.char.get(e.charId);
        if (!ch || !store.canControlChar(ch)) return null;
        return {
          key: entryKey(e),
          label: e.label || e.ref,
          title: `${ch.name}: ${e.label || e.ref}`,
          sub: ch.name,
          run: () => app.runMacro(`%{${ch.id}|${e.ref}}`, { as: { type: 'char', id: ch.id }, charId: ch.id }),
        };
      }
      return null;
    })
    .filter(Boolean);

  const sel = store.selectedObjs().filter((o) => o.type !== 'wall');
  const tok = sel.length === 1 ? sel[0] : null;
  const ch = tok?.represents ? store.col.char.get(tok.represents) : null;
  const tokenAbilities = ch && store.canControlChar(ch) ? (ch.abilities || []).filter((a) => a.istokenaction) : [];
  const tokenMacros = tok ? [...store.col.macro.values()].filter((m) => m.istokenaction) : [];
  const asChar = ch && store.canControlChar(ch) ? { type: 'char', id: ch.id } : undefined;
  // свои макросы токена — у мастера и тех, кто токеном управляет
  const ownActions = tok && store.canControlObj(tok) && Array.isArray(tok.actions) ? tok.actions.filter((a) => a && a.action) : [];
  const hasTokenRow = tokenAbilities.length > 0 || tokenMacros.length > 0 || ownActions.length > 0;

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    setDragging(false);
    let d;
    try {
      d = JSON.parse(e.dataTransfer.getData(MIME) || 'null');
    } catch {
      return;
    }
    if (!d) return;
    let entry = null;
    if (d.kind === 'sheetroll' && d.charId && d.ref) entry = { t: 'roll', charId: d.charId, ref: d.ref, label: d.label || d.ref };
    else if (d.kind === 'macro' && d.id) entry = d.id;
    if (!entry) return toast('Сюда можно перетащить кнопку броска из листа или макрос', 'error');
    const key = entryKey(entry);
    if (bar.some((x) => entryKey(x) === key)) return;
    setBar([...bar, entry]);
  };

  const menu = (ev, key) => {
    ev.preventDefault();
    const i = bar.findIndex((x) => entryKey(x) === key);
    openContextMenu(ev.clientX, ev.clientY, [
      { label: 'Левее', icon: 'chevLeft', disabled: i <= 0, action: () => setBar(move(bar, i, -1)) },
      { label: 'Правее', icon: 'chevRight', disabled: i >= bar.length - 1, action: () => setBar(move(bar, i, 1)) },
      '-',
      { label: 'Убрать с панели', icon: 'x', danger: true, action: () => setBar(bar.filter((x) => entryKey(x) !== key)) },
    ]);
  };

  if (!items.length && !hasTokenRow && !dragging) return null;
  return (
    <footer
      class={'macro-bar' + (dragging ? ' drop-ready' : '') + (over ? ' drop-over' : '')}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes(MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {hasTokenRow && (
        <div class="token-actions" aria-label="Действия токена">
          <span class="ta-name">{tok.name || ch?.name || 'Токен'}</span>
          {ownActions.map((a) => (
            <button type="button" class="mbtn ta own" title={a.action} onClick={() => app.runMacro(a.action, { selected: [tok.id], charId: asChar?.id, as: asChar })}>
              {a.name}
            </button>
          ))}
          {tokenAbilities.map((a) => {
            const hide = sbWhisper && !!ch.statblock;
            return (
              <button type="button" class="mbtn ta" title={hide ? 'Бросок увидит только мастер' : undefined} onClick={() => app.runMacro(hide ? gmOnly(a.action) : a.action, { charId: ch.id, selected: [tok.id] })}>
                {a.name}
              </button>
            );
          })}
          {tokenMacros.map((m) => (
            <button type="button" class="mbtn ta" onClick={() => app.runMacro(m.action, { selected: [tok.id], as: asChar })}>
              {m.name}
            </button>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div class="macro-list" aria-label="Панель макросов">
          {items.map((m) => (
            <button type="button" class="mbtn" onClick={m.run} title={m.title} onContextMenu={(e) => menu(e, m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      )}
      {dragging && <div class="drop-hint">Отпустите здесь, чтобы добавить кнопку на панель</div>}
    </footer>
  );
}

function move(list, i, d) {
  const out = [...list];
  const j = i + d;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
