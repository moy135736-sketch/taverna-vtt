import { useState } from 'preact/hooks';
import { AppCtx, useApp, useStoreEvents, useLocalStorage } from '../hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, IconButton, Modal, Field, Toggle, showModal, confirmDialog, showError, toast } from '../../ui/components.jsx';
import { newId } from '@shared/ids.js';

export function useMacroBar(store) {
  return useLocalStorage('tv:macrobar:' + store.gameId, []);
}

export function CollectionPanel() {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:macro', 'col:rtable']);
  const [bar, setBar] = useMacroBar(store);
  const macros = [...store.col.macro.values()].sort((a, b) => a.name.localeCompare(b.name));
  const tables = [...store.col.rtable.values()].sort((a, b) => a.name.localeCompare(b.name));

  // модальные окна рисуются вне дерева стола — передаём им контекст явно
  const modal = (render) => showModal((close) => <AppCtx.Provider value={app}>{render(close)}</AppCtx.Provider>);
  const editMacro = (m) => modal((close) => <MacroEditor macro={m} bar={bar} setBar={setBar} onClose={close} />);

  return (
    <div class="panel collection-panel">
      <div class="panel-scroll">
        <div class="sect-head">
          <h3>Макросы</h3>
          <Button size="sm" icon="plus" onClick={() => editMacro(null)}>
            Новый
          </Button>
        </div>
        {!macros.length && <p class="empty small">Макрос — сохранённая команда чата, например «/r 1d20+@&#123;Персонаж|strength_mod&#125;». Его можно вызвать кнопкой или словом #имя.</p>}
        <ul class="item-list">
          {macros.map((m) => (
            <li
              class="item-row"
              draggable={true}
              title="Перетащите на панель макросов внизу"
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-taverna', JSON.stringify({ kind: 'macro', id: m.id }));
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <button type="button" class="run-btn" title="Выполнить" onClick={() => app.runMacro(m.action, {})}>
                <Icon name="play" size={14} />
              </button>
              <span class="grow item-name">
                #{m.name}
                {m.ownerId !== store.me.id && <span class="faint small"> от {store.memberName(m.ownerId)}</span>}
              </span>
              <IconButton icon="pin" title={bar.includes(m.id) ? 'Убрать с панели' : 'На панель макросов'} active={bar.includes(m.id)} onClick={() => setBar((b) => (b.includes(m.id) ? b.filter((x) => x !== m.id) : [...b, m.id]))} size={16} />
              {(m.ownerId === store.me.id || store.isGM) && <IconButton icon="pencil" title="Изменить" onClick={() => editMacro(m)} size={16} />}
            </li>
          ))}
        </ul>

        <div class="sect-head">
          <h3>Таблицы бросков</h3>
          {store.isGM && (
            <Button
              size="sm"
              icon="plus"
              onClick={async () => {
                const id = newId();
                await net.create('rtable', { id, name: 'новая-таблица', items: [], showPlayers: true });
                modal((close) => <TableEditor id={id} onClose={close} />);
              }}
            >
              Новая
            </Button>
          )}
        </div>
        {!tables.length && <p class="empty small">Таблицы вызываются бросками [[1t[имя]]] — например, случайные встречи или находки.</p>}
        <ul class="item-list">
          {tables.map((t) => (
            <li class="item-row">
              <button type="button" class="run-btn" title="Бросить" onClick={() => app.runMacro(`/r 1t[${t.name}]`, {})}>
                <Icon name="dice" size={14} />
              </button>
              <span class="grow item-name">
                {t.name} <span class="faint small">{(t.items || []).length} строк</span>
              </span>
              {store.isGM && <IconButton icon="pencil" title="Изменить" size={16} onClick={() => modal((close) => <TableEditor id={t.id} onClose={close} />)} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MacroEditor({ macro, bar, setBar, onClose }) {
  const app = useApp();
  const { store, net } = app;
  const [name, setName] = useState(macro?.name || '');
  const [action, setAction] = useState(macro?.action || '');
  const [shared, setShared] = useState(macro?.visibleTo === 'all');
  const [token, setToken] = useState(!!macro?.istokenaction);
  const [inBar, setInBar] = useState(macro ? bar.includes(macro.id) : true);
  const save = async () => {
    const data = { name: name.trim().replace(/\s+/g, '-') || 'macro', action, visibleTo: shared ? 'all' : [], istokenaction: token };
    let id = macro?.id;
    const r = macro ? await net.update('macro', id, data) : await net.create('macro', { ...data, id: (id = newId()) });
    if (r?.error) return showError(new Error(r.error));
    setBar((b) => (inBar ? (b.includes(id) ? b : [...b, id]) : b.filter((x) => x !== id)));
    onClose();
  };
  const del = async () => {
    if (await confirmDialog({ title: 'Удалить макрос?', okText: 'Удалить', danger: true })) {
      net.remove('macro', macro.id);
      onClose();
    }
  };
  return (
    <Modal title={macro ? 'Макрос #' + macro.name : 'Новый макрос'} onClose={onClose} width={560}>
      <Field label="Имя (без пробелов)">
        <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="атака" autoFocus />
      </Field>
      <Field label="Команды" hint="Каждая строка — отдельное сообщение. Доступно: /r, /w, /em, [[…]], ?{Вопрос|1}, @{Персонаж|атрибут}, @{selected|bar1}, %{Персонаж|способность}, &{template:default}">
        <textarea class="input mono" rows={7} value={action} onInput={(e) => setAction(e.currentTarget.value)} placeholder={'&{template:default} {{name=Атака}} {{Бросок=[[1d20+?{Бонус|0}]]}}'} />
      </Field>
      <div class="row row-wrap" style={{ gap: '18px' }}>
        <Toggle checked={inBar} onChange={setInBar} label="На панели макросов" />
        <Toggle checked={token} onChange={setToken} label="Действие токена" />
        <Toggle checked={shared} onChange={setShared} label="Доступен всем" />
      </div>
      <div class="modal-actions">
        {macro && (
          <Button kind="danger" onClick={del} style={{ marginRight: 'auto' }}>
            Удалить
          </Button>
        )}
        <Button onClick={() => app.runMacro(action, {})}>Проверить</Button>
        <Button kind="primary" onClick={save}>
          Сохранить
        </Button>
      </div>
    </Modal>
  );
}

function TableEditor({ id, onClose }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:rtable']);
  const t = store.col.rtable.get(id);
  const [name, setName] = useState(t?.name || '');
  const [items, setItems] = useState(() => (t?.items || []).map((x) => ({ ...x })));
  const [showPlayers, setShowPlayers] = useState(t?.showPlayers !== false);
  if (!t) return null;
  const save = async () => {
    const r = await net.update('rtable', id, { name, items: items.filter((i) => i.name.trim()), showPlayers });
    if (r?.error) return showError(new Error(r.error));
    toast('Таблица сохранена', 'ok');
    onClose();
  };
  const setItem = (i, patch) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal title="Таблица бросков" onClose={onClose} width={600}>
      <Field label="Имя (используется в 1t[имя])">
        <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value.replace(/\s+/g, '-'))} />
      </Field>
      <table class="plain">
        <thead>
          <tr>
            <th>Результат</th>
            <th style={{ width: '90px' }}>Вес</th>
            <th style={{ width: '40px' }} />
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr>
              <td>
                <input class="input input-sm" value={it.name} onInput={(e) => setItem(i, { name: e.currentTarget.value })} />
              </td>
              <td>
                <input class="input input-sm" type="number" min={0} value={it.weight ?? 1} onInput={(e) => setItem(i, { weight: Number(e.currentTarget.value) })} />
              </td>
              <td>
                <IconButton icon="trash" title="Удалить строку" onClick={() => setItems(items.filter((_, j) => j !== i))} size={15} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="row" style={{ marginTop: '8px' }}>
        <Button size="sm" icon="plus" onClick={() => setItems([...items, { id: newId(), name: '', weight: 1 }])}>
          Строка
        </Button>
        <Toggle checked={showPlayers} onChange={setShowPlayers} label="Видна игрокам" />
      </div>
      <div class="modal-actions">
        <Button
          kind="danger"
          style={{ marginRight: 'auto' }}
          onClick={async () => {
            if (await confirmDialog({ title: 'Удалить таблицу?', okText: 'Удалить', danger: true })) {
              net.remove('rtable', id);
              onClose();
            }
          }}
        >
          Удалить
        </Button>
        <Button onClick={onClose}>Отмена</Button>
        <Button kind="primary" onClick={save}>
          Сохранить
        </Button>
      </div>
    </Modal>
  );
}
