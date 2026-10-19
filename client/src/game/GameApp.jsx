import { useState, useEffect, useRef, useMemo, useCallback, useContext } from 'preact/hooks';
import { GameStore } from './store.js';
import { Net } from './net.js';
import { Board } from './board/Board.js';
import { SheetEngine } from './sheet/engine.js';
import { MacroEngine } from './macro/engine.js';
import { AppCtx, useStoreEvents } from './hooks.js';
import { navigate } from '../App.jsx';
import { uploadFiles } from '../api.js';
import { Spinner, toast, showError, promptDialog, showModal, openContextMenu, Avatar, IconButton, Modal } from '../ui/components.jsx';
import { Toolbar } from './Toolbar.jsx';
import { SceneBar } from './SceneBar.jsx';
import { Sidebar } from './Sidebar.jsx';
import { MacroBar } from './MacroBar.jsx';
import { CharacterWindow } from './windows/CharacterWindow.jsx';
import { HandoutWindow } from './windows/HandoutWindow.jsx';
import { TokenSettings } from './windows/TokenSettings.jsx';
import { PageSettings } from './windows/PageSettings.jsx';
import { TurnTracker } from './windows/TurnTracker.jsx';
import { QueryDialog } from './windows/QueryDialog.jsx';
import { tokenContextMenu, applyBarInput } from './contextMenu.js';
import { showRoll } from './diceAnim.js';
import { disposeDice3d } from './dice3d/index.js';
import { Jukebox, getUserVolume } from './jukebox.js';
import { RollTooltip } from './chat/RollTooltip.jsx';
import { loadUiPrefs } from './Toolbar.jsx';
import { Voice } from './voice.js';
import { VoiceControls, PlayerChip, VideoDock } from './VoiceBar.jsx';
import { PinSettings, PinView } from './windows/PinDialogs.jsx';
import { MarkerEditor } from './windows/MarkerEditor.jsx';
import { EffectLibrary } from './windows/EffectLibrary.jsx';
import { TrapDialog } from './windows/TrapDialog.jsx';
import { changeHp } from './damage.js';
import { watchReactionFloats } from './chat/reactions.jsx';
import { MarkerHud } from './MarkerHud.jsx';
import { expireMarkers, hasExpired, effectCommand, handleEffectAsk } from './effects.js';
import { watchTurnEffects } from './turnEffects.js';
import { GmStart } from './GmStart.jsx';
import { CineLayer, CinePanel } from './Cine.jsx';
import { useTableTheme } from '../themes/themes.js';
import { prepareUploads } from '../media/upload.js';
import { ThemeDecor } from '../themes/ThemeDecor.jsx';
import './game.css';
import './chat/chat.css';

