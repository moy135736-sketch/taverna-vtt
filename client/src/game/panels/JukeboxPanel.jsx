import { useState, useRef } from 'preact/hooks';
import { useApp, useStoreEvents } from '../hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, IconButton, confirmDialog, promptDialog, toast } from '../../ui/components.jsx';
import { getUserVolume } from '../jukebox.js';
import { api } from '../../api.js';

export function JukeboxPanel() {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:track', 'game']);
  const [vol, setVol] = useState(getUserVolume());
  const fileRef = useRef();
  const gm = store.isGM;
  const playing = store.state.jukebox?.playing || {};
  const tracks = [...store.col.track.values()].sort((a, b) => (a.playlist || '').localeCompare(b.playlist || '') || a.name.localeCompare(b.name));

  const setUserVol = (v) => {
    setVol(v);
    try {
      localStorage.setItem('tv:vol', String(v));
    } catch {
      /* ignore */
    }
    store.emit('volume');
  };

  const upload = async (e) => {
    const files = [...e.currentTarget.files];
    e.currentTarget.value = '';
    const assets = await app.upload(files, 'музыка');
    for (const a of assets) {
      if (a.kind !== 'audio' && a.kind !== 'video') continue;
      await net.create('track', { name: a.name, url: a.url, volume: 0.6, loop: true, playlist: '' });
    }
    if (assets.length) toast('Треки добавлены', 'ok');
  };

  const addUrl = async () => {
    const url = (await promptDialog({ title: 'Трек по ссылке', label: 'Прямая ссылка на MP3/OGG/WAV-файл' }))?.trim();
    if (!url) return;
    try {
      // сначала пробуем скачать на сервер: так трек не пропадёт, если исчезнет с чужого сайта
      toast('Скачиваем трек…');
      const d = await api.post('/api/assets/fetch', { url, gameId: store.gameId, folder: 'музыка' });
      if (d.asset.kind !== 'audio' && d.asset.kind !== 'video') return toast('По ссылке не аудиофайл', 'error');
      await net.create('track', { name: d.asset.name, url: d.asset.url, volume: 0.6, loop: true, playlist: '' });
      toast('Трек добавлен', 'ok');
    } catch (e) {
      if (await confirmDialog({ title: 'Не удалось скачать трек', text: `${e.message}. Добавить ссылку как есть? Тогда звук будет загружаться с чужого сайта у каждого игрока.`, okText: 'Добавить ссылку' }))
        await net.create('track', { name: safeDecode(url.split('/').pop() || '').slice(0, 60) || 'Трек', url, volume: 0.6, loop: true });
    }
  };

  const jb = (op) => net.request('jukebox', op).then((r) => r?.error && toast(r.error, 'error'));

  const groups = new Map();
  for (const t of tracks) {
    const g = t.playlist || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const pl = store.state.jukebox?.playlist || null;
  const plTrack = pl ? store.col.track.get(pl.queue[pl.index]) : null;

  return (
    <div class="panel jukebox-panel">
      <div class="panel-head">
        <label class="row vol-row">
          <Icon name={vol > 0 ? 'volume' : 'mute'} size={17} />
          <span class="small muted">Моя громкость</span>
          <input type="range" min={0} max={1} step={0.02} value={vol} class="grow" onInput={(e) => setUserVol(Number(e.currentTarget.value))} aria-label="Громкость" />
        </label>
        {gm && (
          <div class="row row-wrap">
            <input type="file" accept="audio/*,.mp3,.ogg,.oga,.opus,.wav,.m4a,.aac,.flac,.webm" multiple hidden ref={fileRef} onChange={upload} />
            <Button size="sm" kind="primary" icon="upload" onClick={() => fileRef.current.click()}>
              Загрузить музыку
            </Button>
            <Button size="sm" icon="link" onClick={addUrl}>
              По ссылке
            </Button>
            {Object.keys(playing).length > 0 && (
              <Button size="sm" icon="stop" onClick={() => jb({ action: 'stopAll' })}>
                Стоп всё
              </Button>
            )}
          </div>
        )}
      </div>
      {pl && (
        <div class="now-playing">
          <Icon name="music" size={16} />
          <div class="grow np-text">
            <div class="np-title">{plTrack?.name || '…'}</div>
            <div class="small muted">
              {pl.name || 'Без плейлиста'} · {pl.index + 1} из {pl.queue.length} · {pl.mode === 'shuffle' ? 'вперемешку' : 'по порядку'}
            </div>
          </div>
          {gm && (
            <>
              <IconButton icon="chevLeft" title="Предыдущий трек" size={16} onClick={() => jb({ action: 'prev' })} />
              <IconButton icon="chevRight" title="Следующий трек" size={16} onClick={() => jb({ action: 'next' })} />
              <IconButton icon="refresh" title={pl.repeat ? 'Повтор плейлиста включён' : 'Повтор плейлиста выключен'} active={pl.repeat} size={16} onClick={() => jb({ action: 'repeat', repeat: !pl.repeat })} />
              <IconButton icon="stop" title="Остановить плейлист" size={16} onClick={() => jb({ action: 'stop', trackId: pl.queue[pl.index] })} />
            </>
          )}
        </div>
      )}
      <div class="panel-scroll">
        {!tracks.length && <p class="empty small">{gm ? 'Загрузите треки — они будут играть у всех игроков синхронно. Можно включать несколько сразу: музыку и фоновый шум. Треки одной группы образуют плейлист.' : 'Мастер ещё не включал музыку.'}</p>}
        {[...groups].map(([g, list]) => (
          <div>
            {(g || groups.size > 1 || gm) && (
              <div class="pl-head">
                <h4 class="j-h grow">{g || 'Без плейлиста'}</h4>
                {gm && list.length > 1 && (
                  <>
                    <IconButton icon="play" title="Играть плейлист по порядку" size={15} onClick={() => jb({ action: 'playlist', playlist: g, mode: 'order', repeat: true })} />
                    <IconButton icon="shuffle" title="Играть плейлист вперемешку" size={15} onClick={() => jb({ action: 'playlist', playlist: g, mode: 'shuffle', repeat: true })} />
                  </>
                )}
              </div>
            )}
            <ul class="item-list">
              {list.map((t) => {
                const p = playing[t.id];
                return (
                  <li class={'item-row track-row ' + (p ? 'playing' : '')}>
                    {gm ? (
                      <button type="button" class="run-btn" title={p ? 'Остановить' : 'Играть у всех'} onClick={() => jb(p ? { action: 'stop', trackId: t.id } : { action: 'play', trackId: t.id })}>
                        <Icon name={p ? 'stop' : 'play'} size={14} />
                      </button>
                    ) : (
                      <span class="run-btn passive">{p ? <Icon name="volume" size={14} /> : <Icon name="music" size={14} />}</span>
                    )}
                    <span class="grow item-name">{t.name}</span>
                    {gm && (
                      <>
                        <IconButton icon="bolt" title="Сыграть один раз как звуковой эффект" size={15} onClick={() => net.request('sfx', { trackId: t.id })} />
                        <IconButton
                          icon="refresh"
                          title={t.loop ? 'Повтор включён' : 'Повтор выключен'}
                          active={t.loop}
                          size={15}
                          onClick={() => {
                            net.update('track', t.id, { loop: !t.loop });
                            if (p) jb({ action: 'play', trackId: t.id, loop: !t.loop });
                          }}
                        />
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={p?.volume ?? t.volume ?? 0.6}
                          title="Громкость трека"
                          class="track-vol"
                          onChange={(e) => {
                            const v = Number(e.currentTarget.value);
                            net.update('track', t.id, { volume: v });
                            if (p) jb({ action: 'volume', trackId: t.id, volume: v });
                          }}
                        />
                        <IconButton
                          icon="dots"
                          title="Ещё"
                          size={15}
                          onClick={async () => {
                            const name = await promptDialog({ title: 'Трек', label: 'Название', value: t.name });
                            if (name === null) return;
                            const pl = await promptDialog({ title: 'Плейлист', label: 'Группа (пусто — без группы)', value: t.playlist || '' });
                            net.update('track', t.id, { name: name || t.name, playlist: pl ?? t.playlist });
                          }}
                        />
                        <IconButton icon="trash" title="Удалить трек" size={15} onClick={async () => (await confirmDialog({ title: 'Удалить трек?', text: t.name, okText: 'Удалить', danger: true })) && net.remove('track', t.id)} />
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
