import { useState, useEffect, useRef } from 'preact/hooks';
import { api, uploadFiles } from '../api.js';
import { compressEnabled } from '../media/compress.js';
import { prepareUploads } from '../media/upload.js';
import { navigate } from '../App.jsx';
import { Button, IconButton, Modal, Field, Avatar, Spinner, Toggle, ColorInput, toast, showError, confirmDialog, promptDialog, showModal } from '../ui/components.jsx';
import { Icon } from '../ui/icons.jsx';
import { Backups, fmtBytes } from './Backups.jsx';
import { PhoneConnect } from '../ui/PhoneConnect.jsx';
import { copyInvite } from '../ui/invite.js';
import { teapot, setTeapot, onTeapot, TEAPOT_ON, TEAPOT_OFF, TEAPOT_HINT } from '../ui/teapot.js';
import './lobby.css';

// ---------------------------------------------------------------------------
// Вход и регистрация
// ---------------------------------------------------------------------------

export function AuthScreen({ onAuth, inviteCode }) {
  const [mode, setMode] = useState(inviteCode ? 'register' : 'login');
  const [cfg, setCfg] = useState({ allowRegistration: true });
  const [form, setForm] = useState({ username: '', password: '', password2: '', displayName: '', regCode: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/auth/config').then(setCfg).catch(() => {});
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (mode === 'register' && form.password !== form.password2) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      const d = await api.post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', form);
      onAuth(d.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="auth-screen">
      <div class="auth-brand">
        <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
          <path d="M32 5 56 19v26L32 59 8 45V19Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
          <path d="M32 5 21 30h22Zm-11 25L8 19m35 11 13-11M21 30l11 29 11-29M8 45l13-15m22 0 13 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity=".7" />
        </svg>
        <h1>Таверна</h1>
        <p>Стол для ролевых игр: карта, токены, кубики и листы персонажей Roll20.</p>
        {inviteCode && <p class="auth-invite">Вас пригласили за стол. Войдите или создайте аккаунт — и сразу окажетесь в игре.</p>}
      </div>
      <form class="auth-card" onSubmit={submit}>
        <div class="auth-switch" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} class={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
            Вход
          </button>
          {cfg.allowRegistration && (
            <button type="button" role="tab" aria-selected={mode === 'register'} class={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
              Регистрация
            </button>
          )}
        </div>
        <Field label="Логин">
          <input class="input" autoComplete="username" value={form.username} onInput={set('username')} required autoFocus />
        </Field>
        {mode === 'register' && (
          <Field label="Имя за столом" hint="Так вас увидят другие игроки">
            <input class="input" value={form.displayName} onInput={set('displayName')} placeholder="Например, Аня" />
          </Field>
        )}
        <Field label="Пароль">
          <input class="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onInput={set('password')} required minLength={mode === 'register' ? 6 : undefined} />
        </Field>
        {mode === 'register' && (
          <Field label="Пароль ещё раз">
            <input class="input" type="password" autoComplete="new-password" value={form.password2} onInput={set('password2')} required />
          </Field>
        )}
        {mode === 'register' && cfg.registrationCodeRequired && (
          <Field label="Код регистрации" hint="Его выдаёт администратор сервера">
            <input class="input" value={form.regCode} onInput={set('regCode')} required />
          </Field>
        )}
        {error && <p class="err">{error}</p>}
        <Button kind="primary" type="submit" disabled={busy} class="auth-submit">
          {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Лобби
// ---------------------------------------------------------------------------

export function LobbyScreen({ user, setUser }) {
  const [games, setGames] = useState(null);
  const [sheets, setSheets] = useState([]);

  const load = () =>
    api
      .get('/api/games')
      .then((d) => setGames(d.games))
      .catch(showError);
  const loadSheets = () =>
    api
      .get('/api/sheets')
      .then((d) => setSheets(d.sheets))
      .catch(showError);

  useEffect(() => {
    load();
    loadSheets();
  }, []);

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
  };

  const openProfile = () => showModal((close) => <ProfileModal user={user} onClose={close} onSaved={setUser} />);
  // сжатие загружаемых файлов — настройка аккаунта, действует на всех устройствах
  const compress = compressEnabled(user);
  const [compressBusy, setCompressBusy] = useState(false);
  // режим чайника — на этом устройстве (и сразу во всех открытых вкладках)
  const [pot, setPot] = useState(teapot);
  useEffect(() => onTeapot(setPot), []);
  const togglePot = () => {
    setTeapot(!pot);
    setPot(!pot);
    toast(!pot ? TEAPOT_ON : TEAPOT_OFF, 'ok', 7000);
  };
  const toggleCompress = async () => {
    setCompressBusy(true);
    try {
      const d = await api.patch('/api/auth/me', { settings: { compressUploads: !compress } });
      setUser(d.user);
      toast(
        !compress ? 'Сжатие включено: картинки загружаются в WebP, видео, анимации и музыка — в WebM' : 'Сжатие выключено: файлы загружаются как есть',
        'ok',
        5000,
      );
    } catch (e) {
      showError(e);
    } finally {
      setCompressBusy(false);
    }
  };
  const openSheets = () => showModal((close) => <SheetsModal onClose={() => (close(), loadSheets())} />);
  const openAdmin = () => showModal((close) => <AdminModal me={user} onClose={close} />);
  const openSettings = (g) => showModal((close) => <GameSettingsModal game={g} sheets={sheets} onClose={() => (close(), load())} openSheets={openSheets} />);
  const [demoBusy, setDemoBusy] = useState(false);
  const createDemo = async () => {
    setDemoBusy(true);
    try {
      const d = await api.post('/api/games/demo', {});
      navigate('/game/' + d.game.id);
    } catch (e) {
      showError(e);
      setDemoBusy(false);
    }
  };

  return (
    <div class="lobby">
      <header class="lobby-head">
        <div class="lobby-brand">
          <svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">
            <path d="M32 5 56 19v26L32 59 8 45V19Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" />
            <path d="M32 5 21 30h22Zm-11 25 11 29 11-29" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
          </svg>
          <span>Таверна</span>
        </div>
        <nav class="lobby-nav">
          <Button
            kind="ghost"
            icon="compress"
            class={'compress-btn' + (compress ? ' on' : '')}
            onClick={toggleCompress}
            disabled={compressBusy}
            aria-pressed={compress ? 'true' : 'false'}
            title={compress ? 'Файлы сжимаются перед загрузкой: картинки — в WebP, видео, анимации и музыка — в WebM. Нажмите, чтобы загружать как есть.' : 'Файлы загружаются как есть. Нажмите, чтобы сжимать их перед загрузкой.'}
          >
            Сжатие<span class="compress-wide"> файлов</span>: {compress ? 'вкл' : 'выкл'}
          </Button>
          <Button
            kind="ghost"
            icon="teapot"
            class={'teapot-btn' + (pot ? ' on' : '')}
            onClick={togglePot}
            aria-pressed={pot ? 'true' : 'false'}
            title={pot ? 'Включён режим чайника: Таверна бережёт видеокарту. Нажмите, чтобы вернуть всю красоту.' : TEAPOT_HINT}
          >
            <span class="compress-wide">Режим чайника</span>
            <span class="compress-narrow">Чайник</span>: {pot ? 'вкл' : 'выкл'}
          </Button>
          <Button kind="ghost" icon="scroll" onClick={openSheets}>
            Листы персонажей
          </Button>
          <Button kind="ghost" icon="phone" onClick={() => showModal((close) => <PhoneConnect onClose={close} />)} title="Адрес и QR-код, чтобы открыть стол с телефона">
            Телефон
          </Button>
          {user.isAdmin && (
            <Button kind="ghost" icon="key" onClick={openAdmin}>
              Администрирование
            </Button>
          )}
          <button type="button" class="lobby-user" onClick={openProfile} title="Профиль">
            <Avatar src={user.avatar} name={user.displayName} color={user.color} size={28} />
            <span>{user.displayName}</span>
          </button>
          <IconButton icon="logout" title="Выйти" onClick={logout} />
        </nav>
      </header>

      <main class="lobby-main">
        <section class="lobby-games" aria-labelledby="games-h">
          <h1 id="games-h">Ваши столы</h1>
          {games === null ? (
            <Spinner />
          ) : games.length === 0 ? (
            <div class="lobby-empty">
              <p>Здесь появятся столы, за которыми вы играете или которые ведёте.</p>
              <p class="muted">Создайте свой стол или войдите в чужой по коду приглашения от мастера.</p>
              <p class="muted">Хотите сначала осмотреться? Откройте готовый пример: подземелье с картой, светом, героем и гоблинами.</p>
              <Button kind="primary" icon="play" onClick={createDemo} disabled={demoBusy}>
                Открыть пример стола
              </Button>
            </div>
          ) : (
            <ul class="game-list">
              {games.map((g) => (
                <GameRow key={g.id} g={g} onSettings={() => openSettings(g)} onLeft={load} me={user} />
              ))}
            </ul>
          )}
        </section>

        <aside class="lobby-side">
          <JoinForm onJoined={(g) => navigate('/game/' + g.id)} />
          <CreateForm sheets={sheets} onCreated={(g) => navigate('/game/' + g.id)} openSheets={openSheets} createDemo={createDemo} demoBusy={demoBusy} />
          <ImportGame onImported={load} />
        </aside>
      </main>
    </div>
  );
}

function GameRow({ g, onSettings, onLeft, me }) {
  const leave = async () => {
    if (!(await confirmDialog({ title: 'Покинуть стол?', text: `Вы выйдете из «${g.name}». Вернуться можно по коду приглашения.`, okText: 'Покинуть', danger: true }))) return;
    try {
      await api.del(`/api/games/${g.id}/members/${me.id}`);
      onLeft();
    } catch (e) {
      showError(e);
    }
  };
  const gm = g.role === 'gm';
  return (
    <li class="game-row">
      <a class="game-thumb" href={'/game/' + g.id} onClick={(e) => (e.preventDefault(), navigate('/game/' + g.id))} aria-hidden="true" tabIndex={-1}>
        {g.thumbnail ? <img src={g.thumbnail} alt="" /> : <Icon name="map" size={34} stroke={1.2} />}
      </a>
      <div class="game-info">
        <div class="game-title">
          <h2>{g.name}</h2>
          <span class={'role-tag ' + (gm ? 'gm' : '')}>{gm ? 'Мастер' : 'Игрок'}</span>
        </div>
        {g.description && <p class="game-desc">{g.description}</p>}
        <NextSession g={g} />
        <div class="game-meta">
          <span class="game-sheet">
            <Icon name="scroll" size={15} />
            {g.sheet ? g.sheet.name : 'Без листа персонажа'}
          </span>
          <span class="game-members" aria-label="Участники">
            {g.members.slice(0, 8).map((m) => (
              <span class={'gm-av ' + (g.online.includes(m.id) ? 'online' : '')}>
                <Avatar src={m.avatar} name={m.displayName + (m.role === 'gm' ? ' (мастер)' : '')} color={m.color} size={24} />
              </span>
            ))}
            {g.members.length > 8 && <span class="faint small">+{g.members.length - 8}</span>}
          </span>
        </div>
      </div>
      <div class="game-actions">
        <Button kind="primary" icon="play" onClick={() => navigate('/game/' + g.id)}>
          Играть
        </Button>
        {gm ? <IconButton icon="cog" title="Настройки стола" onClick={onSettings} /> : <IconButton icon="logout" title="Покинуть стол" onClick={leave} />}
      </div>
    </li>
  );
}

function JoinForm({ onJoined }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await api.post('/api/games/join', { code });
      onJoined(d.game);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="side-block" onSubmit={submit}>
      <h2>Войти по коду</h2>
      <p class="muted small">Код из восьми символов выдаёт мастер стола.</p>
      <div class="row">
        <input class="input code-input" value={code} onInput={(e) => setCode(e.currentTarget.value.toUpperCase())} placeholder="Например, K7F29QXA" maxLength={12} required aria-label="Код приглашения" />
        <Button kind="primary" type="submit" disabled={busy || code.length < 6}>
          Войти
        </Button>
      </div>
    </form>
  );
}

function CreateForm({ sheets, onCreated, openSheets, createDemo, demoBusy }) {
  const [name, setName] = useState('');
  const [sheetId, setSheetId] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await api.post('/api/games', { name, sheetId: sheetId || null });
      onCreated(d.game);
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="side-block" onSubmit={submit}>
      <h2>Новый стол</h2>
      <Field label="Название">
        <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="Проклятие Страда" required maxLength={80} />
      </Field>
      <Field label="Лист персонажа">
        <select class="input" value={sheetId} onChange={(e) => setSheetId(e.currentTarget.value)}>
          <option value="">Без листа</option>
          {sheets.map((s) => (
            <option value={s.id}>{s.name}</option>
          ))}
        </select>
      </Field>
      <div class="row">
        <Button kind="primary" type="submit" disabled={busy || !name.trim()}>
          Создать стол
        </Button>
        <Button kind="ghost" size="sm" onClick={openSheets}>
          Добавить лист…
        </Button>
      </div>
      <p class="muted small demo-hint">
        Или{' '}
        <button type="button" class="linklike" onClick={createDemo} disabled={demoBusy}>
          создайте пример стола
        </button>{' '}
        — готовое подземелье, чтобы попробовать всё сразу.
      </p>
    </form>
  );
}

function ImportGame({ onImported }) {
  const ref = useRef();
  const pick = async (e) => {
    const f = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      await api.post('/api/games/import', data);
      toast('Стол импортирован', 'ok');
      onImported();
    } catch (err) {
      showError(err);
    }
  };
  return (
    <div class="side-block side-quiet">
      <p class="muted small">Есть файл резервной копии стола? Загрузите его — появится новый стол.</p>
      <input type="file" accept=".json,application/json" ref={ref} hidden onChange={pick} />
      <Button size="sm" icon="upload" onClick={() => ref.current.click()}>
        Импорт стола из файла
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Настройки стола (мастер)
// ---------------------------------------------------------------------------

function GameSettingsModal({ game, sheets, onClose, openSheets }) {
  const [g, setG] = useState(game);
  const [name, setName] = useState(game.name);
  const [desc, setDesc] = useState(game.description || '');
  const [sheetId, setSheetId] = useState(game.sheet?.id || '');
  const [next, setNext] = useState(toLocalInput(game.nextSession));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const nextSession = next ? new Date(next).getTime() : null;
      const d = await api.patch('/api/games/' + g.id, { name, description: desc, sheetId: sheetId || null, nextSession });
      setG(d.game);
      toast('Сохранено', 'ok');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const regen = async () => {
    if (!(await confirmDialog({ title: 'Новый код приглашения?', text: 'Старый код перестанет работать. Уже вошедшие игроки останутся за столом.', okText: 'Сменить код' }))) return;
    try {
      const d = await api.post(`/api/games/${g.id}/invite`);
      setG({ ...g, inviteCode: d.inviteCode });
    } catch (e) {
      showError(e);
    }
  };
  const copy = () => {
    navigator.clipboard?.writeText(g.inviteCode).then(() => toast('Код скопирован', 'ok'));
  };
  const setRole = async (m, role) => {
    try {
      await api.patch(`/api/games/${g.id}/members/${m.id}`, { role });
      setG({ ...g, members: g.members.map((x) => (x.id === m.id ? { ...x, role } : x)) });
    } catch (e) {
      showError(e);
    }
  };
  const kick = async (m, ban) => {
    if (!(await confirmDialog({ title: ban ? 'Заблокировать игрока?' : 'Исключить игрока?', text: `${m.displayName} покинет стол${ban ? ' и не сможет вернуться по коду' : ''}.`, okText: ban ? 'Заблокировать' : 'Исключить', danger: true })))
      return;
    try {
      await api.del(`/api/games/${g.id}/members/${m.id}`, { ban });
      setG({ ...g, members: g.members.filter((x) => x.id !== m.id) });
    } catch (e) {
      showError(e);
    }
  };
  const del = async () => {
    const answer = await promptDialog({ title: 'Удалить стол навсегда?', label: `Все сцены, персонажи и чат будут удалены. Введите название стола «${g.name}», чтобы подтвердить.`, okText: 'Удалить' });
    if (answer === null) return;
    if (answer.trim() !== g.name) return toast('Название не совпало — стол не удалён', 'error');
    try {
      await api.del('/api/games/' + g.id);
      onClose();
    } catch (e) {
      showError(e);
    }
  };

  return (
    <Modal title="Настройки стола" onClose={onClose} width={620}>
      <Field label="Название">
        <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={80} />
      </Field>
      <Field label="Описание">
        <textarea class="input" rows={2} value={desc} onInput={(e) => setDesc(e.currentTarget.value)} />
      </Field>
      <Field label="Лист персонажа" hint="Смена листа не удаляет атрибуты персонажей, но новый лист может их не понимать.">
        <div class="row">
          <select class="input" value={sheetId} onChange={(e) => setSheetId(e.currentTarget.value)}>
            <option value="">Без листа</option>
            {sheets.map((s) => (
              <option value={s.id}>{s.name}</option>
            ))}
          </select>
          <Button size="sm" onClick={openSheets}>
            Библиотека
          </Button>
        </div>
      </Field>
      <Field label="Следующая игра" hint="Игроки увидят дату в лобби и смогут добавить её в календарь.">
        <div class="row">
          <input class="input" type="datetime-local" value={next} onInput={(e) => setNext(e.currentTarget.value)} style={{ maxWidth: '240px' }} />
          {next && (
            <Button size="sm" onClick={() => setNext('')}>
              Убрать
            </Button>
          )}
        </div>
      </Field>
      <div class="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="primary" onClick={save} disabled={busy}>
          Сохранить
        </Button>
      </div>

      <h3 class="sect-h">Приглашение</h3>
      <div class="invite-box">
        <code class="invite-code">{g.inviteCode}</code>
        <Button size="sm" icon="copy" onClick={copy}>
          Копировать
        </Button>
        <Button size="sm" icon="link" onClick={() => copyInvite(g.inviteCode, 'Ссылка-приглашение скопирована')}>
          Ссылка
        </Button>
        <Button size="sm" icon="refresh" onClick={regen}>
          Сменить код
        </Button>
      </div>

      <h3 class="sect-h">Участники</h3>
      <ul class="member-list">
        {g.members.map((m) => (
          <li>
            <Avatar src={m.avatar} name={m.displayName} color={m.color} size={28} />
            <span class="grow">{m.displayName}</span>
            {m.isOwner ? (
              <span class="role-tag gm">Создатель</span>
            ) : (
              <>
                <select class="input input-sm" style={{ width: '120px' }} value={m.role} onChange={(e) => setRole(m, e.currentTarget.value)} aria-label="Роль">
                  <option value="player">Игрок</option>
                  <option value="gm">Мастер</option>
                </select>
                <IconButton icon="logout" title="Исключить" onClick={() => kick(m, false)} />
                <IconButton icon="lock" title="Заблокировать" onClick={() => kick(m, true)} />
              </>
            )}
          </li>
        ))}
      </ul>

      <h3 class="sect-h">Данные</h3>
      <div class="row row-wrap">
        <a class="btn btn-default btn-sm" href={`/api/games/${g.id}/export`} download>
          <Icon name="download" size={15} />
          <span>Скачать резервную копию</span>
        </a>
        {g.isOwner && (
          <Button kind="danger" size="sm" icon="trash" onClick={del}>
            Удалить стол
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Библиотека листов персонажей
// ---------------------------------------------------------------------------

function SheetsModal({ onClose }) {
  const [list, setList] = useState(null);
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const fileRef = useRef();

  const load = () =>
    api
      .get('/api/sheets')
      .then((d) => setList(d.sheets))
      .catch(showError);
  useEffect(() => {
    load();
  }, []);

  const loadFolders = () => {
    if (folders.length) return;
    api
      .get('/api/sheets/github/list')
      .then((d) => setFolders(d.folders))
      .catch(() => {});
  };

  const importGh = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/sheets/github/import', { folder });
      toast('Лист импортирован', 'ok');
      setFolder('');
      load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (e) => {
    const files = [...e.currentTarget.files];
    e.currentTarget.value = '';
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    fd.append('name', uploadName || files.find((f) => /\.html?$/i.test(f.name))?.name.replace(/\.html?$/i, '') || 'Мой лист');
    setBusy(true);
    try {
      await api.post('/api/sheets/upload', fd);
      toast('Лист загружен', 'ok');
      load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (s) => {
    setBusy(true);
    try {
      await api.post(`/api/sheets/${s.id}/refresh`);
      toast('Лист обновлён с GitHub', 'ok');
      load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s) => {
    if (!(await confirmDialog({ title: 'Удалить лист?', text: s.name, okText: 'Удалить', danger: true }))) return;
    try {
      await api.del('/api/sheets/' + s.id);
      load();
    } catch (err) {
      showError(err);
    }
  };

  return (
    <Modal title="Листы персонажей" onClose={onClose} width={760}>
      <p class="muted small" style={{ marginTop: 0 }}>
        Подходят любые листы из репозитория{' '}
        <a href="https://github.com/Roll20/roll20-character-sheets" target="_blank" rel="noopener">
          Roll20/roll20-character-sheets
        </a>
        : формулы, кнопки бросков, шаблоны и sheet workers работают как в Roll20.
      </p>
      <div class="sheet-add">
        <form class="sheet-add-col" onSubmit={importGh}>
          <h3>Импорт с GitHub</h3>
          <Field label="Папка листа в репозитории" hint="Например: DD5thEditionLegacy или Pathfinder Second Edition by Roll20">
            <input class="input" list="gh-folders" value={folder} onFocus={loadFolders} onInput={(e) => setFolder(e.currentTarget.value)} required />
            <datalist id="gh-folders">
              {folders.map((f) => (
                <option value={f} />
              ))}
            </datalist>
          </Field>
          <Button kind="primary" type="submit" disabled={busy || !folder.trim()} icon="download">
            Импортировать
          </Button>
        </form>
        <div class="sheet-add-col">
          <h3>Свои файлы</h3>
          <Field label="Название листа">
            <input class="input" value={uploadName} onInput={(e) => setUploadName(e.currentTarget.value)} placeholder="Мой хоумбрю-лист" />
          </Field>
          <input ref={fileRef} type="file" multiple accept=".html,.htm,.css,.json" hidden onChange={upload} />
          <Button icon="upload" disabled={busy} onClick={() => fileRef.current.click()}>
            Выбрать HTML, CSS и JSON
          </Button>
          <p class="faint small">sheet.json, translation.json и переводы (ru.json и т. д.) — по желанию.</p>
        </div>
      </div>
      {list === null ? (
        <Spinner />
      ) : (
        <table class="plain sheet-table">
          <thead>
            <tr>
              <th>Лист</th>
              <th>Источник</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr>
                <td>
                  <div class="sheet-name">{s.name}</div>
                  <div class="sheet-tags">
                    {s.authors && <span class="faint small">{s.authors}</span>}
                    <span class="mini-tag">{s.legacy ? 'legacy' : 'CSE'}</span>
                    {s.languages.includes('ru') && <span class="mini-tag ok">русский перевод</span>}
                  </div>
                </td>
                <td class="small muted">{s.source === 'builtin' ? 'встроенный' : s.source === 'github' ? 'GitHub' : 'загружен'}</td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {s.source !== 'upload' && <IconButton icon="refresh" title="Обновить с GitHub" onClick={() => refresh(s)} />}
                  {!s.builtin && <IconButton icon="trash" title="Удалить" onClick={() => remove(s)} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Профиль
// ---------------------------------------------------------------------------

function ProfileModal({ user, onClose, onSaved }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [color, setColor] = useState(user.color);
  const [avatar, setAvatar] = useState(user.avatar || '');
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const fileRef = useRef();

  const save = async () => {
    try {
      const body = { displayName, color, avatar };
      if (newPassword) Object.assign(body, { oldPassword, newPassword });
      const d = await api.patch('/api/auth/me', body);
      onSaved(d.user);
      toast('Профиль сохранён', 'ok');
      onClose();
    } catch (e) {
      showError(e);
    }
  };
  const uploadAvatar = async (e) => {
    const f = e.currentTarget.files[0];
    if (!f) return;
    try {
      const d = await uploadFiles(await prepareUploads([f], user), { folder: 'аватары' });
      setAvatar(d.assets[0].url);
    } catch (err) {
      showError(err);
    }
  };
  return (
    <Modal title="Профиль" onClose={onClose} width={460}>
      <div class="row" style={{ marginBottom: '14px' }}>
        <Avatar src={avatar} name={displayName} color={color} size={56} />
        <div class="grow">
          <input type="file" accept="image/*" hidden ref={fileRef} onChange={uploadAvatar} />
          <div class="row">
            <Button size="sm" icon="upload" onClick={() => fileRef.current.click()}>
              Загрузить аватар
            </Button>
            {avatar && (
              <Button size="sm" kind="ghost" onClick={() => setAvatar('')}>
                Убрать
              </Button>
            )}
          </div>
        </div>
      </div>
      <Field label="Имя за столом">
        <input class="input" value={displayName} onInput={(e) => setDisplayName(e.currentTarget.value)} maxLength={40} />
      </Field>
      <Field label="Цвет игрока" hint="Им подсвечиваются ваши пинги, линейка и выделение">
        <ColorInput value={color} onChange={setColor} allowTransparent={false} />
      </Field>
      <h3 class="sect-h">Сменить пароль</h3>
      <Field label="Текущий пароль">
        <input class="input" type="password" value={oldPassword} onInput={(e) => setOld(e.currentTarget.value)} autoComplete="current-password" />
      </Field>
      <Field label="Новый пароль">
        <input class="input" type="password" value={newPassword} onInput={(e) => setNew(e.currentTarget.value)} autoComplete="new-password" />
      </Field>
      <div class="modal-actions">
        <Button onClick={onClose}>Отмена</Button>
        <Button kind="primary" onClick={save}>
          Сохранить
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Администрирование
// ---------------------------------------------------------------------------

/** ms → значение для <input type="datetime-local"> в местном времени */
function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** «через 3 дня», «завтра», «сегодня в 19:00» */
function relDay(ms) {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const n = Math.round((day - today) / 86400000);
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n === 2) return 'послезавтра';
  const m10 = n % 10,
    m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня' : 'дней';
  return `через ${n} ${w}`;
}

/** Файл календаря (.ics) для следующей игры */
function icsFor(g) {
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (t) => String(t || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const url = `${location.origin}/game/${g.id}`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Taverna//RU',
    'BEGIN:VEVENT',
    `UID:${g.id}-${g.nextSession}@taverna`,
    `DTSTAMP:${fmt(Date.now())}`,
    `DTSTART:${fmt(g.nextSession)}`,
    `DTEND:${fmt(g.nextSession + 4 * 3600000)}`,
    `SUMMARY:${esc(g.name)}`,
    `DESCRIPTION:${esc('Стол: ' + url)}`,
    `URL:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function NextSession({ g }) {
  if (!g.nextSession || g.nextSession < Date.now() - 6 * 3600000) return null;
  const d = new Date(g.nextSession);
  const when = d.toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const download = () => {
    const url = URL.createObjectURL(new Blob([icsFor(g)], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'game.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return (
    <p class="next-session">
      <Icon name="clock" size={15} />
      <span>
        Следующая игра: <strong>{when}</strong> <span class="faint">({relDay(g.nextSession)})</span>
      </span>
      <button type="button" class="linklike small" onClick={download}>
        в календарь
      </button>
    </p>
  );
}

function AdminModal({ me, onClose }) {
  const [users, setUsers] = useState(null);
  const [stats, setStats] = useState(null);
  const load = () => {
    api.get('/api/admin/users').then((d) => setUsers(d.users)).catch(showError);
    api.get('/api/admin/stats').then(setStats).catch(showError);
  };
  useEffect(load, []);
  const patch = async (u, body) => {
    try {
      await api.patch('/api/admin/users/' + u.id, body);
      load();
    } catch (e) {
      showError(e);
    }
  };
  const resetPw = async (u) => {
    const pw = await promptDialog({ title: `Новый пароль для ${u.username}`, label: 'Не короче 6 символов. Все сессии пользователя будут завершены.', okText: 'Сменить' });
    if (pw) patch(u, { password: pw });
  };
  return (
    <Modal title="Администрирование" onClose={onClose} width={820}>
      {stats && (
        <p class="muted small" style={{ marginTop: 0 }}>
          Пользователей: {stats.users}, столов: {stats.games}, листов: {stats.sheets}, файлов: {stats.assets} ({fmtBytes(stats.storage)}), база: {fmtBytes(stats.dbSize)}. Сейчас играют: {stats.activeRooms.filter((r) => r.online).length} стол(а).
        </p>
      )}
      {!users ? (
        <Spinner />
      ) : (
        <table class="plain">
          <thead>
            <tr>
              <th>Логин</th>
              <th>Имя</th>
              <th>Столов</th>
              <th>Файлы</th>
              <th>Админ</th>
              <th>Блок</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                <td>{u.games}</td>
                <td class="small">{fmtBytes(u.storage)}</td>
                <td>
                  <Toggle checked={u.isAdmin} disabled={u.id === me.id} onChange={(v) => patch(u, { isAdmin: v })} />
                </td>
                <td>
                  <Toggle checked={u.disabled} disabled={u.id === me.id} onChange={(v) => patch(u, { disabled: v })} />
                </td>
                <td>
                  <Button size="sm" onClick={() => resetPw(u)}>
                    Пароль
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Backups />
    </Modal>
  );
}
