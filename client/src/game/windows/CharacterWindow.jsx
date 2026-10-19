import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, useStoreEvents, useLocalStorage } from '../hooks.js';
import { FloatingWindow, Tabs, Button, IconButton, Field, Toggle, confirmDialog, toast, showError, Spinner } from '../../ui/components.jsx';
import { Icon } from '../../ui/icons.jsx';
import { SheetView } from '../sheet/view.js';
import { newId } from '@shared/ids.js';
import { lc, attrString } from '@shared/attrs.js';
import { exportRoll20Character } from '../roll20json.js';
import { StatBlock } from '../bestiary/StatBlock.jsx';
import { traitMacro, gmOnly } from '@shared/bestiary.js';

export function CharacterWindow({ winKey, charId, tab: initialTab }) {
  const app = useApp();
  const { store, sheets } = app;
  useStoreEvents(store, ['col:char'], (ev, c, id) => id === charId);
  const ch = store.col.char.get(charId);
  const hasSheet = !!sheets.template;
  // вкладка по умолчанию — лист (у монстра из бестиария — статблок); пока большой лист грузится, окно
  // показывает «Био», а когда он готов, окно пересоздаётся (key с версией листа в GameApp) и открывается уже на листе
  const [tab, setTab] = useState(initialTab || (ch?.statblock ? 'statblock' : hasSheet ? 'sheet' : 'bio'));
  const [zoom, setZoom] = useLocalStorage('tv:sheetzoom', typeof window !== 'undefined' && window.innerWidth < 700 ? 0.6 : 1);
  const viewRef = useRef(null);
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  if (!ch) return null;
  const canEdit = store.canControlChar(ch);
  const zoomBtns = hasSheet && tab === 'sheet' && (
    <span class="sheet-zoom no-drag">
      <IconButton icon="minus" title="Мельче" size={14} onClick={() => setZoom(Math.max(0.4, Math.round((zoom - 0.1) * 10) / 10))} />
      <button type="button" class="zoom-val" title="Масштаб листа — щёлкните для 100%" onClick={() => setZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon="plus" title="Крупнее" size={14} onClick={() => setZoom(Math.min(1.6, Math.round((zoom + 0.1) * 10) / 10))} />
      <IconButton icon="download" title="Печать или PDF" size={14} onClick={() => printSheet(viewRef.current, ch.name)} />
    </span>
  );
  const tabs = [
    ...(ch.statblock ? [{ id: 'statblock', label: 'Статблок' }] : []),
    ...(hasSheet ? [{ id: 'sheet', label: 'Лист' }] : []),
    { id: 'bio', label: 'Био и права' },
    { id: 'attrs', label: 'Атрибуты и способности' },
  ];
  return (
    <FloatingWindow id={'char:' + charId} title={ch.name || 'Персонаж'} onClose={() => app.closeWin(winKey)} width={860} height={720} icon="user" class="char-win" headerExtra={zoomBtns}>
      <div class="char-win-body">
        <Tabs tabs={tabs} value={tab} onChange={setTab} class="char-tabs" />
        <div class="char-tab-body">
          {hasSheet && (
            <div class="char-sheet-host" hidden={tab !== 'sheet'}>
              <SheetHost charId={charId} readOnly={!canEdit} zoom={zoom} viewRef={viewRef} />
            </div>
          )}
          {tab === 'statblock' && ch.statblock && <StatBlockTab ch={ch} canEdit={canEdit} />}
          {tab === 'bio' && <BioTab ch={ch} canEdit={canEdit} />}
          {tab === 'attrs' && <AttrsTab ch={ch} canEdit={canEdit} />}
        </div>
      </div>
    </FloatingWindow>
  );
}

/**
 * Статблок монстра из бестиария. Щелчок по названию действия — бросок в чат от имени монстра
 * (кнопки токена с теми же бросками — на панели над картой, когда токен выделен).
 */
function StatBlockTab({ ch, canEdit }) {
  const app = useApp();
  const { store } = app;
  useStoreEvents(store, ['selection']);
  const [whisper, setWhisper] = useLocalStorage('tv:sbwhisper', false);
  const m = ch.statblock;
  const byRef = new Map((ch.abilities || []).filter((a) => a.ref).map((a) => [a.ref, a]));
  // выделенные на карте токены этого монстра: инициатива — всем сразу (общая для группы), остальное — от первого
  const mine = store.selectedObjs().filter((o) => o.represents === ch.id);
  const run = (text, all = false) => app.runMacro(whisper ? gmOnly(text) : text, { charId: ch.id, selected: (all ? mine : mine.slice(0, 1)).map((o) => o.id) });
  const runRef = (ref, all) => {
    const ab = byRef.get(ref);
    if (!ab) return toast('Этой кнопки у персонажа нет — её удалили во вкладке «Атрибуты и способности»', 'error');
    run(ab.action, all);
  };
  const onEntry = (key, i, e) => {
    const ab = byRef.get(`${key}:${i}`);
    run(ab ? ab.action : traitMacro(e));
  };
  const rollable = (key, i) => /\[\[/.test(byRef.get(`${key}:${i}`)?.action || '');
  const place = async () => {
    const board = app.board();
    if (!board?.page) return toast('Сначала откройте сцену', 'error');
    const c = board.screenToWorld(board.W / 2, board.H / 2);
    const o = await board.tokenFromCharacter(ch.id, c.x, c.y);
    if (o) toast(`${o.name} — на карте`, 'ok');
  };
  return (
    <div class="statblock-tab">
      {canEdit && (
        <div class="sbt-bar">
          <Button size="sm" icon="dice" onClick={() => runRef('init', true)} title="Бросок попадёт в порядок ходов для выделенных токенов этого монстра (один бросок на всех — общая инициатива группы)">
            Инициатива
          </Button>
          <Button size="sm" icon="dice" onClick={() => runRef('save')}>
            Спасбросок
          </Button>
          {store.isGM && (
            <Button size="sm" icon="plus" onClick={place}>
              На карту
            </Button>
          )}
          <span class="grow" />
          <Toggle checked={whisper} onChange={setWhisper} label="Броски видны только мастеру" />
        </div>
      )}
      {canEdit && (
        <p class="small muted sbt-hint">
          {mine.length ? `Выделено токенов на карте: ${mine.length}. ` : ''}Щёлкните название действия — бросок или описание уйдёт в чат от имени «{ch.name}».
        </p>
      )}
      <StatBlock m={m} nameRu={m.nameRu} onEntry={canEdit ? onEntry : undefined} rollable={rollable} />
      {m.source && (
        <p class="small faint sbt-src">
          Источник: {m.source}.{/SRD/i.test(m.source) ? ' Материал System Reference Document 5.2.1 © Wizards of the Coast LLC, лицензия CC BY 4.0.' : ''}
        </p>
      )}
    </div>
  );
}

function SheetHost({ charId, readOnly, zoom = 1, viewRef: outerRef }) {
  const app = useApp();
  const ref = useRef();
  const ownRef = useRef(null);
  const viewRef = outerRef || ownRef;
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    viewRef.current?.setZoom(zoom);
  }, [zoom]);
  useEffect(() => {
    const view = new SheetView(app.sheets, charId, ref.current, { readOnly });
    viewRef.current = view;
    view
      .mount()
      .then(() => {
        view.setZoom(zoom);
        setLoading(false);
      })
      .catch((e) => {
        console.error(e);
        setErr(e.message);
        setLoading(false);
      });
    return () => view.destroy();
  }, [charId, readOnly]);
  return (
    <div class="sheet-host" ref={ref}>
      {loading && <Spinner label="Открываем лист…" />}
      {err && <p class="err">Не удалось открыть лист: {err}</p>}
    </div>
  );
}

/**
 * Печать листа (или «Сохранить как PDF» в диалоге печати): копия листа с текущими значениями полей
 * открывается в новом окне без скриптов.
 */
function printSheet(view, title) {
  const doc = view?.doc;
  if (!doc) return toast('Лист ещё не открыт', 'error');
  const clone = doc.documentElement.cloneNode(true);
  const src = doc.querySelectorAll('input, select, textarea');
  const dst = clone.querySelectorAll('input, select, textarea');
  src.forEach((el, i) => {
    const d = dst[i];
    if (!d) return;
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) d.setAttribute('checked', 'checked');
        else d.removeAttribute('checked');
      } else d.setAttribute('value', el.value);
    } else if (el.tagName === 'SELECT') {
      [...d.options].forEach((o, j) => (j === el.selectedIndex ? o.setAttribute('selected', 'selected') : o.removeAttribute('selected')));
    } else d.textContent = el.value;
  });
  const body = clone.querySelector('body');
  if (body) body.style.zoom = '';
  const style = clone.ownerDocument.createElement('style');
  style.textContent = '@media print { .repcontrol, .repcontrol_add, .repcontrol_edit { display: none !important } } @page { margin: 10mm }';
  clone.querySelector('head')?.appendChild(style);
  const w = window.open('', '_blank');
  if (!w) return toast('Браузер заблокировал новое окно — разрешите всплывающие окна для этого сайта', 'error');
  w.document.open();
  w.document.write('<!doctype html>' + clone.outerHTML);
  w.document.close();
  w.document.title = (title || 'Персонаж') + ' — лист персонажа';
  // даём загрузиться картинкам и шрифтам
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* окно закрыто */
    }
  }, 700);
}

