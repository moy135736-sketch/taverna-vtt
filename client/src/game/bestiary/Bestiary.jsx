// Бестиарий мастера: монстры SRD 5.2.1 (встроены) и загруженные по ссылке с GitHub или из файла.
// Монстр → персонаж в журнале (папка «Монстры»: статблок, атрибуты, кнопки токена) → токены на карте.
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { useApp, useStoreEvents } from '../hooks.js';
import { Modal, Button, Toggle, toast, showError } from '../../ui/components.jsx';
import { Icon } from '../../ui/icons.jsx';
import { newId } from '@shared/ids.js';
import { api } from '../../api.js';
import { parseBestiary, monsterCharacter, monsterAttrs, crValue, SIZES, typeKey, githubRawUrls, uniqueIds, SRD_ATTRIBUTION } from '@shared/bestiary.js';
import { nameRu, TYPES_RU, SIZES_RU } from './namesRu.js';
import { StatBlock } from './StatBlock.jsx';
import './bestiary.css';

const SRD_SOURCE = 'SRD 5.2.1';
// ссылки мастера: JSON с монстрами SRD 5.2.1 в gist и Markdown-версия SRD
export const GIST_URL = 'https://gist.github.com/krisimmig/f4b7d2a30cadd2d94107f5533ba9c85c';
export const SRD_MD_URL = 'https://github.com/downfallx/dnd-5e-srd-markdown';

let srdPromise = null;
/** Встроенный бестиарий (грузится один раз, когда его впервые открыли) */
export function loadSrd() {
  if (!srdPromise)
    srdPromise = fetch('/srd/monsters.json')
      .then((r) => {
        if (!r.ok) throw new Error('Бестиарий не загрузился');
        return r.json();
      })
      .then((d) => d.monsters || [])
      .catch((e) => {
        srdPromise = null;
        throw e;
      });
  return srdPromise;
}

/** Текст файла: браузер забирает сам, а если не смог (сеть, политика браузера) — через сервер стола */
export async function fetchText(u) {
  let r;
  try {
    r = await fetch(u, { credentials: 'omit' });
  } catch {
    return (await api.post('/api/bestiary/fetch', { url: u })).text;
  }
  if (!r.ok) throw new Error(r.status === 404 ? 'на GitHub нет такого файла (404)' : `GitHub ответил ${r.status}`);
  return r.text();
}

const byName = (list) => list.sort((a, b) => a.name.localeCompare(b.name, 'en'));

const CR_RANGES = [
  ['', 'Любая опасность'],
  ['0-1', 'CR 0–1'],
  ['2-4', 'CR 2–4'],
  ['5-10', 'CR 5–10'],
  ['11-16', 'CR 11–16'],
  ['17-30', 'CR 17+'],
];

/** Персонаж монстра в журнале: уже есть — его, нет — создаём со статблоком, атрибутами и кнопками токена */
export async function ensureMonsterCharacter(app, m, source) {
  const { store, net } = app;
  const found = [...store.col.char.values()].find((c) => !c.archived && c.statblock?.id === m.id && (c.statblock?.source || SRD_SOURCE) === source);
  if (found) return found.id;
  const id = newId();
  const ch = monsterCharacter(m, newId, { source, nameRu: nameRu(m.name) });
  const r = await net.create('char', { id, ...ch, controlledBy: [], inJournals: [] });
  if (r?.error) throw new Error(r.error);
  const set = monsterAttrs(m);
  const res = await net.request('attrs:set', { charId: id, set, o: net.origin });
  if (res?.error) throw new Error(res.error);
  // лист стола пересчитывает своё (модификаторы, спасброски, навыки) — как при первом открытии листа
  if (app.sheets?.ready)
    try {
      await app.sheets.ensure(id);
      app.sheets.sheetOpened(id);
    } catch {
      /* лист пересчитает, когда его откроют */
    }
  return id;
}

/** Поставить count токенов монстра в середину того, что видит мастер (рядами), на слой объектов или мастера */
export async function placeMonsters(app, m, source, count = 1, hidden = false) {
  const { store } = app;
  const board = app.board();
  if (!board || !store.page) throw new Error('Нет сцены, куда поставить');
  const id = await ensureMonsterCharacter(app, m, source);
  const cs = store.page.cellSize || 70;
  const size = (SIZES[m.size] || 1) * cs;
  const c = board.screenToWorld(board.W / 2, board.H / 2);
  const per = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / per);
  // между токенами — клетка, чтобы не слипались подписи
  const step = Math.max(size, cs) + cs;
  const made = [];
  for (let i = 0; i < count; i++) {
    const col = i % per;
    const row = Math.floor(i / per);
    const x = c.x + (col - (per - 1) / 2) * step;
    const y = c.y + (row - (rows - 1) / 2) * step;
    const o = await board.tokenFromCharacter(id, x, y, { layer: hidden ? 'gm' : 'objects', select: false });
    if (o) made.push(o.id);
  }
  if (made.length) store.setSelection(made);
  return made;
}

