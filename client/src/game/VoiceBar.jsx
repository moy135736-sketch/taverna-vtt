// Голосовой и видеочат: кнопки в верхней панели, значки участников, окошки видео
import { useState, useEffect, useRef, useReducer } from 'preact/hooks';
import { AppCtx, useApp, useStoreEvents } from './hooks.js';
import { Icon } from '../ui/icons.jsx';
import { Avatar, IconButton, Modal, Field, showModal, toast, showError } from '../ui/components.jsx';

/** Перерисовка по событиям голосового чата */
function useVoice(voice, events = ['change']) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const offs = events.map((ev) => voice.on(ev, force));
    return () => offs.forEach((o) => o());
  }, [voice]);
}

/** Кнопки голосового чата в верхней панели */
export function VoiceControls() {
  const app = useApp();
  const { voice, store } = app;
  useVoice(voice);
  useStoreEvents(store, ['voice', 'snapshot']);
  const [busy, setBusy] = useState(false);

  useEffect(() => voice.on('notice', (m) => toast(m)), [voice]);
  // M — выключить/включить микрофон (когда фокус не в поле ввода)
  useEffect(() => {
    const k = (e) => {
      if (voice.state !== 'on' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target;
      const tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
      if (e.code === 'KeyM') {
        e.preventDefault();
        voice.setMuted(!voice.muted);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [voice]);

  if (!store.features?.voice || !voice.supported) return null;
  // по http:// (не localhost) браузер не даёт микрофон: объяснить и предложить https:// того же стола
  const insecure = !voice.canCapture && !window.isSecureContext;
  const explainInsecure = (onListen) =>
    showModal((close) => <InsecureVoice close={close} samePort={!!store.features.secureSamePort} onListen={onListen && (() => (close(null), onListen()))} />);
  const inVoice = store.voiceRoster.length;

  if (voice.state === 'off') {
    const join = async () => {
      setBusy(true);
      try {
        await voice.join();
      } catch (e) {
        showError(e);
      } finally {
        setBusy(false);
      }
    };
    return (
      <button type="button" class="voice-join" onClick={insecure ? () => explainInsecure(join) : join} disabled={busy} title="Голосовой чат стола: говорить и слушать прямо здесь">
        <Icon name="headphones" size={17} />
        <span>Голос</span>
        {inVoice > 0 && (
          <b class="voice-count" title={`Сейчас в голосовом чате: ${inVoice}`}>
            {inVoice}
          </b>
        )}
      </button>
    );
  }

  const noMic = !voice.micTrack();
  const toggleCam = async () => {
    try {
      await voice.setVideo(!voice.camera);
    } catch (e) {
      showError(e);
    }
  };
  return (
    <div class={'voice-ctl ' + voice.state} role="group" aria-label="Голосовой чат">
      {voice.state !== 'on' && <span class="voice-status">{voice.state === 'reconnecting' ? 'Переподключение…' : 'Подключение…'}</span>}
      <IconButton
        icon={voice.muted || noMic ? 'micOff' : 'mic'}
        class={voice.muted || noMic ? 'off' : 'live'}
        title={noMic ? voice.micError || 'Микрофон выключен' : voice.muted ? 'Включить микрофон (M)' : 'Выключить микрофон (M)'}
        onClick={() => (noMic && insecure ? explainInsecure(null) : voice.setMuted(!(voice.muted || noMic)))}
      />
      <IconButton icon={voice.camera ? 'video' : 'videoOff'} class={voice.camera ? 'live' : 'off'} title={voice.camera ? 'Выключить камеру' : 'Включить камеру'} onClick={toggleCam} />
      <IconButton icon={voice.deaf ? 'headphonesOff' : 'headphones'} class={voice.deaf ? 'off' : ''} title={voice.deaf ? 'Включить звук собеседников' : 'Выключить звук собеседников'} onClick={() => voice.setDeaf(!voice.deaf)} />
      <IconButton icon="cog" class="voice-devices" title="Микрофон и камера" onClick={() =>
          showModal((close) => (
            <AppCtx.Provider value={app}>
              <VoiceDevices onClose={close} />
            </AppCtx.Provider>
          ))
        }
      />
      <IconButton icon="hangup" class="voice-leave" title="Выйти из голосового чата" onClick={() => voice.leave()} />
    </div>
  );
}

/** Почему по http:// нет микрофона, и ссылка на https:// того же стола; можно войти и только слушать */
function InsecureVoice({ close, samePort, onListen }) {
  const secureUrl = 'https://' + location.host + location.pathname + location.search;
  return (
    <Modal title="Микрофон — только по защищённому адресу" onClose={() => close(null)} width={470}>
      <p>Браузер даёт доступ к микрофону и камере только на защищённых адресах — тех, что начинаются с https://. Слушать других можно и так.</p>
      {samePort ? (
        <>
          <p>
            Этот стол открывается и по защищённому адресу: <b class="code-pill">{secureUrl}</b>
          </p>
          <p class="muted small">
            Браузер предупредит, что сертификат самоподписанный: для домашнего сервера это нормально. Нажмите «Дополнительно» → «Перейти на сайт» — вход и
            столы останутся те же.
          </p>
        </>
      ) : (
        <p class="muted small">Попросите владельца сервера включить https — в инструкции по установке это один шаг.</p>
      )}
      <div class="modal-actions">
        {onListen ? (
          <button type="button" class="btn btn-default" onClick={onListen}>
            <span>Только слушать</span>
          </button>
        ) : (
          <button type="button" class="btn btn-default" onClick={() => close(null)}>
            <span>Закрыть</span>
          </button>
        )}
        {samePort && (
          <a class="btn btn-primary" href={secureUrl}>
            <span>Открыть защищённый адрес</span>
          </a>
        )}
      </div>
    </Modal>
  );
}

/** Аватар участника в верхней панели: кто в голосовом чате, кто говорит, громкость */
export function PlayerChip({ m }) {
  const { voice, store } = useApp();
  useVoice(voice, ['change', 'speaking']);
  const [menu, setMenu] = useState(null);
  const entry = store.voiceRoster.find((r) => r.userId === m.id);
  const speaking = voice.speakingUsers().has(m.id);
  const peer = entry && voice.state === 'on' && entry.sid !== voice.sid ? voice.peers.get(entry.sid) : null;
  const failed = peer?.pc.connectionState === 'failed';
  const online = store.online.has(m.id);
  const isMe = m.id === store.me.id;
  const canTune = !!entry && !isMe && voice.state === 'on';
  const title = `${m.displayName}${m.role === 'gm' ? ' — мастер' : ''}${online ? '' : ' (не в сети)'}${entry ? (entry.muted ? ' · в голосовом чате, микрофон выключен' : ' · в голосовом чате') : ''}${failed ? ' · нет соединения' : ''}${canTune ? ' — щёлкните, чтобы настроить громкость' : ''}`;
  const cls = 'g-player ' + (online ? 'on' : 'off') + (entry ? ' in-voice' : '') + (speaking ? ' speaking' : '') + (failed ? ' voice-failed' : '');
  const body = (
    <>
      <Avatar src={m.avatar} name={m.displayName} color={m.color} size={26} />
      {m.role === 'gm' && <i class="gm-badge">М</i>}
      {entry?.muted && (
        <i class="voice-badge" aria-hidden="true">
          <Icon name="micOff" size={10} stroke={2.4} />
        </i>
      )}
    </>
  );
  if (!canTune)
    return (
      <span class={cls} title={title} data-uid={m.id}>
        {body}
      </span>
    );
  return (
    <span class="g-player-wrap">
      <button type="button" class={cls + ' as-btn'} title={title} aria-label={title} data-uid={m.id} onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}>
        {body}
      </button>
      {menu && <VolumePopover m={m} rect={menu} onClose={() => setMenu(null)} />}
    </span>
  );
}

function VolumePopover({ m, rect, onClose }) {
  const { voice } = useApp();
  useVoice(voice);
  const ref = useRef();
  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.g-player-wrap') && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  const v = Math.round(voice.volumeOf(m.id) * 100);
  const left = Math.max(8, Math.min(window.innerWidth - 240, rect.left + rect.width / 2 - 116));
  return (
    <div class="voice-pop" ref={ref} style={{ left: left + 'px', top: rect.bottom + 8 + 'px' }} role="dialog" aria-label={`Громкость: ${m.displayName}`}>
      <div class="voice-pop-name">{m.displayName}</div>
      <label class="voice-vol">
        <Icon name={v === 0 ? 'mute' : 'volume'} size={16} />
        <input type="range" min="0" max="100" step="5" value={v} onInput={(e) => voice.setVolume(m.id, e.currentTarget.value / 100)} aria-label="Громкость" />
        <span class="voice-vol-n">{v}%</span>
      </label>
      <button type="button" class="linklike small" onClick={() => voice.setVolume(m.id, v === 0 ? 1 : 0)}>
        {v === 0 ? 'Вернуть звук' : 'Заглушить у себя'}
      </button>
    </div>
  );
}

/** Окошки видео участников с включённой камерой — в левом нижнем углу доски */
export function VideoDock() {
  const { voice, store } = useApp();
  useVoice(voice, ['change', 'speaking']);
  useStoreEvents(store, ['voice', 'members']);
  const [hidden, setHidden] = useState(false);
  const [big, setBig] = useState(null);
  if (voice.state === 'off') return null;
  const speaking = voice.speakingUsers();
  const tiles = voice.participants().filter((p) => p.video);
  if (!tiles.length) return null;
  return (
    <div class={'video-dock' + (hidden ? ' collapsed' : '')} aria-label="Видео участников">
      <button type="button" class="video-dock-toggle" onClick={() => setHidden(!hidden)} title={hidden ? 'Показать видео' : 'Свернуть видео'} aria-expanded={!hidden}>
        <Icon name={hidden ? 'video' : 'chevLeft'} size={15} />
        {hidden && <span>{tiles.length}</span>}
      </button>
      {!hidden &&
        tiles.map((p) => {
          const m = store.members.get(p.userId);
          return (
            <VideoTile
              key={p.sid}
              track={p.video}
              self={p.self}
              name={(m?.displayName || 'Участник') + (p.self ? ' (вы)' : '')}
              color={m?.color}
              speaking={speaking.has(p.userId) && !(p.self && voice.muted)}
              big={big === p.sid}
              onClick={() => setBig(big === p.sid ? null : p.sid)}
            />
          );
        })}
    </div>
  );
}

function VideoTile({ track, self, name, color, speaking, big, onClick }) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    el.srcObject = new MediaStream([track]);
    el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return (
    <button type="button" class={'video-tile' + (self ? ' self' : '') + (speaking ? ' speaking' : '') + (big ? ' big' : '')} style={{ '--c': color || '#c9a24a' }} onClick={onClick} title={big ? 'Уменьшить' : 'Увеличить'}>
      <video ref={ref} autoplay playsInline muted />
      <span class="video-name">{name}</span>
    </button>
  );
}

function VoiceDevices({ onClose }) {
  const { voice } = useApp();
  useVoice(voice);
  const [dev, setDev] = useState(null);
  const load = () => voice.devices().then(setDev);
  useEffect(() => {
    load();
  }, []);
  const label = (d, i, kind) => d.label || `${kind} ${i + 1}`;
  return (
    <Modal title="Микрофон и камера" onClose={onClose} width={460}>
      {!dev ? (
        <p class="muted">Ищем устройства…</p>
      ) : (
        <>
          <Field label="Микрофон">
            <select class="input" value={dev.mic} onChange={async (e) => (await voice.chooseMic(e.currentTarget.value), load())}>
              <option value="">По умолчанию</option>
              {dev.mics.map((d, i) => (
                <option value={d.deviceId}>{label(d, i, 'Микрофон')}</option>
              ))}
            </select>
          </Field>
          <Field label="Камера">
            <select class="input" value={dev.cam} onChange={async (e) => (await voice.chooseCam(e.currentTarget.value).catch(showError), load())}>
              <option value="">По умолчанию</option>
              {dev.cams.map((d, i) => (
                <option value={d.deviceId}>{label(d, i, 'Камера')}</option>
              ))}
            </select>
          </Field>
          {voice.micError && <p class="small voice-warn">{voice.micError}. Разрешите доступ к микрофону в настройках сайта (значок замка в адресной строке).</p>}
          <p class="small muted">
            Звук идёт напрямую между участниками. Если кого-то не слышно, мастеру стоит попросить администратора сервера включить TURN-сервер (см. README). Клавиша M — быстро выключить микрофон.
          </p>
        </>
      )}
    </Modal>
  );
}
