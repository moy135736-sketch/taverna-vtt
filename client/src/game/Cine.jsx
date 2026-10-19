// Кинотрюки мастера: титры, голос рассказчика, затемнение, кинополосы, тряска, вспышка, пролёт камеры.
// CineLayer показывает их всем поверх доски; CinePanel — пульт мастера.
import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, useStoreEvents } from './hooks.js';
import { Button, IconButton, toast } from '../ui/components.jsx';

const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Слой кинотрюков поверх доски (у всех за столом) */
export function CineLayer() {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['game']);
  const [title, setTitle] = useState(null);
  const [narr, setNarr] = useState(null);
  const [flash, setFlash] = useState(null);
  const root = useRef();

  useEffect(
    () =>
      net.on('cine', (ev) => {
        if (ev.kind === 'title') setTitle(ev);
        else if (ev.kind === 'narrate') setNarr(ev);
        else if (ev.kind === 'clear') {
          setTitle(null);
          setNarr(null);
        } else if (ev.kind === 'flash') setFlash(ev);
        else if (ev.kind === 'shake') {
          const wrap = root.current?.closest('.g-board-wrap');
          if (!wrap || reduced()) return;
          wrap.classList.remove('cine-shake', 'strong');
          void wrap.offsetWidth;
          wrap.classList.add('cine-shake');
          if (ev.strength === 'strong') wrap.classList.add('strong');
          setTimeout(() => wrap.classList.remove('cine-shake', 'strong'), 1100);
        } else if (ev.kind === 'camera') {
          if (ev.pageId === store.ui.pageId && ev.by !== store.me.id) app.board()?.flyTo(ev.x, ev.y, ev.zoom);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!title?.duration) return;
    const t = setTimeout(() => setTitle((c) => (c === title ? null : c)), title.duration * 1000);
    return () => clearTimeout(t);
  }, [title]);
  useEffect(() => {
    if (!narr) return;
    const t = setTimeout(() => setNarr((c) => (c === narr ? null : c)), narr.duration * 1000);
    return () => clearTimeout(t);
  }, [narr]);

  const st = store.state.cine || {};
  const gm = store.isGM;
  return (
    <div class="cine-layer" ref={root}>
      <div class={'cine-bars' + (st.bars || narr ? ' on' : '')} aria-hidden="true">
        <i />
        <i />
      </div>
      <div class={'cine-fade' + (st.fade ? ' on' : '') + (gm ? ' gm' : '')} aria-hidden={!st.fade}>
        {gm && st.fade && <span class="cine-fade-note">Игроки видят затемнение</span>}
      </div>
      {title && <TitleCard key={title.id} ev={title} gm={gm} onClose={() => setTitle(null)} />}
      {narr && <Narration key={narr.id} ev={narr} />}
      {flash && <div key={flash.id} class={'cine-flash ' + flash.color} onAnimationEnd={() => setFlash(null)} />}
    </div>
  );
}

function TitleCard({ ev, gm, onClose }) {
  const { net } = useApp();
  return (
    <div class={'cine-title' + (ev.image ? ' has-image' : '')} role="dialog" aria-label={ev.title || ev.subtitle} onClick={onClose}>
      {ev.image && <div class="cine-title-img" style={{ backgroundImage: `url("${ev.image.replace(/"/g, '%22')}")` }} />}
      <div class="cine-title-text">
        {ev.title && <h2>{ev.title}</h2>}
        {ev.subtitle && <p>{ev.subtitle}</p>}
      </div>
      <div class="cine-title-hint">
        {gm ? (
          <button
            type="button"
            class="link-btn"
            onClick={(e) => {
              e.stopPropagation();
              net.request('cine', { kind: 'clear' });
            }}
          >
            Убрать у всех
          </button>
        ) : (
          'Щелчок — скрыть'
        )}
      </div>
    </div>
  );
}

