// «С чего начать» — подсказка мастеру за новым столом: карта, персонаж, игроки, туман и свет
import { useApp, useStoreEvents, useLocalStorage } from './hooks.js';
import { Icon } from '../ui/icons.jsx';
import { copyInvite } from '../ui/invite.js';

export function GmStart() {
  const app = useApp();
  const { store } = app;
  useStoreEvents(store, ['col:obj', 'col:char', 'col:page', 'page', 'snapshot', 'members', 'game']);
  const [dismissed, setDismissed] = useLocalStorage('tv:start:' + store.gameId, false);
  // те же ключи и значения по умолчанию, что у боковой панели (Sidebar.jsx), — кэш общий
  const [, setTab] = useLocalStorage('tv:sidetab', 'chat');
  const [, setHidden] = useLocalStorage('tv:sidehide', typeof window !== 'undefined' && window.innerWidth <= 900);
  if (!store.isGM || dismissed) return null;

  const objs = store.objsOnPage();
  const hasMap = objs.some((o) => o.layer === 'map');
  const hasChar = store.col.char.size > 0;
  const hasPlayers = [...store.members.values()].some((m) => m.role !== 'gm');
  const page = store.page;
  const darkness = !!(page?.lighting?.enabled || page?.fog?.enabled);
  // всё главное сделано — подсказка больше не нужна
  if (hasMap && hasChar && hasPlayers) return null;

  const openSide = (tab) => {
    setHidden(false);
    setTab(tab);
  };
  const invite = () => copyInvite(store.game?.inviteCode);
  const steps = [
    { done: hasMap, title: 'Положите карту', hint: 'Перетащите картинку прямо на доску или выберите в библиотеке', icon: 'image', action: () => openSide('art') },
    { done: hasChar, title: 'Создайте персонажа', hint: 'Журнал → «Персонаж»; перетащите его на карту — появится токен', icon: 'book', action: () => openSide('journal') },
    { done: hasPlayers, title: 'Позовите игроков', hint: 'Скопировать ссылку-приглашение', icon: 'link', action: invite },
    { done: darkness, title: 'Туман войны или свет', hint: 'Настройки сцены: динамический свет, стены, туман', icon: 'cloud', action: () => app.openPageSettings(store.ui.pageId) },
  ];
  return (
    <section class="gm-start" aria-label="С чего начать">
      <div class="gm-start-head">
        <h3>С чего начать</h3>
        <button type="button" class="linklike small" onClick={() => setDismissed(true)}>
          Скрыть
        </button>
      </div>
      <ol>
        {steps.map((s) => (
          <li class={s.done ? 'done' : ''}>
            <button type="button" onClick={s.action} disabled={s.done && s.icon !== 'cloud'}>
              <span class="gm-start-mark" aria-hidden="true">
                <Icon name={s.done ? 'check' : s.icon} size={15} />
              </span>
              <span>
                <strong>{s.title}</strong>
                <span class="gm-start-hint">{s.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
