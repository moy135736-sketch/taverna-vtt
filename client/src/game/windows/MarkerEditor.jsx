// Свой маркер-эффект: значок, другие названия, длительность (раунды, минуты, часы, до следующего хода),
// концентрация, что меняет (атрибуты листа, полосы, сам токен — числом или формулой) и что делает каждый ход
import { useState, useRef } from 'preact/hooks';
import { useApp } from '../hooks.js';
import { Modal, Field, Button, IconButton, confirmDialog, toast } from '../../ui/components.jsx';
import { MARKERS } from '@shared/defaults.js';
import { TOKEN_KEYS } from '@shared/effects.js';
import { newId } from '@shared/ids.js';
import { CHANGE_MODES, markerDefs, markerLook, markerEntry, removeMarker } from '../effects.js';

export function MarkerLookView({ look, size = 28 }) {
  return (
    <span class={'mk-look' + (look.color ? ' dot' : '')} style={{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.62) + 'px', ...(look.color ? { background: look.color } : null) }}>
      {look.image ? <img src={look.image} alt="" draggable={false} /> : look.color ? null : look.emoji}
    </span>
  );
}

// Длительность: в раундах (минута — 10 раундов, час — 600) или до начала/конца следующего хода цели
const DURATIONS = [
  ['none', 'Пока не снимут'],
  ['r', 'Раунды'],
  ['min', 'Минуты'],
  ['h', 'Часы'],
  ['turnStart', 'До начала следующего хода цели'],
  ['turnEnd', 'До конца следующего хода цели'],
];
const MULT = { r: 1, min: 10, h: 600 };
const MAX_ROUNDS = 14400; // сутки

function durationOf(def) {
  if (def?.duration === 'turnStart' || def?.duration === 'turnEnd') return { kind: def.duration, n: '' };
  const r = Math.floor(Number(def?.rounds) || 0);
  if (r <= 0) return { kind: 'none', n: '' };
  if (r % 600 === 0) return { kind: 'h', n: String(r / 600) };
  if (r % 10 === 0) return { kind: 'min', n: String(r / 10) };
  return { kind: 'r', n: String(r) };
}

// Подсказки к полю «что меняет»: сам токен, полосы и поля листа «D&D 2024» Таверны
const KEY_HINTS = [
  ...Object.entries(TOKEN_KEYS).map(([k, d]) => [k, 'токен: ' + d.label]),
  ['bar1', 'полоса 1 токена'],
  ['bar2', 'полоса 2 токена'],
  ['bar3', 'полоса 3 токена'],
  ['ac', 'КД (лист D&D 2024)'],
  ['speed', 'скорость (D&D 2024)'],
  ['hp_temp', 'временные хиты (D&D 2024)'],
  ['global_attack', 'к броскам атаки, можно 1d4 (D&D 2024)'],
  ['global_save', 'к спасброскам, можно 1d4 (D&D 2024)'],
  ['global_damage', 'к урону, можно 1d4 (D&D 2024)'],
  ['global_check', 'к проверкам, можно 1d4 (D&D 2024)'],
];

function turnOf(def) {
  const t = def?.turn || {};
  const hp = String(t.hp || '').trim();
  return {
    when: t.when === 'end' ? 'end' : t.when === 'start' || hp || t.save?.roll || t.text ? 'start' : 'none',
    hpKind: /^\+/.test(hp) ? 'heal' : 'dmg',
    hp: hp.replace(/^[+-]\s*/, ''),
    save: String(t.save?.roll || ''),
    dc: t.save?.dc ? String(t.save.dc) : '',
    text: String(t.text || ''),
  };
}