export default function GameApp({ gameId, user }) {
  const core = useMemo(() => {
    const store = new GameStore(gameId, user);
    loadUiPrefs(store);
    try {
      const as = JSON.parse(localStorage.getItem('tv:as:' + gameId) || 'null');
      if (as) store.ui.speakingAs = as;
    } catch {
      /* ignore */
    }
    const net = new Net(store);
    const sheets = new SheetEngine(store, net, {
      error: (m) => toast(m, 'error'),
      notice: (m) => toast(m),
    });
    const voice = new Voice(store, net);
    return { store, net, sheets, voice };
  }, [gameId]);
  const { store, net, sheets, voice } = core;
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [status, setStatus] = useState('connecting');
  const [wins, setWins] = useState([]);
  const boardEl = useRef();
  const boardRef = useRef(null);
  const [sheetVersion, setSheetVersion] = useState(0);
  // оформление стола (по листу или как выбрал мастер); «загрузка» оформления — один раз при входе
  const theme = useTableTheme(store, ready);
  const [boot, setBoot] = useState(true);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setBoot(false), 2400);
    return () => clearTimeout(t);
  }, [ready]);

  // --- окна ---
  const openWin = useCallback((key, type, props = {}) => {
    setWins((ws) => {
      const ex = ws.find((w) => w.key === key);
      if (ex) return [...ws.filter((w) => w.key !== key), { ...ex, props: { ...ex.props, ...props }, t: Date.now() }];
      return [...ws, { key, type, props, t: Date.now() }];
    });
  }, []);
  const closeWin = useCallback((key) => setWins((ws) => ws.filter((w) => w.key !== key)), []);

  const macro = useMemo(
    () =>
      new MacroEngine({
        store,
        net,
        sheets,
        getBoard: () => boardRef.current,
        prompt: (q) => showModal((close) => <QueryDialog q={q} onDone={close} />),
        notify: (text) => store.emit('chat:system', { text, ts: Date.now(), error: true }),
      }),
    [store],
  );
  sheets.macro = macro;

  const appRef = useRef(null);
  const app = useMemo(
    () => ({
      store,
      net,
      sheets,
      macro,
      voice,
      user,
      board: () => boardRef.current,
      openCharacter: (charId, tab) => openWin('char:' + charId, 'char', { charId, tab }),
      openHandout: (id) => openWin('handout:' + id, 'handout', { id }),
      openTokenSettings: (id, tab) => openWin('token:' + id, 'token', { id, tab }),
      openPageSettings: (id) => openWin('page:' + id, 'page', { id }),
      toggleTurnTracker: () => setWins((ws) => (ws.some((w) => w.key === 'turn') ? ws.filter((w) => w.key !== 'turn') : [...ws, { key: 'turn', type: 'turn', props: {} }])),
      openTurnTracker: () => openWin('turn', 'turn', {}),
      closeWin,
      upload: async (files, folder) => {
        try {
          const list = await prepareUploads(files, user);
          toast(`Загрузка: ${list.length} файл(ов)…`);
          const d = await uploadFiles(list, { gameId, folder });
          if (d.errors?.length) toast(d.errors.join('\n'), 'error');
          store.emit('assets:changed');
          return d.assets;
        } catch (e) {
          showError(e);
          return [];
        }
      },
      runMacro: (text, ctx) => macro.run(text, ctx),
      // метки на карте: игрок — заметка или сразу материал; мастер — настройки
      openPin: (pin) => {
        const h = pin.handoutId ? store.col.handout.get(pin.handoutId) : null;
        if (h && !pin.notes) return app.openHandout(h.id);
        showModal((close) => (
          <AppCtx.Provider value={app}>
            <PinView pin={pin} onClose={close} />
          </AppCtx.Provider>
        ));
      },
      openPinSettings: (id) =>
        showModal((close) => (
          <AppCtx.Provider value={app}>
            <PinSettings id={id} onClose={close} />
          </AppCtx.Provider>
        )),
      // свой маркер (эффект): новый (id = null) или правка; промис — id сохранённого или null
      editMarker: (id) =>
        showModal((close) => (
          <AppCtx.Provider value={app}>
            <MarkerEditor id={id} onClose={close} />
          </AppCtx.Provider>
        )),
      // пробный бросок полного набора своими кубиками (виден только себе)
      previewDice: (skin) => {
        const r = (n) => 1 + Math.floor(Math.random() * n);
        const parts = [4, 6, 8, 10, 12, 20].map((sides) => ({ t: 'dice', sides, dice: [{ v: r(sides) }] }));
        const me = store.members.get(store.me.id);
        showRoll(boardRef.current?.root?.parentElement || document.querySelector('.board-host')?.parentElement, { roll: { parts } }, me?.color || user?.color || '#7a2e2e', skin);
      },
      // ловушка на объекте: поставить или настроить (мастер)
      openTrap: (id, { fresh = false } = {}) =>
        showModal((close) => (
          <AppCtx.Provider value={app}>
            <TrapDialog id={id} fresh={fresh} onClose={close} />
          </AppCtx.Provider>
        )),
      // готовые эффекты (заклинания и состояния) — добавить к столу
      openEffectLibrary: () =>
        showModal((close) => (
          <AppCtx.Provider value={app}>
            <EffectLibrary onClose={close} />
          </AppCtx.Provider>
        )),
      // бестиарий мастера (код и монстры грузятся, когда его впервые открыли)
      openBestiary: async () => {
        let mod;
        try {
          mod = await import('./bestiary/Bestiary.jsx');
        } catch (e) {
          return showError(e);
        }
        return showModal((close) => (
          <AppCtx.Provider value={app}>
            <mod.Bestiary onClose={close} />
          </AppCtx.Provider>
        ));
      },
    }),
    [store],
  );
  appRef.current = app;
  // /effect в чате и макросах
  macro.effectHandler = (args, ctx) => effectCommand(appRef.current, args, ctx);

  // --- соединение ---
  useEffect(() => {
    const offs = [
      net.on('status', setStatus),
      net.on('fatal', (m) => setFatal(m)),
      net.on('error', (m) => toast(m, 'error')),
      store.on('snapshot', () => {
        const as = store.ui.speakingAs;
        if (as?.type === 'char' && !store.canControlChar(store.col.char.get(as.id))) store.ui.speakingAs = { type: 'player' };
        setReady(true);
      }),
      net.on('sheetChanged', async () => {
        await sheets.load();
        setSheetVersion((v) => v + 1);
      }),
      net.on('handout:show', ({ handoutId }) => store.col.handout.has(handoutId) && app.openHandout(handoutId)),
      store.on('game', () => notifyTurn(store)),
      store.on('snapshot', () => {
        const f = store.state.turnorder?.[0];
        lastTurnKey = f ? `${f.id}|${store.state.round || 1}` : '';
      }),
    ];
    net.connect();
    document.documentElement.classList.add('in-game');
    window.__voice = voice;
    window.__sheets = sheets;
    const jb = new Jukebox(store, net);
    return () => {
      offs.forEach((o) => o());
      jb.destroy();
      voice.destroy();
      net.disconnect();
      sheets.worker?.stop();
      document.getElementById('sheet-chat-css')?.remove();
      document.documentElement.classList.remove('in-game');
    };
  }, [net]);

  // лист персонажа: загружаем при подключении и смене листа
  const sheetKey = store.game?.sheetId + '|' + (store.settings?.sheetLanguage || '');
  useStoreEvents(store, ['game']);
  useEffect(() => {
    if (!ready) return;
    sheets.load().then(() => setSheetVersion((v) => v + 1));
  }, [ready, sheetKey]);

  // мастер снимает эффекты, у которых вышел срок (раунды считает порядок ходов; концентрацию — сервер),
  // выполняет эффекты «каждый ход» и просьбы игроков наложить эффект на чужие токены
  useEffect(() => {
    if (!ready || !store.isGM) return;
    let last = null;
    const check = () => {
      const t = store.state.tick || 0;
      if (t === last) return;
      last = t;
      expireMarkers(app);
    };
    check();
    let timer = null;
    const onObj = () => {
      clearTimeout(timer);
      timer = setTimeout(() => hasExpired(store) && expireMarkers(app), 250);
    };
    const offs = [store.on('game', check), store.on('col:obj', onObj), watchTurnEffects(app), net.on('effect:ask', (req) => handleEffectAsk(app, req))];
    return () => {
      clearTimeout(timer);
      offs.forEach((f) => f());
    };
  }, [ready]);

  // реакции, всплывающие над токенами и у аватаров
  useEffect(() => (ready ? watchReactionFloats(app) : undefined), [ready]);

  // ловушки — мастеру: сработала (кто попался) или не сработала, потому что так настроена
  useEffect(() => {
    if (!ready) return undefined;
    const why = {
      players: 'она ловит только токены игроков',
      gm: 'ходы мастера её не задевают',
      both: 'она ловит только токены игроков, а ходы мастера её не задевают',
    };
    const offs = [
      net.on('trap:fired', ({ name, token, status }) => toast(`Ловушка «${name}»: попался ${token}. ${status}`, 'info', 6000)),
      net.on('trap:skip', ({ trapId, name, why: w, token }) =>
        toast(`Ловушка «${name}» пропустила: ${token} — ${why[w] || 'так настроена'}.`, 'info', 8000, { label: 'Настроить', onClick: () => app.openTrap(trapId) }),
      ),
    ];
    return () => offs.forEach((f) => f());
  }, [ready]);

  // ловушка с уроном: хиты снимает этот клиент (мастера, а без мастера — того, кто шёл), с отменой
  useEffect(
    () =>
      ready
        ? net.on('trap:apply', async ({ tokenId, amount, trap }) => {
            const o = store.col.obj.get(tokenId);
            if (!o || !(amount > 0)) return;
            const r = await changeHp(app, o, amount, false);
            if (r.line)
              toast(`Ловушка «${trap}»: урон ${amount}\n${r.line}`, 'info', 8000, {
                label: 'Отменить',
                onClick: () => [...r.undo].reverse().forEach((f) => f()),
              });
            else if (r.skip) toast(`Ловушка «${trap}»: урон ${amount} не снят — ${r.skip}`, 'error', 6000);
          })
        : undefined,
    [ready],
  );

  // --- доска ---
  useEffect(() => {
    if (!ready || !boardEl.current) return;
    const board = new Board(boardEl.current, store, net, {
      openCharacter: (id) => app.openCharacter(id),
      openTokenSettings: (id) => app.openTokenSettings(id),
      prompt: (o) => promptDialog(o),
      upload: (files) => app.upload(files),
      error: (m) => toast(m, 'error'),
      notify: (m) => toast(m, 'ok'),
      onCamera: () => store.emit('camera'),
      contextMenu: (x, y, objs, pos) => openContextMenu(x, y, tokenContextMenu(app, objs, pos)),
      setBar: (objId, barId, text) => applyBarInput(app, objId, barId, text),
      openPin: (pin) => app.openPin(pin),
      openPinSettings: (id) => app.openPinSettings(id),
    });
    boardRef.current = board;
    window.__board = board;
    // брошенные кубики катятся по доске (или короткая плоская анимация в углу)
    const offDice = store.on('chat', (m) => {
      if (Date.now() - (m.ts || 0) > 15000) return;
      const who = store.members.get(m.playerId);
      showRoll(boardEl.current?.parentElement, m, who?.color || m.color || '#7a2e2e', who?.dice?.skin);
    });
    return () => {
      offDice();
      disposeDice3d();
      board.destroy();
      boardRef.current = null;
    };
  }, [ready]);

  if (fatal)
    return (
      <div class="game-fatal">
        <h1>Стол недоступен</h1>
        <p>{fatal}</p>
        <button class="btn btn-primary" onClick={() => navigate('/')}>
          Вернуться к списку столов
        </button>
      </div>
    );

  return (
    <AppCtx.Provider value={app}>
      <div class={'game ' + (store.isGM ? 'is-gm' : 'is-player') + (boot ? ' theme-boot' : '')} data-theme={theme}>
        {!ready ? (
          <Spinner label="Подключаемся к столу…" />
        ) : (
          <>
            <TopBar status={status} />
            <div class="g-main">
              <Toolbar />
              <div class="g-board-wrap">
                <ThemeDecor theme={theme} />
                <div class="board-host" ref={boardEl} />
                <MarkerHud />
                <BoardHud />
                <CineLayer />
                <VideoDock />
                <GmStart />
                <CineDock />
              </div>
              <Sidebar sheetVersion={sheetVersion} />
            </div>
            <MacroBar />
            {wins.map((w) => (
              <Win key={w.key} w={w} sheetVersion={sheetVersion} />
            ))}
            <RollTooltip />
          </>
        )}
      </div>
    </AppCtx.Provider>
  );
}

