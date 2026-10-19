import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useApp, useStoreEvents } from '../hooks.js';
import { messageHtml } from '../chat/message.js';
import { openDamageMenu } from '../damage.js';
import { applyEffect, tokenOfChar, tableEffects } from '../effects.js';
import { ReactionPicker, myReactionToken } from '../chat/reactions.jsx';
import { playRollFx, resolveFx, rollFxActive, rollMood } from '../chat/rollFx.js';
import { diceOfMessage } from '../diceAnim.js';
import { IconButton, toast } from '../../ui/components.jsx';
import { Icon } from '../../ui/icons.jsx';

const Message = memo(
  function Message({ html, fresh }) {
    return <div class={fresh ? 'msg-wrap fresh' : 'msg-wrap'} dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.html === b.html && a.fresh === b.fresh,
);

export function ChatPanel({ sheetVersion }) {
  const app = useApp();
  const { store, net, sheets, macro } = app;
  const [msgs, setMsgs] = useState(() => [...store.messages]);
  const [system, setSystem] = useState([]);
  const [text, setText] = useState('');
  const [hist, setHist] = useState({ list: [], i: -1 });
  const listRef = useRef();
  const stick = useRef(true);
  const [noMore, setNoMore] = useState(false);
  useStoreEvents(store, ['col:char', 'members', 'snapshot', 'game']);

  // только что пришедшие сообщения (не из истории): оформление стола показывает их появление
  const fresh = useRef(new Set());
  const markFresh = (id) => {
    if (fresh.current.size > 200) fresh.current.clear();
    fresh.current.add(id);
  };
  useEffect(() => {
    const offs = [
      store.on('chat', (m) => {
        if (Date.now() - (m.ts || 0) < 15000) markFresh(m.id);
        setMsgs((ms) => [...ms.slice(-600), m]);
      }),
      store.on('chat:reset', () => setMsgs([])),
      store.on('chat:update', ({ id, reactions }) => setMsgs((ms) => ms.map((m) => (m.id === id ? { ...m, reactions } : m)))),
      store.on('snapshot', () => setMsgs([...store.messages])),
      store.on('chat:system', (m) => {
        const id = 'sys' + Math.random();
        markFresh(id);
        setSystem((s) => [...s.slice(-30), { id, ts: m.ts || Date.now(), type: 'system', content: m.text, error: !m.info }]);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  // все сообщения по времени (системные — локальные)
  const all = useMemo(() => [...msgs, ...system].sort((a, b) => a.ts - b.ts), [msgs, system]);
  // HTML сообщений кэшируем: при новом сообщении не перерисовываем сотни старых
  const cache = useRef(new Map());
  const htmls = useMemo(() => {
    const out = [];
    let prev = null;
    const c = cache.current;
    if (c.size > 3000) c.clear();
    // кнопки «Наложить эффект» зависят от списка эффектов стола
    const fxSig = tableEffects(store)
      .map((d) => `${d.id}:${d.name}:${d.alias || ''}`)
      .join(',');
    const ver = `${sheetVersion}|${store.settings.chatAvatars !== false}|${fxSig}`;
    for (const m of all) {
      // реакции — часть сообщения: поменялись — перерисовать
      const rs = m.reactions ? JSON.stringify(m.reactions) : '';
      const key = `${m.id}|${prev?.id || ''}|${ver}|${rs}`;
      let html = c.get(key);
      if (html === undefined) {
        try {
          html = messageHtml(m, { store, sheet: sheets.template, prev });
        } catch (e) {
          console.error('[chat]', e, m);
          html = '<div class="message system error">Ошибка отображения сообщения</div>';
        }
        c.set(key, html);
      }
      out.push({ id: m.id, html, fresh: fresh.current.has(m.id) });
      prev = m;
    }
    return out;
  }, [all, sheetVersion, store.settings.chatAvatars, store.settings.markers]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [htmls]);

  // свежий бросок прилетает с эффектом, который выбрал бросавший (листопад, искры, руны…)
  const played = useRef(new Set());
  useEffect(() => {
    const el = listRef.current;
    if (!el || !rollFxActive()) return;
    const todo = [];
    for (const m of all.slice(-8)) {
      if (!fresh.current.has(m.id) || played.current.has(m.id)) continue;
      played.current.add(m.id);
      if (!diceOfMessage(m, 1).length) continue;
      const fx = resolveFx(store.members.get(m.playerId)?.dice?.fx);
      if (fx) todo.push([m, fx]);
    }
    if (played.current.size > 300) played.current = new Set([...played.current].slice(-100));
    if (!todo.length) return;
    requestAnimationFrame(() => {
      for (const [m, fx] of todo) {
        const node = el.querySelector(`[data-messageid="${CSS.escape(m.id)}"]`)?.closest('.msg-wrap');
        if (node) playRollFx(node, fx, rollMood(m));
      }
    });
  }, [htmls]);

  const onScroll = () => {
    const el = listRef.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const loadEarlier = async () => {
    const first = msgs[0];
    const r = await net.request('chat:history', { before: first ? first.ts : Date.now() });
    if (r?.messages) {
      if (!r.messages.length) setNoMore(true);
      stick.current = false;
      setMsgs((ms) => [...r.messages, ...ms]);
    }
  };

  // клики по кнопкам в чате; по числу броска — урон или лечение выделенным токенам
  const onClick = (e) => {
    const n = e.target.closest('.inlinerollresult[data-mid], .rolled[data-mid]');
    if (n && !e.target.closest('a') && openDamageMenu(app, n, e.clientX, e.clientY)) {
      e.preventDefault();
      return;
    }
    const a = e.target.closest('a[data-action]');
    if (!a) return;
    e.preventDefault();
    const action = a.dataset.action;
    const ref = a.dataset.ref || '';
    if (action === 'api') return toast('Команды API (Mod-скрипты) не поддерживаются', 'error');
    if (action === 'react' || action === 'react-pick') {
      const mid = a.closest('[data-messageid]')?.dataset.messageid;
      if (!mid) return;
      if (action === 'react') return react(mid, ref);
      const r = a.getBoundingClientRect();
      setPicker({ id: mid, x: r.left + r.width / 2, y: r.top });
      return;
    }
    if (action === 'effect') {
      const mid = a.closest('[data-messageid]')?.dataset.messageid;
      effectFromChat(ref, all.find((m) => m.id === mid));
      return;
    }
    if (action === 'ability') {
      const [cid] = ref.split('|');
      const ch = store.col.char.get(cid);
      const ctx = ch && store.canControlChar(ch) ? { as: { type: 'char', id: cid }, charId: cid } : {};
      macro.run(`%{${ref}}`, { as: ctx.as });
      return;
    }
    macro.run(ref.startsWith('#') ? ref : ref, {});
  };

  // реакции под сообщением
  const [picker, setPicker] = useState(null);
  const react = (id, emoji) => net.request('chat:react', { id, emoji }).then((r) => r?.error && toast(r.error, 'error'));

  // «Наложить эффект» под броском: на выделенные токены, а если ничего не выделено — на цель щелчком.
  // Наложивший — токен персонажа, от чьего имени бросок (для концентрации).
  const effectFromChat = async (effectId, msg) => {
    const src = tokenOfChar(store, msg?.charId)?.id || null;
    let targets = store.selectedObjs().filter((o) => o.type !== 'wall' && o.pageId === store.ui.pageId);
    if (!targets.length) {
      const name = store.settings.markers?.find((d) => d.id === effectId)?.name || '';
      const id = await app.board()?.pickTarget(name, `Цель эффекта «${name}» — щёлкните по токену (Esc — отмена)`);
      if (!id) return;
      targets = [store.col.obj.get(id)].filter(Boolean);
    }
    await applyEffect(app, effectId, targets, { src });
  };

  const send = async () => {
    const t = text;
    if (!t.trim()) return;
    setText('');
    setHist((h) => ({ list: [...h.list.slice(-50), t], i: -1 }));
    stick.current = true;
    await macro.run(t, {});
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && !text.includes('\n') && hist.list.length) {
      const i = hist.i < 0 ? hist.list.length - 1 : Math.max(0, hist.i - 1);
      setHist({ ...hist, i });
      setText(hist.list[i]);
      e.preventDefault();
    } else if (e.key === 'ArrowDown' && hist.i >= 0) {
      const i = hist.i + 1;
      if (i >= hist.list.length) {
        setHist({ ...hist, i: -1 });
        setText('');
      } else {
        setHist({ ...hist, i });
        setText(hist.list[i]);
      }
      e.preventDefault();
    }
  };

  return (
    <div class="chat-panel">
      <div class="textchatcontainer" id="textchat" ref={listRef} onScroll={onScroll} onClick={onClick}>
        <div class={'content ' + (store.settings.chatAvatars === false ? 'withoutavatars' : 'withavatars')}>
          {!noMore && msgs.length >= 50 && (
            <button type="button" class="load-earlier" onClick={loadEarlier}>
              Показать раньше
            </button>
          )}
          {htmls.map((m) => (
            <Message key={m.id} html={m.html} fresh={m.fresh} />
          ))}
          {!htmls.length && <div class="chat-empty">Здесь будут сообщения и броски. Попробуйте написать /r 1d20</div>}
        </div>
      </div>
      <ChatInput text={text} setText={setText} onKey={onKey} send={send} />
      {picker && <ReactionPicker x={picker.x} y={picker.y} label="Реакция на сообщение" onPick={(e) => react(picker.id, e)} onClose={() => setPicker(null)} />}
    </div>
  );
}

function ChatInput({ text, setText, onKey, send }) {
  const app = useApp();
  const { store, macro } = app;
  useStoreEvents(store, ['col:char', 'members', 'speakingAs']);
  const me = store.members.get(store.me.id);
  const chars = [...store.col.char.values()].filter((c) => !c.archived && store.canControlChar(c)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const as = store.ui.speakingAs || { type: 'player' };
  const asVal = as.type === 'char' ? 'c:' + as.id : 'p';
  const setAs = (v) => {
    store.ui.speakingAs = v === 'p' ? { type: 'player' } : { type: 'char', id: v.slice(2) };
    try {
      localStorage.setItem('tv:as:' + store.gameId, JSON.stringify(store.ui.speakingAs));
    } catch {
      /* ignore */
    }
    store.emit('speakingAs');
  };
  const quick = (d) => macro.run(`/r 1d${d}`, {});
  // реакция всплывает над своим токеном (или у аватара, если токена нет)
  const [floatPick, setFloatPick] = useState(null);
  const sendFloat = (emoji) => app.net.request('react:float', { emoji, tokenId: myReactionToken(store)?.id });
  return (
    <div class="chat-input">
      <div class="chat-input-top">
        <label class="as-label">
          <span>От имени</span>
          <select class="input input-sm" value={asVal} onChange={(e) => setAs(e.currentTarget.value)}>
            <option value="p">{me?.displayName || 'Я'}</option>
            {chars.map((c) => (
              <option value={'c:' + c.id}>{c.name || 'Без имени'}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          class="icon-btn react-float-btn"
          title="Реакция над своим токеном"
          aria-label="Реакция над своим токеном"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFloatPick(floatPick ? null : { x: r.left + r.width / 2, y: r.top });
          }}
        >
          <span aria-hidden="true">☺</span>
        </button>
        {floatPick && <ReactionPicker x={floatPick.x} y={floatPick.y} label="Реакция над своим токеном" onPick={sendFloat} onClose={() => setFloatPick(null)} />}
        <div class="dice-tray" aria-label="Быстрый бросок">
          {[4, 6, 8, 10, 12, 20, 100].map((d) => (
            <button type="button" class="die-btn" title={`Бросить 1d${d}`} onClick={() => quick(d)}>
              d{d}
            </button>
          ))}
        </div>
      </div>
      <div class="chat-input-row">
        <textarea
          class="input chat-text"
          rows={2}
          value={text}
          placeholder="Сообщение, /r 1d20+5, [[2d6]], &{template:default} {{name=…}}"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKey}
          aria-label="Сообщение в чат"
        />
        <button type="button" class="btn btn-primary send-btn" onClick={send} title="Отправить (Enter)" aria-label="Отправить">
          <Icon name="chevRight" size={20} />
        </button>
      </div>
    </div>
  );
}