export function MarkerEditor({ id, onClose }) {
  const app = useApp();
  const { store, net } = app;
  const list = store.settings.markers || [];
  const cur = id ? list.find((m) => m.id === id) : null;
  const [f, setF] = useState(() => {
    const d = durationOf(cur);
    return {
      name: cur?.name || '',
      alias: cur?.alias || '',
      image: cur?.image || '',
      icon: cur?.icon || (cur ? '' : 'star'),
      emoji: cur?.image || cur?.icon ? '' : cur?.emoji || '',
      durKind: d.kind,
      durN: d.n,
      conc: !!cur?.conc,
      note: cur?.note || '',
      changes: (cur?.changes || []).map((c) => ({ ...c, _k: newId() })),
      turn: turnOf(cur),
    };
  });
  const fileRef = useRef();
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const setChange = (i, p) => set({ changes: f.changes.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const setTurn = (p) => set({ turn: { ...f.turn, ...p } });
  const defs = markerDefs(store);
  const look = markerLook({ image: f.image, icon: f.icon, emoji: f.emoji || undefined, color: !f.image && !f.icon && !f.emoji ? cur?.color : undefined }, defs);
  const listId = 'mk-keys-' + (cur?.id || 'new');

  const upload = async (e) => {
    const file = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    const a = await app.upload([file], 'маркеры');
    if (a[0]) set({ image: a[0].url, icon: '', emoji: '' });
  };

  const save = async () => {
    const name = f.name.trim().slice(0, 40);
    if (!name) return toast('Дайте маркеру название', 'error');
    const def = { id: cur?.id || 'm-' + newId().slice(-10), name };
    const alias = f.alias.trim().slice(0, 120);
    if (alias) def.alias = alias;
    if (f.image) def.image = f.image;
    else if (f.emoji.trim()) def.emoji = [...f.emoji.trim()].slice(0, 4).join('');
    else if (f.icon) def.icon = f.icon;
    else if (cur?.color) def.color = cur.color;
    else def.icon = 'star';
    if (f.durKind === 'turnStart' || f.durKind === 'turnEnd') def.duration = f.durKind;
    else if (MULT[f.durKind]) {
      const r = Math.floor((Number(String(f.durN).replace(',', '.')) || 0) * MULT[f.durKind]);
      if (r > 0) def.rounds = Math.min(MAX_ROUNDS, r);
    }
    if (f.conc) def.conc = true;
    if (f.note.trim()) def.note = f.note.trim().slice(0, 600);
    const changes = f.changes
      .filter((c) => String(c.key || '').trim())
      .slice(0, 12)
      .map((c) => ({ key: String(c.key).trim().slice(0, 80), mode: c.mode || 'add', value: String(c.value ?? '').trim().slice(0, 80), ...(c.perLevel ? { perLevel: true } : {}) }));
    if (changes.length) def.changes = changes;
    const t = f.turn;
    if (t.when !== 'none') {
      const turn = { when: t.when };
      if (t.hp.trim()) turn.hp = (t.hpKind === 'heal' ? '+' : '-') + t.hp.trim().replace(/^[+-]\s*/, '').slice(0, 60);
      if (t.save.trim()) turn.save = { roll: t.save.trim().slice(0, 80), dc: Math.min(40, Math.max(1, Math.floor(Number(t.dc) || 10))) };
      if (t.text.trim()) turn.text = t.text.trim().slice(0, 200);
      if (turn.hp || turn.save || turn.text) def.turn = turn;
    }
    const next = cur ? list.map((m) => (m.id === cur.id ? def : m)) : [...list, def];
    const r = await net.request('settings', { markers: next });
    if (r?.error) return toast(r.error, 'error');
    toast(cur ? `Маркер «${name}» сохранён` : `Маркер «${name}» добавлен`, 'ok');
    onClose(def.id);
  };

  const remove = async () => {
    const on = [...store.col.obj.values()].filter((o) => markerEntry(o, cur.id));
    const ok = await confirmDialog({
      title: 'Удалить маркер?',
      text: on.length ? `«${cur.name}» стоит на токенах (${on.length}) — он снимется с них, изменения листов откатятся.` : `«${cur.name}» пропадёт из списка маркеров.`,
      okText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    for (const o of on) await removeMarker(app, o, cur.id);
    const r = await net.request('settings', { markers: list.filter((m) => m.id !== cur.id) });
    if (r?.error) return toast(r.error, 'error');
    onClose(null);
  };

  const timed = !!MULT[f.durKind];
  const t = f.turn;

  return (
    <Modal title={cur ? 'Маркер и его эффект' : 'Новый маркер'} onClose={() => onClose(null)} width={660} class="marker-editor">
      <div class="mk-head">
        <MarkerLookView look={look} size={44} />
        <Field label="Название">
          <input class="input" value={f.name} maxLength={40} placeholder="Например: Яд василиска" onInput={(e) => set({ name: e.currentTarget.value })} autoFocus />
        </Field>
      </div>
      <Field label="Другие названия" hint="Через запятую. Когда в чат бросают заклинание или приём с таким названием, под броском появится кнопка «Наложить».">
        <input class="input" value={f.alias} maxLength={120} placeholder="Например: Bless, Благословение" onInput={(e) => set({ alias: e.currentTarget.value })} />
      </Field>

      <Field label="Значок">
        <div class="row row-wrap">
          <input type="file" accept="image/*" hidden ref={fileRef} onChange={upload} />
          <Button size="sm" icon="upload" onClick={() => fileRef.current.click()}>
            Своя картинка…
          </Button>
          {f.image && (
            <Button size="sm" kind="ghost" onClick={() => set({ image: '', icon: f.icon || (f.emoji ? '' : 'star') })}>
              Убрать картинку
            </Button>
          )}
          <span class="small muted">или символ</span>
          <input
            class="input input-sm mk-emoji"
            value={f.emoji}
            maxLength={8}
            placeholder="✦"
            aria-label="Свой символ (эмодзи)"
            onInput={(e) => {
              const v = e.currentTarget.value;
              set(v.trim() ? { emoji: v, icon: '', image: '' } : { emoji: '', icon: f.image ? '' : 'star' });
            }}
          />
          <span class="small muted">или значок:</span>
        </div>
      </Field>
      <div class="mk-icons" role="listbox" aria-label="Значок маркера">
        {MARKERS.filter((m) => m.id !== 'dead').map((m) => (
          <button type="button" role="option" aria-selected={!f.image && !f.emoji && f.icon === m.id} class={'mk-icon ' + (!f.image && !f.emoji && f.icon === m.id ? 'on' : '')} title={m.name} onClick={() => set({ icon: m.id, image: '', emoji: '' })}>
            <MarkerLookView look={markerLook(m, defs)} size={22} />
          </button>
        ))}
      </div>

      <h4 class="sub-h">Сколько длится</h4>
      <div class="mk-dur row row-wrap">
        <select class="input" value={f.durKind} aria-label="Длительность" onChange={(e) => set({ durKind: e.currentTarget.value, durN: MULT[e.currentTarget.value] && !f.durN ? '1' : f.durN })}>
          {DURATIONS.map(([k, label]) => (
            <option value={k}>{label}</option>
          ))}
        </select>
        {timed && <input class="input mk-dur-n" type="number" min="1" max="9999" value={f.durN} aria-label="Сколько" onInput={(e) => set({ durN: e.currentTarget.value })} />}
      </div>
      <p class="small muted mk-note">
        {f.durKind === 'turnStart' || f.durKind === 'turnEnd'
          ? 'Снимется сам, когда в трекере ходов начнётся (или закончится) следующий ход того, на ком эффект.'
          : 'Раунды идут по трекеру ходов: минута — 10 раундов, час — 600. Когда срок выйдет, маркер снимется сам и вернёт всё как было.'}
      </p>
      <label class="mk-check">
        <input type="checkbox" checked={f.conc} onChange={(e) => set({ conc: e.currentTarget.checked })} />
        <span>
          <b>Концентрация.</b> У наложившего появится маркер «Концентрация». Сняли его, или наложивший взял другой эффект с концентрацией, — этот эффект кончится у всех целей. При уроне мастеру напомнят о спасброске.
        </span>
      </label>

      <h4 class="sub-h">Что меняет</h4>
      <p class="small muted mk-note">
        Поле листа персонажа (ac, speed…), полоса токена (bar1, bar2…) или сам токен: свет, тёмное зрение, размер, прозрачность, невидимость. Значение — число или формула: <code>13 + @&#123;dexterity_mod&#125;</code>,{' '}
        <code>2d4 + 4</code> (кубики бросаются в чате при наложении), <code>@&#123;маркер&#125;</code> — число на маркере. «Дописать к тексту» добавляет к полю-формуле листа, например <code>1d4</code> к global_attack. Сняли маркер — всё вернулось.
      </p>
      <datalist id={listId}>
        {KEY_HINTS.map(([k, label]) => (
          <option value={k}>{label}</option>
        ))}
      </datalist>
      {f.changes.map((c, i) => (
        <div class="mk-change row" key={c._k}>
          <input class="input input-sm mk-key" list={listId} value={c.key} placeholder="ac, bar1, light.bright…" aria-label="Что менять" onInput={(e) => setChange(i, { key: e.currentTarget.value })} />
          <select class="input input-sm" value={c.mode || 'add'} aria-label="Как менять" onChange={(e) => setChange(i, { mode: e.currentTarget.value })}>
            {CHANGE_MODES.map(([m, label]) => (
              <option value={m}>{label}</option>
            ))}
          </select>
          <input class="input input-sm mk-val" value={c.value} placeholder={c.mode === 'append' ? '1d4' : '2'} aria-label="Значение или формула" onInput={(e) => setChange(i, { value: e.currentTarget.value })} />
          <label class="mk-lvl small" title="Умножить на число на маркере (уровень, стопки)">
            <input type="checkbox" checked={!!c.perLevel} disabled={c.mode === 'append'} onChange={(e) => setChange(i, { perLevel: e.currentTarget.checked })} /> × уровень
          </label>
          <IconButton icon="trash" size={15} title="Убрать изменение" onClick={() => set({ changes: f.changes.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => set({ changes: [...f.changes, { key: '', mode: 'add', value: '', _k: newId() }] })}>
        Изменение
      </Button>

      <h4 class="sub-h">Каждый ход</h4>
      <div class="mk-turn">
        <select class="input" value={t.when} aria-label="Когда действует" onChange={(e) => setTurn({ when: e.currentTarget.value })}>
          <option value="none">Ничего не делает</option>
          <option value="start">В начале хода цели</option>
          <option value="end">В конце хода цели</option>
        </select>
        {t.when !== 'none' && (
          <div class="mk-turn-body">
            <div class="mk-turn-row">
              <span class="small">Хиты</span>
              <select class="input input-sm" value={t.hpKind} aria-label="Урон или лечение" onChange={(e) => setTurn({ hpKind: e.currentTarget.value })}>
                <option value="dmg">урон</option>
                <option value="heal">лечение</option>
              </select>
              <input class="input input-sm" value={t.hp} placeholder="1d4, пусто — не меняются" aria-label="Сколько хитов, формула" onInput={(e) => setTurn({ hp: e.currentTarget.value })} />
            </div>
            <div class="mk-turn-row">
              <span class="small">Спасбросок</span>
              <input class="input input-sm" value={t.save} placeholder="1d20 + @{constitution_save}" aria-label="Спасбросок, формула" onInput={(e) => setTurn({ save: e.currentTarget.value })} />
              <span class="small">Сл</span>
              <input class="input input-sm mk-dc" type="number" min="1" max="40" value={t.dc} placeholder="10" aria-label="Сложность спасброска" onInput={(e) => setTurn({ dc: e.currentTarget.value })} />
            </div>
            <div class="mk-turn-row">
              <span class="small">Сообщение</span>
              <input class="input input-sm" value={t.text} maxLength={200} placeholder="Например: горит — действием можно потушить" aria-label="Сообщение в чат" onInput={(e) => setTurn({ text: e.currentTarget.value })} />
            </div>
            <p class="small muted mk-note">Бросает браузер мастера, один раз за ход: урон или лечение сразу меняют хиты, удачный спасбросок снимает эффект. У скрытых токенов — шёпотом мастеру.</p>
          </div>
        )}
      </div>

      <Field label="Описание" hint="Видно в подсказке маркера">
        <textarea class="input" rows={2} value={f.note} maxLength={600} placeholder="Например: скорость вдвое, +2 к КД, помеха на спасброски Ловкости" onInput={(e) => set({ note: e.currentTarget.value })} />
      </Field>

      <div class="modal-actions">
        {cur && (
          <Button kind="danger" icon="trash" onClick={remove}>
            Удалить
          </Button>
        )}
        <span class="grow" />
        <Button onClick={() => onClose(null)}>Отмена</Button>
        <Button kind="primary" onClick={save}>
          Сохранить
        </Button>
      </div>
    </Modal>
  );
}
