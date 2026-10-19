// Настройки ловушки (мастер): когда срабатывает и что делает
import { useState } from 'preact/hooks';
import { useApp } from '../hooks.js';
import { Modal, Field, Toggle, Button, confirmDialog, toast } from '../../ui/components.jsx';
import { TRAP_DEFAULTS } from '@shared/traps.js';

// готовые спецэффекты в точке срабатывания
const TRAP_FX = [
  ['', 'Без спецэффекта'],
  ['explode-fire', 'Взрыв'],
  ['burst-fire', 'Вспышка пламени'],
  ['explode-smoke', 'Облако дыма'],
  ['bubbling-acid', 'Кислота'],
  ['nova-frost', 'Волна холода'],
  ['burst-lightning', 'Разряд молнии'],
  ['splatter-blood', 'Кровь'],
  ['glow-magic', 'Магическое сияние'],
  ['nova-death', 'Волна смерти'],
];

export function TrapDialog({ id, fresh = false, onClose }) {
  const app = useApp();
  const { store, net } = app;
  const o = store.col.obj.get(id);
  // fresh — ловушку только что поставили из меню: «Отмена» убирает её с карты
  const isNew = fresh || !o?.trap;
  const [f, setF] = useState(() => ({ ...TRAP_DEFAULTS, ...(o?.trap || {}) }));
  const [hide, setHide] = useState(() => !!o && o.layer !== 'gm' && isNew);
  if (!o) return null;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const save = () => {
    const patch = { trap: { ...f, name: f.name.trim() || TRAP_DEFAULTS.name } };
    if (hide) patch.layer = 'gm';
    net.update('obj', id, patch).then((r) => (r?.error ? toast(r.error, 'error') : onClose()));
  };
  const cancel = () => {
    if (fresh) net.remove('obj', id);
    onClose();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Убрать ловушку?', text: 'Объект останется на карте, но больше не будет срабатывать.', okText: 'Убрать', danger: true }))) return;
    net.update('obj', id, { trap: null });
    onClose();
  };
  return (
    <Modal title={isNew ? 'Новая ловушка' : `Ловушка «${o.trap.name}»`} onClose={cancel} width={520} class="trap-dialog">
      <div class="trap-grid">
        <Field label="Название">
          <input class="input" value={f.name} maxLength={60} onInput={(e) => set({ name: e.currentTarget.value })} autoFocus placeholder="Яма с кольями" />
        </Field>
        <div class="trap-state">
          <Toggle checked={f.armed} onChange={(v) => set({ armed: v })} label={f.armed ? 'Взведена' : 'Разряжена'} />
          {!isNew && <span class="small muted">Срабатывала: {f.count || 0}</span>}
        </div>
      </div>

      <h4 class="trap-h4">Когда срабатывает</h4>
      <p class="small muted">
        Когда ход сделан и центр токена побывал в области ловушки: токен отпустили на ней или провели через неё (весь путь от начала перетаскивания, с поворотами). Пока токен тянут, ловушка молчит; вернули назад — не срабатывает. Сама ловушка может лежать на любом слое (на слое мастера её не видят игроки). Ловит токены на слое объектов, а спрятанные на слое мастера —
        только если она «на всех», и тогда об этом узнаёте только вы.
      </p>
      <div class="trap-grid">
        <Field label="Чьи токены">
          <select class="input" value={f.trigger} onChange={(e) => set({ trigger: e.currentTarget.value })}>
            <option value="players">Токены игроков</option>
            <option value="any">Любые токены</option>
          </select>
        </Field>
        <Field label="После срабатывания">
          <select class="input" value={f.once ? 'once' : 'again'} onChange={(e) => set({ once: e.currentTarget.value === 'once' })}>
            <option value="once">Разряжается</option>
            <option value="again">Остаётся взведённой</option>
          </select>
        </Field>
      </div>
      <div class="set-list">
        <Toggle checked={f.gmMoves} onChange={(v) => set({ gmMoves: v })} label="Срабатывает и когда токен двигаю я" />
        <Toggle checked={f.stop} onChange={(v) => set({ stop: v })} label="Остановить токен на ловушке" />
        <Toggle checked={f.reveal} onChange={(v) => set({ reveal: v })} label="После срабатывания показать ловушку игрокам" />
      </div>

      <h4 class="trap-h4">Что происходит</h4>
      <Field label="Описание для всех" hint="{name} — имя токена, который попался. Пусто — игроки ничего не узнают, сообщение получите только вы.">
        <textarea class="input" rows={3} value={f.message} maxLength={600} onInput={(e) => set({ message: e.currentTarget.value })} placeholder="Плита под ногами {name} проваливается!" />
      </Field>
      <div class="trap-grid">
        <Field label="Бросок" hint="Например 2d10 или 4d6+2">
          <input class="input" value={f.roll} maxLength={80} onInput={(e) => set({ roll: e.currentTarget.value })} placeholder="2d10" />
        </Field>
        <Field label="Спасбросок" hint="Напоминание игроку">
          <input class="input" value={f.save} maxLength={60} onInput={(e) => set({ save: e.currentTarget.value })} placeholder="Ловкость, Сл 13" />
        </Field>
      </div>
      <Toggle checked={f.damage} disabled={!f.roll.trim()} onChange={(v) => set({ damage: v })} label="Сразу снять выпавшее с хитов токена (с отменой)" />
      <div class="trap-grid">
        <Field label="Спецэффект">
          <select class="input" value={f.fx} onChange={(e) => set({ fx: e.currentTarget.value })}>
            {TRAP_FX.map(([v, n]) => (
              <option value={v}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Вспышка экрана">
          <select class="input" value={f.flash} onChange={(e) => set({ flash: e.currentTarget.value })}>
            <option value="">Нет</option>
            <option value="white">Белая</option>
            <option value="red">Красная</option>
          </select>
        </Field>
      </div>
      <div class="set-list">
        <Toggle checked={f.shake} onChange={(v) => set({ shake: v })} label="Тряска у всех" />
        {o.layer !== 'gm' && <Toggle checked={hide} onChange={setHide} label="Спрятать от игроков (на слой мастера)" />}
      </div>

      <div class="modal-actions">
        {!isNew && (
          <Button kind="danger" onClick={remove}>
            Убрать ловушку
          </Button>
        )}
        <span style={{ flex: 1 }} />
        <Button onClick={cancel}>Отмена</Button>
        <Button kind="primary" onClick={save}>
          {isNew ? 'Поставить ловушку' : 'Сохранить'}
        </Button>
      </div>
    </Modal>
  );
}
