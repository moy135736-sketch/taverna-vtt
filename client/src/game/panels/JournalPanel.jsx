import { useState, useRef } from 'preact/hooks';
import { useApp, useStoreEvents, useLocalStorage } from '../hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, IconButton, openContextMenu, confirmDialog, promptDialog, toast, showError } from '../../ui/components.jsx';
import { api } from '../../api.js';
import { newId } from '@shared/ids.js';
import { importRoll20Character, exportRoll20Character } from '../roll20json.js';

export function JournalPanel() {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:char', 'col:handout', 'members']);
  const [q, setQ] = useState('');
  const [open, setOpen] = useLocalStorage('tv:folders', {});
  const [showArchived, setShowArchived] = useState(false);
  const fileRef = useRef();
  const gm = store.isGM;

  const chars = [...store.col.char.values()].filter((c) => (showArchived ? c.archived : !c.archived) && (!q || (c.name || '').toLowerCase().includes(q.toLowerCase())));
  const handouts = [...store.col.handout.values()].filter((h) => (showArchived ? h.archived : !h.archived) && (!q || (h.name || '').toLowerCase().includes(q.toLowerCase())));

  const group = (list) => {
    const m = new Map();
    for (const e of list) {
      const f = e.folder || '';
      if (!m.has(f)) m.set(f, []);
      m.get(f).push(e);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    return [...m.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0], 'ru')));
  };

  const newChar = async () => {
    const id = newId();
    const r = await net.create('char', { id, name: 'Новый персонаж', controlledBy: gm ? [] : [store.me.id], inJournals: gm ? [] : [store.me.id] });
    if (r?.error) return showError(new Error(r.error));
    await app.sheets.applyUserOptions(id).catch(() => {});
    // вкладку выбирает окно: лист, а если он ещё грузится — сначала «Био», потом сам лист
    app.openCharacter(id);
  };
  const newHandout = async () => {
    const id = newId();
    await net.create('handout', { id, name: 'Новый материал' });
    app.openHandout(id);
  };

  const importJson = async (e) => {
    const files = [...e.currentTarget.files];
    e.currentTarget.value = '';
    for (const f of files) {
      try {
        const data = JSON.parse(await f.text());
        const id = await importRoll20Character(app, data);
        toast('Персонаж импортирован', 'ok');
        app.openCharacter(id);
      } catch (err) {
        showError(err);
      }
    }
  };

  const charMenu = (e, c) => {
    e.preventDefault();
    const items = [
      { label: 'Открыть', icon: 'scroll', action: () => app.openCharacter(c.id) },
      { label: 'Экспорт в JSON (Roll20)', icon: 'download', action: () => exportRoll20Character(app, c.id) },
    ];
    if (gm || store.canControlChar(c)) {
      items.push(
        {
          label: 'Дублировать',
          icon: 'copy',
          action: async () => {
            try {
              const data = await exportRoll20Character(app, c.id, { returnOnly: true });
              data.character.name += ' (копия)';
              await importRoll20Character(app, data);
            } catch (err) {
              showError(err);
            }
          },
        },
        {
          label: 'Переместить в папку…',
          icon: 'folder',
          action: async () => {
            const f = await promptDialog({ title: 'Папка', label: 'Название папки (пусто — без папки)', value: c.folder || '' });
            if (f !== null) net.update('char', c.id, { folder: f.trim() });
          },
        },
      );
    }
    if (gm) {
      items.push(
        { label: 'Копировать в другой стол…', icon: 'external', action: () => copyToGame(app, 'char', c) },
        { label: c.archived ? 'Вернуть из архива' : 'В архив', icon: 'folder', action: () => net.update('char', c.id, { archived: !c.archived }) },
        '-',
        {
          label: 'Удалить',
          icon: 'trash',
          danger: true,
          action: async () => {
            if (await confirmDialog({ title: `Удалить «${c.name}»?`, text: 'Персонаж и все его атрибуты будут удалены. Токены останутся, но потеряют связь.', okText: 'Удалить', danger: true })) net.remove('char', c.id);
          },
        },
      );
    }
    openContextMenu(e.clientX, e.clientY, items);
  };

  const handoutMenu = (e, h) => {
    e.preventDefault();
    if (!gm) return;
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Открыть', icon: 'scroll', action: () => app.openHandout(h.id) },
      { label: 'Показать игрокам', icon: 'eye', action: () => net.update('handout', h.id, { inJournals: ['all'] }).then(() => net.request('handout:show', { handoutId: h.id })) },
      {
        label: 'Переместить в папку…',
        icon: 'folder',
        action: async () => {
          const f = await promptDialog({ title: 'Папка', label: 'Название папки', value: h.folder || '' });
          if (f !== null) net.update('handout', h.id, { folder: f.trim() });
        },
      },
      { label: 'Копировать в другой стол…', icon: 'external', action: () => copyToGame(app, 'handout', h) },
      { label: h.archived ? 'Вернуть из архива' : 'В архив', icon: 'folder', action: () => net.update('handout', h.id, { archived: !h.archived }) },
      '-',
      { label: 'Удалить', icon: 'trash', danger: true, action: async () => (await confirmDialog({ title: `Удалить «${h.name}»?`, okText: 'Удалить', danger: true })) && net.remove('handout', h.id) },
    ]);
  };

  const toggleFolder = (k) => setOpen({ ...open, [k]: !(open[k] ?? true) });

  const renderGroup = (kind, groups, renderItem) =>
    groups.map(([folder, items]) => {
      const key = kind + ':' + folder;
      const isOpen = open[key] ?? true;
      return (
        <div class="j-group">
          {folder && (
            <button type="button" class="j-folder" onClick={() => toggleFolder(key)} aria-expanded={isOpen}>
              <Icon name={isOpen ? 'chevDown' : 'chevRight'} size={14} />
              <Icon name="folder" size={15} />
              <span>{folder}</span>
              <span class="faint small">{items.length}</span>
            </button>
          )}
          {isOpen && <ul class={'j-list ' + (folder ? 'nested' : '')}>{items.map(renderItem)}</ul>}
        </div>
      );
    });

  const ctlNames = (c) =>
    (c.controlledBy || [])
      .map((id) => (id === 'all' ? 'все' : store.members.get(id)?.displayName))
      .filter(Boolean)
      .join(', ');

  return (
    <div class="panel journal-panel">
      <div class="panel-head">
        <div class="search-box">
          <Icon name="search" size={15} />
          <input class="input input-sm" placeholder="Поиск по журналу" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Поиск" />
        </div>
        <div class="row row-wrap">
          {(gm || store.settings.playersCanCreateCharacters) && (
            <Button size="sm" icon="plus" onClick={newChar}>
              Персонаж
            </Button>
          )}
          {gm && (
            <Button size="sm" icon="plus" onClick={newHandout}>
              Материал
            </Button>
          )}
          {gm && (
            <Button size="sm" icon="claw" onClick={() => app.openBestiary()} title="Монстры SRD 5.2.1 и свои по ссылке с GitHub — сразу на карту">
              Бестиарий
            </Button>
          )}
          <input type="file" accept=".json" multiple hidden ref={fileRef} onChange={importJson} />
          {(gm || store.settings.playersCanCreateCharacters) && <IconButton icon="upload" title="Импорт персонажа из JSON (Roll20 / VTTES)" onClick={() => fileRef.current.click()} />}
          {gm && <IconButton icon="folder" title={showArchived ? 'Показать активные' : 'Показать архив'} active={showArchived} onClick={() => setShowArchived(!showArchived)} />}
        </div>
      </div>
      <div class="panel-scroll">
        <h3 class="j-h">Персонажи</h3>
        {!chars.length && <p class="empty small">{gm ? 'Создайте персонажа или импортируйте его из Roll20.' : 'Мастер ещё не выдал вам персонажа.'}</p>}
        {renderGroup('c', group(chars), (c) => (
          <li
            class="j-item"
            draggable={true}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-taverna', JSON.stringify({ kind: 'char', id: c.id }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => app.openCharacter(c.id)}
            onContextMenu={(e) => charMenu(e, c)}
            title="Перетащите на карту, чтобы поставить токен"
          >
            <span class="j-thumb">{c.avatar || (c.statblock && c.defaultToken?.src) ? <img src={c.avatar || c.defaultToken.src} alt="" /> : <Icon name="user" size={18} />}</span>
            <span class="j-name">
              {c.name || 'Без имени'}
              {ctlNames(c) && <span class="j-sub">{ctlNames(c)}</span>}
            </span>
          </li>
        ))}
        <h3 class="j-h">Материалы</h3>
        {!handouts.length && <p class="empty small">{gm ? 'Здесь хранятся заметки, письма и картинки для игроков.' : 'Пока ничего нет.'}</p>}
        {renderGroup('h', group(handouts), (h) => (
          <li class="j-item" onClick={() => app.openHandout(h.id)} onContextMenu={(e) => handoutMenu(e, h)}>
            <span class="j-thumb">{h.avatar ? <img src={h.avatar} alt="" /> : <Icon name="scroll" size={18} />}</span>
            <span class="j-name">
              {h.name || 'Без названия'}
              {gm && (h.inJournals || []).includes('all') && <span class="j-sub">видят все</span>}
            </span>
          </li>
        ))}
      </div>
    </div>
  );
}

/** Скопировать персонажа или материал в другой стол, где вы мастер (с атрибутами и способностями) */
async function copyToGame(app, kind, item) {
  let games;
  try {
    games = (await api.get('/api/games')).games.filter((g) => g.role === 'gm' && g.id !== app.store.gameId);
  } catch (e) {
    return showError(e);
  }
  if (!games.length) return toast('Нет других столов, где вы мастер', 'error');
  const target = await promptDialog({
    title: `Копировать «${item.name || 'без названия'}»`,
    label: 'В какой стол',
    options: games.map((g) => ({ value: g.id, label: g.name })),
    okText: 'Копировать',
  });
  if (!target) return;
  try {
    const r = await api.post(`/api/games/${app.store.gameId}/transfer`, { targetGameId: target, [kind === 'char' ? 'chars' : 'handouts']: [item.id] });
    toast(`Скопировано в «${r.target.name}»`, 'ok');
  } catch (e) {
    showError(e);
  }
}