/** Пульт кинотрюков мастера (открывается кнопкой на панели инструментов) */
function CineDock() {
  const app = useContextApp();
  const { store } = app;
  useStoreEvents(store, ['ui:cine']);
  if (!store.isGM || !store.ui.cineOpen) return null;
  return (
    <CinePanel
      onClose={() => {
        store.ui.cineOpen = false;
        store.emit('ui:cine');
      }}
    />
  );
}

/** «Ваш ход!» — когда очередь доходит до токена игрока */
let lastTurnKey = null;
function notifyTurn(store) {
  const first = store.state.turnorder?.[0];
  const key = first ? `${first.id}|${store.state.round || 1}` : null;
  if (key === lastTurnKey) return;
  const prevKey = lastTurnKey;
  lastTurnKey = key;
  if (!first || prevKey === null || store.isGM || !first.tokenId) return;
  if (store.state.turnorder.length < 2 && prevKey === '') return;
  const o = store.col.obj.get(first.tokenId);
  if (!o || !store.canControlObj(o)) return;
  toast(`Ваш ход: ${o.name || 'ваш токен'}`, 'ok', 5000);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.15 * getUserVolume()), ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => ctx.close();
  } catch {
    /* звук недоступен */
  }
}

function Win({ w, sheetVersion }) {
  switch (w.type) {
    case 'char':
      return <CharacterWindow key={w.key + sheetVersion} winKey={w.key} charId={w.props.charId} tab={w.props.tab} t={w.t} />;
    case 'handout':
      return <HandoutWindow winKey={w.key} id={w.props.id} />;
    case 'token':
      return <TokenSettings winKey={w.key} id={w.props.id} tab={w.props.tab} t={w.t} />;
    case 'page':
      return <PageSettings winKey={w.key} id={w.props.id} />;
    case 'turn':
      return <TurnTracker winKey={w.key} />;
  }
  return null;
}

