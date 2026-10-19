import { useApp, useStoreEvents } from './hooks.js';
import { Icon } from '../ui/icons.jsx';
import { IconButton, openContextMenu, confirmDialog, promptDialog, toast } from '../ui/components.jsx';
import { PAGE_DEFAULTS } from '@shared/defaults.js';
import { newId } from '@shared/ids.js';

export function SceneBar() {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:page', 'game', 'page', 'snapshot']);
  const pages = [...store.col.page.values()].filter((p) => !p.archived || store.isGM).sort((a, b) => (a.order || 0) - (b.order || 0));
  const playerPage = store.state.playerPageId;
  const cur = store.ui.pageId;

  if (!store.isGM) {
    const p = store.page;
    return (
      <div class="scenebar">
        <span class="scene-name">{p?.name}</span>
      </div>
    );
  }

  const addPage = async () => {
    const name = await promptDialog({ title: 'Новая сцена', label: 'Название', value: `Сцена ${pages.length + 1}` });
    if (name === null) return;
    const id = newId();
    await net.create('page', { ...JSON.parse(JSON.stringify(PAGE_DEFAULTS)), id, name: name || 'Сцена', order: pages.length });
    store.setPage(id);
  };

  const menu = (e, p) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Перенести всех игроков сюда', icon: 'flag', action: () => net.request('state', { playerPageId: p.id, playerPages: {} }) },
      { label: 'Настройки сцены', icon: 'cog', action: () => app.openPageSettings(p.id) },
      {
        label: 'Дублировать',
        icon: 'copy',
        action: async () => {
          const id = newId();
          const copy = JSON.parse(JSON.stringify(p));
          await net.create('page', { ...copy, id, name: p.name + ' (копия)', order: pages.length });
          for (const o of store.objsOnPage(p.id)) await net.create('obj', { ...JSON.parse(JSON.stringify(o)), id: newId(), pageId: id });
          toast('Сцена скопирована', 'ok');
        },
      },
      { label: p.archived ? 'Вернуть из архива' : 'В архив', icon: 'folder', action: () => net.update('page', p.id, { archived: !p.archived }) },
      '-',
      {
        label: 'Удалить сцену',
        icon: 'trash',
        danger: true,
        disabled: pages.length <= 1,
        action: async () => {
          if (await confirmDialog({ title: `Удалить «${p.name}»?`, text: 'Все объекты сцены будут удалены.', okText: 'Удалить', danger: true })) net.remove('page', p.id);
        },
      },
    ]);
  };

  return (
    <div class="scenebar" role="tablist" aria-label="Сцены">
      {pages.map((p) => (
        <button
          type="button"
          role="tab"
          aria-selected={cur === p.id}
          class={'scene-tab ' + (cur === p.id ? 'active' : '') + (p.archived ? ' archived' : '')}
          onClick={() => store.setPage(p.id)}
          onContextMenu={(e) => menu(e, p)}
          onDblClick={() => app.openPageSettings(p.id)}
          title={p.id === playerPage ? 'Здесь находятся игроки' : 'Правый щелчок — меню сцены'}
        >
          {p.id === playerPage && <Icon name="flag" size={14} class="player-flag" />}
          <span>{p.name}</span>
        </button>
      ))}
      <IconButton icon="plus" title="Новая сцена" onClick={addPage} size={16} />
      {cur && cur !== playerPage && (
        <button type="button" class="btn btn-sm btn-ghost move-players" onClick={() => net.request('state', { playerPageId: cur, playerPages: {} })} title="Показать игрокам эту сцену">
          <Icon name="flag" size={14} />
          <span>Игроков сюда</span>
        </button>
      )}
      {cur && <IconButton icon="cog" title="Настройки сцены" onClick={() => app.openPageSettings(cur)} size={16} />}
    </div>
  );
}