/** Голос рассказчика: субтитры внизу, буквы появляются по одной */
function Narration({ ev }) {
  const [n, setN] = useState(reduced() ? ev.text.length : 0);
  useEffect(() => {
    if (n >= ev.text.length) return;
    const t = setTimeout(() => setN((x) => Math.min(ev.text.length, x + 2)), 34);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <div class="cine-narr" role="status">
      <p>
        {ev.text.slice(0, n)}
        <span class="cine-narr-rest" aria-hidden="true">
          {ev.text.slice(n)}
        </span>
      </p>
    </div>
  );
}

/** Пульт мастера */
export function CinePanel({ onClose }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['game']);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [image, setImage] = useState('');
  const [duration, setDuration] = useState(6);
  const [text, setText] = useState('');
  const fileRef = useRef();
  const st = store.state.cine || {};
  const send = (p) => net.request('cine', p).then((r) => (r?.error ? toast(r.error, 'error') : r));
  const camera = () => {
    const b = app.board();
    if (!b) return;
    const c = b.screenToWorld(b.W / 2, b.H / 2);
    send({ kind: 'camera', pageId: store.ui.pageId, x: c.x, y: c.y, zoom: b.cam.z }).then((r) => r?.ok && toast('Камеры игроков летят к вашему виду', 'ok'));
  };
  const onDrop = (e) => {
    try {
      const d = JSON.parse(e.dataTransfer.getData('application/x-taverna') || 'null');
      if (d?.kind === 'asset' && d.url) {
        e.preventDefault();
        setImage(d.url);
      }
    } catch {
      /* не картинка из библиотеки */
    }
  };
  const upload = async (e) => {
    const files = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    if (!files.length) return;
    const a = await app.upload(files);
    if (a[0]) setImage(a[0].url);
  };
  return (
    <section class="cine-panel" aria-label="Кинотрюки">
      <header class="cine-panel-h">
        <h3>Кинотрюки</h3>
        <IconButton icon="x" size={16} title="Закрыть пульт" onClick={onClose} />
      </header>

      <form
        class="cine-sec"
        onSubmit={(e) => {
          e.preventDefault();
          send({ kind: 'title', title, subtitle, image, duration: Number(duration) });
        }}
      >
        <h4>Титры</h4>
        <input class="input input-sm" placeholder="Заголовок: Глава II. Пепел" value={title} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Заголовок титров" maxLength={80} />
        <input class="input input-sm" placeholder="Подзаголовок: Три дня спустя…" value={subtitle} onInput={(e) => setSubtitle(e.currentTarget.value)} aria-label="Подзаголовок титров" maxLength={160} />
        <div class="cine-row" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <input class="input input-sm grow" placeholder="Картинка: ссылка или перетащите из библиотеки" value={image} onInput={(e) => setImage(e.currentTarget.value)} aria-label="Картинка титров" />
          <IconButton icon="upload" size={16} title="Загрузить картинку" onClick={() => fileRef.current?.click()} />
          <input type="file" accept="image/*" hidden ref={fileRef} onChange={upload} />
        </div>
        <div class="cine-row">
          <select class="input input-sm" value={duration} onChange={(e) => setDuration(Number(e.currentTarget.value))} aria-label="Сколько висят титры">
            <option value={4}>4 секунды</option>
            <option value={6}>6 секунд</option>
            <option value={10}>10 секунд</option>
            <option value={0}>Пока не уберу</option>
          </select>
          <Button size="sm" kind="primary" type="submit" disabled={!title.trim() && !subtitle.trim()}>
            Показать титры
          </Button>
        </div>
      </form>

      <form
        class="cine-sec"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send({ kind: 'narrate', text }).then((r) => r?.ok && setText(''));
        }}
      >
        <h4>Голос рассказчика</h4>
        <textarea
          class="input input-sm"
          rows={2}
          placeholder="Ветер стих. Где-то в темноте скрипнула дверь…"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
          }}
          aria-label="Текст рассказчика"
          maxLength={400}
        />
        <div class="cine-row">
          <span class="small muted grow">Ctrl+Enter — сказать</span>
          <Button size="sm" type="submit" disabled={!text.trim()}>
            Сказать
          </Button>
        </div>
      </form>

      <div class="cine-sec">
        <h4>Сцена</h4>
        <div class="cine-grid">
          <button type="button" class={'chip' + (st.fade ? ' on' : '')} aria-pressed={!!st.fade} onClick={() => send({ kind: 'fade' })}>
            Затемнение
          </button>
          <button type="button" class={'chip' + (st.bars ? ' on' : '')} aria-pressed={!!st.bars} onClick={() => send({ kind: 'bars' })}>
            Кинополосы
          </button>
          <button type="button" class="chip" onClick={() => send({ kind: 'shake', strength: 'light' })}>
            Тряска
          </button>
          <button type="button" class="chip" onClick={() => send({ kind: 'shake', strength: 'strong' })}>
            Землетрясение
          </button>
          <button type="button" class="chip" onClick={() => send({ kind: 'flash', color: 'white' })}>
            Вспышка
          </button>
          <button type="button" class="chip" onClick={() => send({ kind: 'flash', color: 'red' })}>
            Красная вспышка
          </button>
          <button type="button" class="chip" onClick={() => send({ kind: 'flash', color: 'gold' })}>
            Золотая вспышка
          </button>
          <button type="button" class="chip" title="Камеры игроков плавно перелетят к тому, что сейчас видите вы" onClick={camera}>
            Камеру — к моему виду
          </button>
        </div>
        <p class="small muted">То же в чате: /титры Заголовок | подзаголовок, /рассказ текст, /затемнение, /кино, /тряска сильно, /вспышка красная.</p>
      </div>
    </section>
  );
}