function TopBar({ status }) {
  const app = useContextApp();
  const { store } = app;
  useStoreEvents(store, ['members', 'game', 'voice']);
  const members = [...store.members.values()];
  return (
    <header class="g-top">
      <button type="button" class="g-back" onClick={() => navigate('/')} title="К списку столов">
        <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden="true">
          <path d="M32 5 56 19v26L32 59 8 45V19Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" />
        </svg>
        <span class="g-title">{store.game?.name}</span>
      </button>
      <SceneBar />
      <div class="g-players">
        {status !== 'connected' && <span class="conn-warn">{status === 'disconnected' ? 'Нет связи, переподключаемся…' : 'Подключение…'}</span>}
        <VoiceControls />
        {members.map((m) => (
          <PlayerChip key={m.id} m={m} />
        ))}
        <IconButton icon="clock" title="Порядок ходов" onClick={() => app.toggleTurnTracker()} />
        <IconButton icon="info" title="Справка: клавиши и команды" onClick={() => showModal((close) => <HelpModal gm={store.isGM} onClose={close} />)} />
      </div>
    </header>
  );
}

const HELP = [
  [
    'Карта',
    [
      ['Колесо мыши, щипок', 'масштаб'],
      ['Пробел + перетаскивание, средняя кнопка, «рука» (H)', 'сдвиг карты'],
      ['Долгое нажатие на пустом месте', 'пинг (мастер с Shift — перенести всех к точке)'],
      ['V / H / R / D', 'выбор, рука, линейка, рисование'],
      ['Правая кнопка по токену', 'меню: настройки, маркеры, бары, ход, слой, размер'],
      ['Двойной щелчок по токену', 'лист персонажа или настройки токена'],
      ['Кружки над выделенным токеном', 'ввести 12, -7 или +3, чтобы изменить бар'],
      ['Стрелки (с Shift — точно)', 'сдвинуть выделенное'],
      ['Пробел во время перетаскивания токена', 'точка поворота пути; расстояние видно всем'],
      ['Ctrl+Z / Ctrl+Y', 'отмена и повтор (и для тумана)'],
      ['Ctrl+C / Ctrl+V / Ctrl+D, Delete', 'копировать, вставить, дублировать, удалить'],
      ['Alt при перетаскивании', 'без привязки к сетке'],
      ['Метка на карте', 'щелчок — открыть заметку или материал (мастер: двойной щелчок — настройки)'],
    ],
  ],
  [
    'Линейка и области',
    [
      ['Пробел или правая кнопка во время измерения', 'точка поворота'],
      ['Круг, конус, куб, луч', 'шаблоны заклинаний — выбираются в настройках линейки'],
    ],
  ],
  [
    'Чат',
    [
      ['/r 1d20+5, /roll', 'бросок; [[2d6+3]] — бросок прямо в тексте'],
      ['/gr 1d20', 'бросок, который видит только мастер'],
      ['/w Имя текст, /w gm текст', 'шёпот игроку, персонажу или мастеру'],
      ['/em текст, /ooc текст', 'действие, реплика вне игры'],
      ['/desc, /as "Имя", /emas "Имя"', 'описание и речь от чужого имени (мастер)'],
      ['?{Вопрос|по умолчанию}', 'запрос значения при броске'],
      ['@{selected|hp}, @{target|ac}', 'атрибуты выбранного или указанного токена'],
      ['%{Персонаж|атака}, #макрос', 'способности и макросы'],
      ['↑ в поле ввода', 'повторить прошлое сообщение'],
      ['Щелчок по числу броска', 'урон, половина, двойной урон или лечение выделенным токенам (с отменой)'],
      ['Смайлик в углу сообщения, ☺ у поля ввода', 'реакция на сообщение или над своим токеном'],
      ['/итоги, /итоги всё', 'итоги вечера или всей кампании: награды и статистика бросков'],
      ['«Настройки» → «Мои кубики»', 'свой набор кубиков и эффект, с которым бросок прилетает в чат'],
    ],
  ],
  [
    'Мастеру',
    [
      ['Хлопушка на панели инструментов', 'кинотрюки: титры, рассказчик, затемнение, кинополосы, тряска, вспышка, камера'],
      ['/титры Заголовок | подзаголовок', 'титры на весь стол; /рассказ текст — голос рассказчика'],
      ['/затемнение, /кино, /тряска сильно, /вспышка красная', 'затемнение и кинополосы (вкл/выкл), тряска, вспышка'],
      ['Журнал → «Бестиарий»', 'монстры SRD 5.2.1: поиск, статблок и сразу на карту нужным числом; свои — по ссылке с GitHub или из файла'],
      ['Вкладка «Статблок» у монстра', 'щелчок по названию действия — бросок в чат; можно сделать броски видимыми только мастеру'],
      ['Правый щелчок по карте → «Поставить ловушку здесь»', 'ловушка: срабатывает, когда ход сделан — токен отпустили на ней или провели через неё'],
      ['Правый щелчок по фигуре → «Сделать ловушкой»', 'ловушкой может быть любая фигура или картинка'],
    ],
  ],
  [
    'Если компьютер греется',
    [
      ['Главное меню → «Режим чайника», или «Настройки» → «Для меня»', 'кубики плоские, оформление без анимации, без эффектов бросков, погода и спецэффекты легче; всё остальное работает как обычно'],
      ['Больше всего видеокарту грузят', 'анимированное оформление, погода, анимированные карты и токены (GIF, видео), видео собеседников'],
    ],
  ],
  [
    'Голосовой чат',
    [
      ['Кнопка «Голос» вверху', 'подключиться: микрофон, камера, звук собеседников'],
      ['M', 'выключить или включить микрофон'],
      ['Щелчок по аватару участника', 'громкость этого участника у вас'],
    ],
  ],
];

