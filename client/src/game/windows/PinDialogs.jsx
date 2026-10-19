// Метки на карте: настройки (мастер) и просмотр (игроки)
import { useState } from 'preact/hooks';
import { useApp, useStoreEvents } from '../hooks.js';
import { Modal, Field, Toggle, ColorInput, Button, confirmDialog } from '../../ui/components.jsx';

const PIN_COLORS = ['#c9a24a', '#b23a48', '#5b8fc7', '#7d9a6a', '#8e44ad', '#ece3d0'];

export function PinSettings({ id, onClose }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:handout']);
  const pin = store.col.obj.get(id);
  const [f, setF] = useState(() => ({
    name: pin?.name || '',
    showName: pin?.showName !== false,
    notes: pin?.notes || '',
    handoutId: pin?.handoutId || '',
    color: pin?.color || PIN_COLORS[0],
    visible: pin?.layer !== 'gm',
  }));
  if (!pin) return null;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const handouts = [...store.col.handout.values()].filter((h) => !h.archived).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  const linked = f.handoutId ? store.col.handout.get(f.handoutId) : null;
  const playersSee = linked && (linked.inJournals || []).includes('all');
  const save = () => {
    net.update('obj', id, {
      name: f.name.trim().slice(0, 80) || 'Метка',
      showName: f.showName,
      notes: f.notes.slice(0, 4000),
      handoutId: f.handoutId,
      color: f.color,
      layer: f.visible ? 'objects' : 'gm',
    });
    onClose();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Удалить метку?', text: `«${pin.name || 'Метка'}» исчезнет с карты.`, okText: 'Удалить', danger: true }))) return;
    net.remove('obj', id);
    onClose();
  };
  return (
    <Modal title="Метка на карте" onClose={onClose} width={460}>
      <Field label="Подпись">
        <input class="input" value={f.name} maxLength={80} onInput={(e) => set({ name: e.currentTarget.value })} autoFocus />
      </Field>
      <Toggle checked={f.showName} onChange={(v) => set({ showName: v })} label="Показывать подпись на карте" />
      <Field label="Заметка для игроков" hint="Видна тем, кто откроет метку">
        <textarea class="input" rows={4} value={f.notes} onInput={(e) => set({ notes: e.currentTarget.value })} placeholder="Например: «Здесь пахнет серой. Под плитой что-то скребётся»" />
      </Field>
      <Field label="Материал" hint={linked && !playersSee ? 'Этот материал игроки пока не видят — откройте к нему доступ в журнале' : 'Откроется при щелчке по метке'}>
        <select class="input" value={f.handoutId} onChange={(e) => set({ handoutId: e.currentTarget.value })}>
          <option value="">Без материала</option>
          {handouts.map((h) => (
            <option value={h.id}>{h.name || 'Без названия'}</option>
          ))}
        </select>
      </Field>
      <Field label="Цвет">
        <div class="row pin-colors">
          {PIN_COLORS.map((c) => (
            <button type="button" class={'pin-color' + (f.color === c ? ' on' : '')} style={{ background: c }} aria-label={'Цвет ' + c} aria-pressed={f.color === c} onClick={() => set({ color: c })} />
          ))}
          <ColorInput value={f.color} onChange={(c) => set({ color: c })} allowTransparent={false} title="Свой цвет" />
        </div>
      </Field>
      <Toggle checked={f.visible} onChange={(v) => set({ visible: v })} label="Видна игрокам (иначе — на слое мастера)" />
      <div class="modal-actions">
        <Button kind="danger" onClick={remove}>
          Удалить
        </Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Отмена</Button>
        <Button kind="primary" onClick={save}>
          Сохранить
        </Button>
      </div>
    </Modal>
  );
}

/** Просмотр метки: заметка и кнопка перехода к материалу */
export function PinView({ pin, onClose }) {
  const app = useApp();
  const h = pin.handoutId ? app.store.col.handout.get(pin.handoutId) : null;
  return (
    <Modal title={pin.name || 'Метка'} onClose={onClose} width={440}>
      {pin.notes ? <p class="pin-note">{pin.notes}</p> : !h && <p class="muted">Здесь ничего не написано.</p>}
      {h && (
        <div class="modal-actions">
          <Button
            kind="primary"
            icon="book"
            onClick={() => {
              onClose();
              app.openHandout(h.id);
            }}
          >
            Открыть «{h.name || 'материал'}»
          </Button>
        </div>
      )}
    </Modal>
  );
}
