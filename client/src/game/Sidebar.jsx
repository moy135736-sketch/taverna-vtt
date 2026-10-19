import { useState, useEffect } from 'preact/hooks';
import { useApp, useLocalStorage, useStoreEvents } from './hooks.js';
import { Tabs } from '../ui/components.jsx';
import { Icon } from '../ui/icons.jsx';
import { ChatPanel } from './panels/ChatPanel.jsx';
import { JournalPanel } from './panels/JournalPanel.jsx';
import { ArtPanel } from './panels/ArtPanel.jsx';
import { CollectionPanel } from './panels/CollectionPanel.jsx';
import { JukeboxPanel } from './panels/JukeboxPanel.jsx';
import { SettingsPanel } from './panels/SettingsPanel.jsx';

export function Sidebar({ sheetVersion }) {
  const app = useApp();
  const { store } = app;
  const [tab, setTab] = useLocalStorage('tv:sidetab', 'chat');
  const [width, setWidth] = useLocalStorage('tv:sidew', 360);
  const [hidden, setHidden] = useLocalStorage('tv:sidehide', typeof window !== 'undefined' && window.innerWidth <= 900);
  const [unread, setUnread] = useState(0);
  const visibleTab = tab === 'art' && !store.isGM ? 'chat' : tab;
  useEffect(() => store.on('chat', () => (visibleTab !== 'chat' || hidden) && setUnread((u) => u + 1)), [visibleTab, hidden]);
  useEffect(() => {
    if (visibleTab === 'chat' && !hidden) setUnread(0);
  }, [visibleTab, hidden]);
  useStoreEvents(store, ['snapshot']);

  // библиотеку картинок видит только мастер: там карты и иллюстрации, которые игрокам рано видеть
  const tabs = [
    { id: 'chat', icon: 'chat', title: 'Чат', badge: unread || null },
    { id: 'journal', icon: 'book', title: 'Журнал: персонажи и материалы' },
    store.isGM && { id: 'art', icon: 'image', title: 'Библиотека картинок' },
    { id: 'collection', icon: 'list', title: 'Макросы и таблицы бросков' },
    { id: 'music', icon: 'music', title: 'Музыка и звуки' },
    { id: 'settings', icon: 'cog', title: 'Настройки' },
  ].filter(Boolean);
  const current = tabs.some((t) => t.id === tab) ? tab : 'chat';

  const startResize = (e) => {
    e.preventDefault();
    const sx = e.clientX,
      sw = width;
    const shield = document.createElement('div');
    shield.className = 'drag-shield';
    shield.style.cursor = 'ew-resize';
    document.body.appendChild(shield);
    const move = (ev) => setWidth(Math.max(280, Math.min(760, sw - (ev.clientX - sx))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      shield.remove();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {hidden && (
        <div class="side-rail" role="toolbar" aria-label="Боковая панель">
          {tabs.map((t) => (
            <button
              type="button"
              class="icon-btn side-rail-btn"
              title={t.title}
              aria-label={t.title}
              onClick={() => {
                setTab(t.id);
                setHidden(false);
              }}
            >
              <Icon name={t.icon} size={18} />
              {t.badge ? <span class="badge">{t.badge}</span> : null}
            </button>
          ))}
        </div>
      )}
      <aside class="sidebar" style={{ width: width + 'px' }} hidden={hidden}>
      <div class="side-resize" onPointerDown={startResize} aria-hidden="true" />
      <div class="side-tabs-row">
        <Tabs tabs={tabs} value={current} onChange={setTab} class="side-tabs" />
        <button type="button" class="icon-btn side-hide" title="Скрыть панель" aria-label="Скрыть панель" onClick={() => setHidden(true)}>
          <Icon name="chevRight" size={18} />
        </button>
      </div>
      <div class="side-body">
        <div class="side-pane" hidden={current !== 'chat'}>
          <ChatPanel sheetVersion={sheetVersion} />
        </div>
        {current === 'journal' && <JournalPanel />}
        {current === 'art' && store.isGM && <ArtPanel />}
        {current === 'collection' && <CollectionPanel />}
        {current === 'music' && <JukeboxPanel />}
        {current === 'settings' && <SettingsPanel />}
      </div>
      </aside>
    </>
  );
}