// ---------------------------------------------------------------------------

function BioTab({ ch, canEdit }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['members', 'selection']);
  const gm = store.isGM;
  const [name, setName] = useState(ch.name);
  const [bio, setBio] = useState(ch.bio || '');
  const [gmnotes, setGmnotes] = useState(ch.gmnotes || '');
  useEffect(() => {
    setName(ch.name);
  }, [ch.name]);
  const upd = (patch) => net.update('char', ch.id, patch).then((r) => r?.error && toast(r.error, 'error'));
  const players = [...store.members.values()].filter((m) => m.role !== 'gm');

  const togglePerm = (field, uid) => {
    const cur = new Set(ch[field] || []);
    if (cur.has(uid)) cur.delete(uid);
    else cur.add(uid);
    upd({ [field]: [...cur] });
  };

  const uploadAvatar = async (e) => {
    const f = e.currentTarget.files[0];
    if (!f) return;
    const a = await app.upload([f], 'аватары');
    if (a[0]) upd({ avatar: a[0].url });
  };
  const fileRef = useRef();

  const setDefaultFromSelected = async () => {
    const sel = store.selectedObjs().filter((o) => o.represents === ch.id || !o.represents);
    if (sel.length !== 1) return toast('Выделите на карте один токен этого персонажа', 'error');
    const t = JSON.parse(JSON.stringify(sel[0]));
    for (const k of ['id', 'pageId', 'x', 'y', 'z', 'ownerId', 'layer', 'locked', 'attachedTo']) delete t[k];
    t.represents = ch.id;
    await upd({ defaultToken: t });
    if (!sel[0].represents) net.update('obj', sel[0].id, { represents: ch.id });
    toast('Токен по умолчанию сохранён', 'ok');
  };

  return (
    <div class="bio-tab">
      <div class="bio-top">
        <div class="bio-avatar">
          {ch.avatar ? <img src={ch.avatar} alt="" /> : <Icon name="user" size={48} stroke={1.2} />}
          {canEdit && (
            <>
              <input type="file" accept="image/*" hidden ref={fileRef} onChange={uploadAvatar} />
              <Button size="sm" onClick={() => fileRef.current.click()}>
                Сменить
              </Button>
            </>
          )}
        </div>
        <div class="grow">
          <Field label="Имя">
            <input class="input" value={name} disabled={!canEdit} onInput={(e) => setName(e.currentTarget.value)} onBlur={() => name !== ch.name && upd({ name })} />
          </Field>
          <Field label="ID персонажа" hint="Используется в макросах: @{ID|атрибут}">
            <div class="row">
              <code class="id-pill">{ch.id}</code>
              <IconButton icon="copy" title="Копировать ID" onClick={() => navigator.clipboard?.writeText(ch.id).then(() => toast('ID скопирован', 'ok'))} />
            </div>
          </Field>
        </div>
      </div>
      <Field label="Биография">
        <textarea class="input" rows={8} value={bio} disabled={!canEdit} onInput={(e) => setBio(e.currentTarget.value)} onBlur={() => bio !== (ch.bio || '') && upd({ bio })} />
      </Field>
      {gm && (
        <Field label="Заметки мастера (игроки не видят)">
          <textarea class="input" rows={4} value={gmnotes} onInput={(e) => setGmnotes(e.currentTarget.value)} onBlur={() => gmnotes !== (ch.gmnotes || '') && upd({ gmnotes })} />
        </Field>
      )}
      {gm && (
        <div class="perm-grid">
          <div>
            <h4>Видят в журнале</h4>
            <Toggle checked={(ch.inJournals || []).includes('all')} onChange={() => togglePerm('inJournals', 'all')} label="Все игроки" />
            {players.map((m) => (
              <Toggle checked={(ch.inJournals || []).includes(m.id)} onChange={() => togglePerm('inJournals', m.id)} label={m.displayName} />
            ))}
          </div>
          <div>
            <h4>Управляют (лист и токены)</h4>
            <Toggle checked={(ch.controlledBy || []).includes('all')} onChange={() => togglePerm('controlledBy', 'all')} label="Все игроки" />
            {players.map((m) => (
              <Toggle checked={(ch.controlledBy || []).includes(m.id)} onChange={() => togglePerm('controlledBy', m.id)} label={m.displayName} />
            ))}
          </div>
        </div>
      )}
      {canEdit && (
        <div class="default-token">
          <h4>Токен по умолчанию</h4>
          <p class="small muted">
            {ch.defaultToken ? 'Задан. Перетащите персонажа из журнала на карту — появится такой токен.' : 'Не задан: при перетаскивании будет токен с аватаром и баром HP (если у листа есть атрибут hp).'}
          </p>
          <div class="row row-wrap">
            <Button size="sm" onClick={setDefaultFromSelected}>
              Взять с выделенного токена
            </Button>
            {ch.defaultToken && (
              <Button size="sm" kind="ghost" onClick={() => upd({ defaultToken: null })}>
                Сбросить
              </Button>
            )}
            <Button size="sm" icon="download" onClick={() => exportRoll20Character(app, ch.id).catch(showError)}>
              Экспорт JSON
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AttrsTab({ ch, canEdit }) {
  const app = useApp();
  const { store, net, sheets } = app;
  const [loaded, setLoaded] = useState(!!store.attrMap(ch.id));
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(200);
  useStoreEvents(store, ['attrs'], (ev, cid) => cid === ch.id);
  useEffect(() => {
    net.ensureAttrs(ch.id)
      .then(() => setLoaded(true))
      .catch(showError);
  }, [ch.id]);
  const m = store.attrMap(ch.id);
  const list = m ? [...m.values()].filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)) : [];

  const setVal = (a, field, value) => sheets.setAttrs(ch.id, { [field === 'max' ? a.name + '_max' : a.name]: value }, { source: 'player' });
  const addAttr = () => {
    let i = 1;
    while (store.getAttr(ch.id, 'new_attr_' + i)) i++;
    sheets.setAttrs(ch.id, { ['new_attr_' + i]: '' }, { source: 'player' });
    setQ('new_attr_' + i);
  };
  const rename = (a, nn) => {
    nn = nn.trim();
    if (!nn || nn === a.name) return;
    if (store.getAttr(ch.id, nn)) return toast('Такой атрибут уже есть', 'error');
    net.setAttrs(ch.id, [{ name: nn, current: a.current, max: a.max }], [a.name]);
  };
  const del = (a) => net.setAttrs(ch.id, [], [a.name]);

  const abilities = ch.abilities || [];
  const updAbilities = (list) => net.update('char', ch.id, { abilities: list });

  return (
    <div class="attrs-tab">
      <section class="abilities">
        <div class="sect-head">
          <h3>Способности</h3>
          {canEdit && (
            <Button size="sm" icon="plus" onClick={() => updAbilities([...abilities, { id: newId(), name: 'новая', action: '', istokenaction: false }])}>
              Способность
            </Button>
          )}
        </div>
        {!abilities.length && <p class="empty small">Способности — макросы персонажа. Вызываются %&#123;{ch.name}|имя&#125; или кнопкой токена.</p>}
        {abilities.map((ab, i) => (
          <div class="ability-row">
            <div class="row">
              <button type="button" class="run-btn" title="Выполнить" onClick={() => app.runMacro(ab.action, { charId: ch.id })}>
                <Icon name="play" size={14} />
              </button>
              <input class="input input-sm grow" value={ab.name} disabled={!canEdit} onChange={(e) => updAbilities(abilities.map((x, j) => (j === i ? { ...x, name: e.currentTarget.value.trim() || x.name } : x)))} aria-label="Название" />
              <Toggle checked={ab.istokenaction} disabled={!canEdit} onChange={(v) => updAbilities(abilities.map((x, j) => (j === i ? { ...x, istokenaction: v } : x)))} label="Кнопка токена" />
              {canEdit && <IconButton icon="trash" title="Удалить" size={15} onClick={async () => (await confirmDialog({ title: 'Удалить способность?', text: ab.name, okText: 'Удалить', danger: true })) && updAbilities(abilities.filter((_, j) => j !== i))} />}
            </div>
            <textarea class="input mono" rows={2} value={ab.action} disabled={!canEdit} onChange={(e) => updAbilities(abilities.map((x, j) => (j === i ? { ...x, action: e.currentTarget.value } : x)))} aria-label="Макрос" />
          </div>
        ))}
      </section>
      <section>
        <div class="sect-head">
          <h3>Атрибуты {m && <span class="faint small">{m.size}</span>}</h3>
          <div class="row">
            <input class="input input-sm" placeholder="Фильтр" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ width: '160px' }} aria-label="Фильтр атрибутов" />
            {canEdit && (
              <Button size="sm" icon="plus" onClick={addAttr}>
                Атрибут
              </Button>
            )}
          </div>
        </div>
        {!loaded ? (
          <Spinner />
        ) : (
          <table class="plain attr-table">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Текущее</th>
                <th>Максимум</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.slice(0, limit).map((a) => (
                <tr key={a.name}>
                  <td>
                    <input class="input input-sm mono" value={a.name} disabled={!canEdit} onChange={(e) => rename(a, e.currentTarget.value)} />
                  </td>
                  <td>
                    <input class="input input-sm" value={attrString(a.current)} disabled={!canEdit} onChange={(e) => setVal(a, 'current', e.currentTarget.value)} />
                  </td>
                  <td>
                    <input class="input input-sm" value={attrString(a.max)} disabled={!canEdit} onChange={(e) => setVal(a, 'max', e.currentTarget.value)} />
                  </td>
                  <td>{canEdit && <IconButton icon="trash" title="Удалить атрибут" size={14} onClick={() => del(a)} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.length > limit && (
          <Button size="sm" kind="ghost" onClick={() => setLimit(limit + 500)}>
            Показать ещё ({list.length - limit})
          </Button>
        )}
      </section>
    </div>
  );
}
