import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp } from '../hooks.js';
import { api } from '../../api.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, IconButton, Spinner, openContextMenu, confirmDialog, promptDialog, showError, toast } from '../../ui/components.jsx';

function fmtBytes(n) {
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' КБ';
  return (n / 1024 / 1024).toFixed(1) + ' МБ';
}

export function ArtPanel() {
  const app = useApp();
  const { store } = app;
  const [assets, setAssets] = useState(null);
  const [usage, setUsage] = useState(null);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');
  const [drag, setDrag] = useState(false);
  const fileRef = useRef();

  const load = () =>
    api
      .get('/api/assets?gameId=' + encodeURIComponent(store.gameId))
      .then((d) => {
        setAssets(d.assets.filter((a) => a.kind !== 'audio'));
        setUsage({ used: d.used, quota: d.quota });
      })
      .catch(showError);
  useEffect(() => {
    load();
    return store.on('assets:changed', load);
  }, []);

  const upload = async (files) => {
    const list = [...files].filter((f) => /^(image|video)\//.test(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|webm|mp4|m4v|mov|mkv)$/i.test(f.name));
    if (!list.length) return toast('Подходят картинки (PNG, JPG, GIF, WebP) и видео (WebM, MP4, MOV)', 'error');
    await app.upload(list, folder);
  };

  const fetchUrl = async () => {
    const url = await promptDialog({ title: 'Картинка по ссылке', label: 'Адрес картинки или видео (https://…)', placeholder: 'https://…/map.jpg' });
    if (!url) return;
    try {
      toast('Скачиваем…');
      const d = await api.post('/api/assets/fetch', { url, gameId: store.gameId, folder });
      toast(`Добавлено: ${d.asset.name}`, 'ok');
      load();
    } catch (e) {
      showError(e);
    }
  };

  const folders = [...new Set((assets || []).map((a) => a.folder).filter(Boolean))].sort();
  const shown = (assets || []).filter((a) => (!folder || a.folder === folder) && (!q || a.name.toLowerCase().includes(q.toLowerCase())));

  const menu = (e, a) => {
    e.preventDefault();
    const mine = a.ownerId === store.me.id;
    const items = [
      {
        label: 'Поставить на карту в центр',
        icon: 'map',
        action: () => {
          const b = app.board();
          if (!b) return;
          const c = b.screenToWorld(b.W / 2, b.H / 2);
          b.placeImage(a, c);
        },
      },
    ];
    if (store.isGM)
      items.push({
        label: 'Сделать фоном сцены',
        icon: 'image',
        action: () => {
          const b = app.board();
          const page = store.page;
          if (!b || !page) return;
          const W = page.width * page.cellSize,
            H = page.height * page.cellSize;
          b.createObj({ type: 'image', src: a.url, name: a.name, x: 0, y: 0, w: W, h: H, layer: 'map', locked: true });
        },
      });
    if (store.isGM && a.kind === 'image')
      items.push({
        label: 'Показать игрокам',
        icon: 'eye',
        action: async () => {
          // картинка становится материалом журнала и сразу открывается у всех
          const { net } = app;
          let h = [...store.col.handout.values()].find((x) => x.avatar === a.url);
          if (!h) {
            const r = await net.create('handout', { name: a.name || 'Картинка', avatar: a.url, inJournals: ['all'], folder: 'Показано игрокам' });
            if (r?.error) return showError(new Error(r.error));
            h = store.col.handout.get(r.id);
          } else if (!(h.inJournals || []).includes('all')) await net.update('handout', h.id, { inJournals: [...(h.inJournals || []), 'all'] });
          if (h) {
            net.request('handout:show', { handoutId: h.id });
            app.openHandout(h.id);
            toast('Картинка показана игрокам', 'ok');
          }
        },
      });
    items.push({ label: 'Копировать ссылку', icon: 'link', action: () => navigator.clipboard?.writeText(location.origin + a.url).then(() => toast('Ссылка скопирована', 'ok')) });
    if (mine) {
      items.push(
        {
          label: 'Переименовать',
          icon: 'pencil',
          action: async () => {
            const n = await promptDialog({ title: 'Название', value: a.name });
            if (n) api.patch('/api/assets/' + a.id, { name: n }).then(load).catch(showError);
          },
        },
        {
          label: 'В папку…',
          icon: 'folder',
          action: async () => {
            const n = await promptDialog({ title: 'Папка', value: a.folder || '' });
            if (n !== null) api.patch('/api/assets/' + a.id, { folder: n }).then(load).catch(showError);
          },
        },
        '-',
        {
          label: 'Удалить файл',
          icon: 'trash',
          danger: true,
          action: async () => {
            if (await confirmDialog({ title: 'Удалить файл?', text: 'Объекты на картах, использующие его, покажут пустую картинку.', okText: 'Удалить', danger: true }))
              api.del('/api/assets/' + a.id).then(load).catch(showError);
          },
        },
      );
    }
    openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div
      class={'panel art-panel ' + (drag ? 'dragover' : '')}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDrag(false);
        upload(e.dataTransfer.files);
      }}
    >
      <div class="panel-head">
        <div class="row">
          <input type="file" multiple accept="image/*,video/*" hidden ref={fileRef} onChange={(e) => (upload(e.currentTarget.files), (e.currentTarget.value = ''))} />
          <Button size="sm" kind="primary" icon="upload" onClick={() => fileRef.current.click()}>
            Загрузить
          </Button>
          <IconButton icon="link" title="Скачать картинку по ссылке" onClick={fetchUrl} />
          <div class="search-box grow">
            <Icon name="search" size={15} />
            <input class="input input-sm" placeholder="Поиск" value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label="Поиск картинок" />
          </div>
        </div>
        {folders.length > 0 && (
          <div class="row row-wrap folder-chips">
            <button type="button" class={'chip ' + (!folder ? 'on' : '')} onClick={() => setFolder('')}>
              Все
            </button>
            {folders.map((f) => (
              <button type="button" class={'chip ' + (folder === f ? 'on' : '')} onClick={() => setFolder(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
        <p class="faint small" style={{ margin: '4px 0 0' }}>
          Перетащите картинку на карту. GIF, WebP и видео анимируются. {usage && (usage.quota > 0 ? `Занято ${fmtBytes(usage.used)} из ${fmtBytes(usage.quota)}.` : `Ваши файлы: ${fmtBytes(usage.used)}.`)}
        </p>
      </div>
      <div class="panel-scroll">
        {assets === null ? (
          <Spinner />
        ) : !shown.length ? (
          <p class="empty">Перетащите сюда файлы или нажмите «Загрузить».</p>
        ) : (
          <div class="art-grid">
            {shown.map((a) => (
              <div
                class="art-item"
                draggable={true}
                title={a.name}
                onDragStart={(e) => e.dataTransfer.setData('application/x-taverna', JSON.stringify({ kind: 'asset', url: a.url, name: a.name, width: a.width, height: a.height }))}
                onContextMenu={(e) => menu(e, a)}
                onDblClick={(e) => menu(e, a)}
              >
                {a.kind === 'video' ? <video src={a.url} muted loop autoplay playsInline /> : <img src={a.url} alt={a.name} loading="lazy" />}
                <span class="art-name">{a.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