export function Bestiary({ onClose }) {
  const app = useApp();
  const { store } = app;
  useStoreEvents(store, ['col:char']);
  const [srd, setSrd] = useState(null);
  const [srdError, setSrdError] = useState('');
  const [sets, setSets] = useState([]); // загруженные: [{title, monsters}]
  const [src, setSrc] = useState('srd');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [cr, setCr] = useState('');
  const [sel, setSel] = useState(null);
  const [count, setCount] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState(GIST_URL);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef();
  const listRef = useRef();
  const previewRef = useRef();

  useEffect(() => {
    loadSrd()
      .then(setSrd)
      .catch((e) => setSrdError(e.message));
  }, []);

  const current = useMemo(() => (src === 'srd' ? { title: SRD_SOURCE, monsters: srd || [] } : sets.find((s) => s.title === src) || { title: src, monsters: [] }), [src, srd, sets]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const [lo, hi] = cr ? cr.split('-').map(Number) : [null, null];
    return current.monsters.filter((m) => {
      if (type && typeKey(m.type) !== type) return false;
      if (cr) {
        const v = crValue(m.cr);
        if (v < lo || v > hi) return false;
      }
      if (!needle) return true;
      return m.name.toLowerCase().includes(needle) || nameRu(m.name).toLowerCase().includes(needle) || (TYPES_RU[typeKey(m.type)] || '').toLowerCase().includes(needle);
    });
  }, [current, q, type, cr]);
  const types = useMemo(() => [...new Set(current.monsters.map((m) => typeKey(m.type)).filter(Boolean))].sort((a, b) => (TYPES_RU[a] || a).localeCompare(TYPES_RU[b] || b, 'ru')), [current]);
  const m = list.find((x) => x.id === sel) || list[0] || null;
  // другой монстр — статблок с начала
  useEffect(() => {
    if (previewRef.current) previewRef.current.scrollTop = 0;
  }, [m?.id, current]);
  const existing = m && [...store.col.char.values()].find((c) => !c.archived && c.statblock?.id === m.id && (c.statblock?.source || SRD_SOURCE) === current.title);

  const loadUrl = async () => {
    setLoading(true);
    try {
      const all = [];
      let lastErr = null;
      for (const u of githubRawUrls(url)) {
        try {
          all.push(...parseBestiary(await fetchText(u)));
        } catch (e) {
          lastErr = e;
        }
      }
      if (!all.length) throw lastErr || new Error('в файле не нашлось монстров');
      const monsters = byName(uniqueIds(all));
      const title = (/gist/.test(url) ? 'Gist: ' : 'GitHub: ') + url.replace(/^https?:\/\/(gist\.)?github(usercontent)?\.com\//, '').slice(0, 60);
      setSets((ss) => [...ss.filter((s) => s.title !== title), { title, monsters }]);
      setSrc(title);
      setSel(null);
      setUrlOpen(false);
      toast(`Загружено монстров: ${monsters.length}`, 'ok');
    } catch (e) {
      toast(`Не удалось загрузить: ${e.message}. Подходят ссылки на gist.github.com, github.com и raw.githubusercontent.com — файл JSON с монстрами или Markdown SRD.`, 'error', 9000);
    } finally {
      setLoading(false);
    }
  };
  const loadFile = async (e) => {
    const files = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    for (const f of files) {
      try {
        const monsters = byName(parseBestiary(await f.text()));
        if (!monsters.length) throw new Error('в файле не нашлось монстров');
        const title = 'Файл: ' + f.name;
        setSets((ss) => [...ss.filter((s) => s.title !== title), { title, monsters }]);
        setSrc(title);
        setSel(null);
        toast(`Загружено монстров: ${monsters.length}`, 'ok');
      } catch (err) {
        toast(`«${f.name}»: ${err.message}`, 'error', 7000);
      }
    }
  };

  const toJournal = async () => {
    if (!m) return;
    setBusy(true);
    try {
      const id = await ensureMonsterCharacter(app, m, current.title);
      toast(existing ? `«${m.name}» уже в журнале` : `«${m.name}» — в журнале, папка «Монстры»`, 'ok');
      app.openCharacter(id, 'statblock');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const toMap = async () => {
    if (!m) return;
    setBusy(true);
    try {
      const n = Math.max(1, Math.min(20, Math.floor(Number(count) || 1)));
      const made = await placeMonsters(app, m, current.title, n, hidden);
      toast(`${m.name}${n > 1 ? ' ×' + n : ''} — на карте${hidden ? ' (слой мастера)' : ''}`, 'ok');
      if (made.length) onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  // стрелки в поиске — по списку
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!busy) toMap();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = Math.max(0, list.findIndex((x) => x.id === m?.id));
    const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      setSel(next.id);
      listRef.current?.querySelector(`[data-mid="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  return (
    <Modal title="Бестиарий" onClose={onClose} width={1040} class="bestiary-modal">
      <div class="bst">
        <div class="bst-bar">
          <label class="bst-search">
            <Icon name="search" size={15} />
            <input class="input" value={q} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Гоблин, dragon, нежить…" aria-label="Поиск монстра" autoFocus />
          </label>
          <select class="input" value={type} onChange={(e) => setType(e.currentTarget.value)} aria-label="Тип существа">
            <option value="">Все типы</option>
            {types.map((t) => (
              <option value={t}>{TYPES_RU[t] || t}</option>
            ))}
          </select>
          <select class="input" value={cr} onChange={(e) => setCr(e.currentTarget.value)} aria-label="Опасность">
            {CR_RANGES.map(([v, n]) => (
              <option value={v}>{n}</option>
            ))}
          </select>
          <select class="input bst-src" value={src} onChange={(e) => (setSrc(e.currentTarget.value), setSel(null))} aria-label="Источник">
            <option value="srd">SRD 5.2.1{srd ? ` (${srd.length})` : ''}</option>
            {sets.map((s) => (
              <option value={s.title}>
                {s.title} ({s.monsters.length})
              </option>
            ))}
          </select>
          <Button size="sm" icon="link" onClick={() => setUrlOpen(!urlOpen)} aria-expanded={urlOpen}>
            По ссылке
          </Button>
          <Button size="sm" icon="upload" onClick={() => fileRef.current?.click()} title="JSON с монстрами (как в Open5e) или Markdown SRD">
            Из файла
          </Button>
          <input type="file" accept=".json,.md,.markdown,.txt" multiple hidden ref={fileRef} onChange={loadFile} />
        </div>
        {urlOpen && (
          <form
            class="bst-url"
            onSubmit={(e) => {
              e.preventDefault();
              loadUrl();
            }}
          >
            <input class="input grow" value={url} onInput={(e) => setUrl(e.currentTarget.value)} aria-label="Ссылка на монстров" placeholder="https://gist.github.com/… или https://github.com/…" />
            <Button size="sm" kind="primary" type="submit" disabled={loading || !url.trim()}>
              {loading ? 'Загружаю…' : 'Загрузить'}
            </Button>
            <p class="small muted">
              Прямо с GitHub: gist с JSON монстров (как{' '}
              <button type="button" class="link-btn" onClick={() => setUrl(GIST_URL)}>
                этот
              </button>
              ), Markdown SRD (
              <button type="button" class="link-btn" onClick={() => setUrl(SRD_MD_URL)}>
                репозиторий
              </button>
              ) или ссылка на файл .json / .md.
            </p>
          </form>
        )}
        <div class="bst-main">
          <ul class="bst-list" ref={listRef} role="listbox" aria-label="Монстры">
            {src === 'srd' && !srd && <li class="bst-empty">{srdError || 'Загружаю бестиарий…'}</li>}
            {current.monsters.length > 0 && !list.length && <li class="bst-empty">Никого не нашлось — попробуйте по-английски или уберите фильтры.</li>}
            {list.map((x) => {
              const ru = nameRu(x.name);
              return (
                <li role="option" aria-selected={x.id === m?.id} data-mid={x.id} class={'bst-item' + (x.id === m?.id ? ' on' : '')} onClick={() => setSel(x.id)} onDblClick={() => (setSel(x.id), toMap())}>
                  <span class="bst-name">
                    {x.name}
                    <span class="bst-sub">
                      {ru ? ru + ' — ' : ''}
                      {TYPES_RU[typeKey(x.type)] || x.type}, {(SIZES_RU[x.size] || x.size).toLowerCase()}
                    </span>
                  </span>
                  <span class="bst-cr" title="Уровень опасности">
                    {x.cr}
                  </span>
                </li>
              );
            })}
          </ul>
          <div class="bst-preview" ref={previewRef}>{m ? <StatBlock m={m} nameRu={nameRu(m.name)} /> : <p class="muted">Выберите монстра слева.</p>}</div>
        </div>
        <div class="bst-foot">
          <label class="bst-count">
            Сколько
            <input class="input input-sm" type="number" min={1} max={20} value={count} onInput={(e) => setCount(e.currentTarget.value)} />
          </label>
          <Toggle checked={hidden} onChange={setHidden} label="Спрятать на слое мастера" />
          <span class="grow small muted">{existing ? 'Уже в журнале — новые токены возьмут его.' : ''}</span>
          <Button onClick={toJournal} disabled={!m || busy}>
            В журнал
          </Button>
          <Button kind="primary" icon="plus" onClick={toMap} disabled={!m || busy}>
            На карту
          </Button>
        </div>
        <p class="bst-credit">{SRD_ATTRIBUTION}</p>
      </div>
    </Modal>
  );
}