// адрес исходного кода этой сборки (vite.config.js), пусто — не показываем
const SOURCE_URL = typeof __TAVERNA_SOURCE__ === 'string' ? __TAVERNA_SOURCE__ : '';

function HelpModal({ onClose }) {
  return (
    <Modal title="Справка" onClose={onClose} width={640}>
      {HELP.map(([title, rows]) => (
        <section class="help-sec">
          <h3 class="sect-h">{title}</h3>
          <table class="plain help-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr>
                  <td class="help-key">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <p class="small muted">Кнопку броска из листа можно перетащить на панель макросов внизу экрана.</p>
      <p class="small muted">
        Таверна — свободная программа под лицензией GNU AGPL-3.0
        {SOURCE_URL ? (
          <>
            {': '}
            <a href={SOURCE_URL} target="_blank" rel="noopener">
              исходный код
            </a>
          </>
        ) : null}
        .{' '}
        <a href="/licenses.txt" target="_blank" rel="noopener">
          Сторонние компоненты и их лицензии
        </a>
      </p>
    </Modal>
  );
}

function BoardHud() {
  const app = useContextApp();
  const b = () => app.board();
  const { store } = app;
  // «Мой токен»: по очереди центрирует камеру на своих токенах текущей сцены
  const findMine = () => {
    const mine = store.objsOnPage().filter((o) => o.type !== 'wall' && o.layer === 'objects' && (o.represents || (o.controlledBy || []).length) && (store.isGM ? false : store.canControlObj(o)));
    const list = mine.length ? mine : store.isGM ? store.objsOnPage().filter((o) => o.layer === 'objects' && o.represents) : [];
    if (!list.length) return toast(store.isGM ? 'На сцене нет токенов персонажей' : 'На этой сцене нет ваших токенов', 'error');
    findMine.i = ((findMine.i ?? -1) + 1) % list.length;
    const o = list[findMine.i];
    b()?.centerOn(o.x + o.w / 2, o.y + o.h / 2);
    if (store.canControlObj(o)) store.setSelection([o.id]);
  };
  return (
    <div class="board-hud">
      <IconButton icon="target" title={store.isGM ? 'Показать токены персонажей по очереди' : 'Найти мой токен'} onClick={findMine} />
      <IconButton icon="zoomIn" title="Приблизить" onClick={() => b()?.zoomBy(1.25)} />
      <IconButton icon="zoomOut" title="Отдалить" onClick={() => b()?.zoomBy(0.8)} />
      <IconButton icon="map" title="Показать сцену целиком" onClick={() => b()?.fitPage()} />
    </div>
  );
}

function useContextApp() {
  return useContext(AppCtx);
}
