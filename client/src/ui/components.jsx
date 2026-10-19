import { h, Fragment, Component } from 'preact';
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'preact/hooks';
import { Icon } from './icons.jsx';

// ---------------------------------------------------------------------------
// Простое глобальное хранилище для тостов и диалогов
// ---------------------------------------------------------------------------

const listeners = new Set();
let toasts = [];
let dialogs = [];
let seq = 1;

function notify() {
  for (const l of listeners) l();
}

/** Уведомление внизу справа. action: {label, onClick} — кнопка в уведомлении (например, «Отменить») */
export function toast(text, kind = 'info', ms = 4000, action = null) {
  const id = seq++;
  toasts = [...toasts, { id, text, kind, action }];
  notify();
  setTimeout(() => dismissToast(id), ms);
}

/** Уведомление на время долгой работы: текст можно менять, закрывается done(). action — кнопка (например, «Не ждать») */
export function progressToast(text, action = null) {
  const id = seq++;
  toasts = [...toasts, { id, text, kind: 'info', action }];
  notify();
  return {
    update(t) {
      if (!toasts.some((x) => x.id === id)) return;
      toasts = toasts.map((x) => (x.id === id ? { ...x, text: t } : x));
      notify();
    },
    done: () => dismissToast(id),
  };
}

function dismissToast(id) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function showError(e) {
  toast(e?.message || String(e), 'error', 6000);
}

function openDialog(render) {
  return new Promise((resolve) => {
    const id = seq++;
    const close = (v) => {
      dialogs = dialogs.filter((d) => d.id !== id);
      notify();
      resolve(v);
    };
    dialogs = [...dialogs, { id, render: () => render(close), close }];
    notify();
  });
}

export function confirmDialog({ title = 'Подтвердите', text = '', okText = 'Да', cancelText = 'Отмена', danger = false } = {}) {
  return openDialog((close) => (
    <Modal title={title} onClose={() => close(false)} width={420}>
      {text && <p class="dlg-text">{text}</p>}
      <div class="modal-actions">
        <Button onClick={() => close(false)}>{cancelText}</Button>
        <Button kind={danger ? 'danger' : 'primary'} autoFocus onClick={() => close(true)}>
          {okText}
        </Button>
      </div>
    </Modal>
  ));
}

export function promptDialog({ title = 'Введите значение', label = '', value = '', placeholder = '', okText = 'OK', multiline = false, options = null } = {}) {
  return openDialog((close) => <PromptBody title={title} label={label} value={value} placeholder={placeholder} okText={okText} multiline={multiline} options={options} close={close} />);
}

function PromptBody({ title, label, value, placeholder, okText, multiline, options, close }) {
  const [v, setV] = useState(options ? value || options[0]?.value : value);
  const ref = useRef();
  useEffect(() => {
    setTimeout(() => {
      ref.current?.focus();
      ref.current?.select?.();
    }, 20);
  }, []);
  const submit = (e) => {
    e?.preventDefault();
    close(v);
  };
  return (
    <Modal title={title} onClose={() => close(null)} width={440}>
      <form onSubmit={submit}>
        {label && <label class="field-label">{label}</label>}
        {options ? (
          <select ref={ref} class="input" value={v} onChange={(e) => setV(e.currentTarget.value)}>
            {options.map((o) => (
              <option value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : multiline ? (
          <textarea ref={ref} class="input" rows={5} value={v} placeholder={placeholder} onInput={(e) => setV(e.currentTarget.value)} />
        ) : (
          <input ref={ref} class="input" value={v} placeholder={placeholder} onInput={(e) => setV(e.currentTarget.value)} />
        )}
        <div class="modal-actions">
          <Button type="button" onClick={() => close(null)}>
            Отмена
          </Button>
          <Button kind="primary" type="submit">
            {okText}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Показать произвольный модальный компонент; render(close) */
export function showModal(render) {
  return openDialog(render);
}

export function OverlayHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return (
    <>
      {dialogs.map((d) => (
        <DialogBoundary key={d.id} onError={(e) => (toast('Не удалось открыть окно: ' + (e?.message || e), 'error', 6000), d.close(null))}>
          {d.render()}
        </DialogBoundary>
      ))}
      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={'toast toast-' + t.kind}>
            {t.text}
            {t.action && (
              <button
                type="button"
                class="toast-action"
                onClick={() => {
                  dismissToast(t.id);
                  t.action.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Ошибка в одном диалоге не должна ломать остальные */
class DialogBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err) {
    console.error('[dialog]', err);
    this.props.onError?.(err);
  }
  render() {
    return this.state.err ? null : this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Базовые элементы
// ---------------------------------------------------------------------------

export function Button({ kind = 'default', size, icon, children, class: cls = '', ...rest }) {
  return (
    <button type="button" class={`btn btn-${kind} ${size ? 'btn-' + size : ''} ${cls}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, title, active, class: cls = '', size = 18, ...rest }) {
  return (
    <button type="button" class={`icon-btn ${active ? 'active' : ''} ${cls}`} title={title} aria-label={title} aria-pressed={active ? 'true' : undefined} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Modal({ title, onClose, children, width = 520, class: cls = '' }) {
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose && onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div class={'modal ' + cls} style={{ width: `min(${width}px, calc(100vw - 32px))` }} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head">
          <h2>{title}</h2>
          {onClose && <IconButton icon="x" title="Закрыть" onClick={onClose} />}
        </div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children, inline }) {
  return (
    <label class={'field ' + (inline ? 'field-inline' : '')}>
      {label && <span class="field-label">{label}</span>}
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label class={'toggle ' + (disabled ? 'disabled' : '')}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span class="toggle-track" aria-hidden="true">
        <span class="toggle-thumb" />
      </span>
      {label && <span class="toggle-label">{label}</span>}
    </label>
  );
}

export function Tabs({ tabs, value, onChange, class: cls = '' }) {
  return (
    <div class={'tabs ' + cls} role="tablist">
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === t.id}
          class={'tab ' + (value === t.id ? 'active' : '')}
          onClick={() => onChange(t.id)}
          title={t.title || t.label}
          aria-label={(t.title || t.label) + (t.badge ? ` (${t.badge})` : '')}
        >
          {t.icon && <Icon name={t.icon} size={17} />}
          {t.label && <span>{t.label}</span>}
          {t.badge ? <span class="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

const SWATCHES = ['#000000', '#ffffff', '#7f8c8d', '#c0392b', '#e74c3c', '#d35400', '#f39c12', '#f1c40f', '#27ae60', '#2ecc71', '#16a085', '#2980b9', '#3498db', '#8e44ad', '#9b59b6', '#e84393', '#6d4c41', 'transparent'];

export function ColorInput({ value, onChange, allowTransparent = true, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const v = value || 'transparent';
  return (
    <span class="color-input" ref={ref}>
      <button type="button" class="swatch-btn" title={title || 'Цвет'} onClick={() => setOpen(!open)} style={{ '--sw': v === 'transparent' ? 'transparent' : v }}>
        <span class={'swatch ' + (v === 'transparent' ? 'swatch-none' : '')} />
      </button>
      {open && (
        <div class="color-pop">
          <div class="swatches">
            {SWATCHES.filter((s) => allowTransparent || s !== 'transparent').map((s) => (
              <button
                type="button"
                class={'swatch ' + (s === 'transparent' ? 'swatch-none' : '') + (s === v ? ' sel' : '')}
                style={{ background: s === 'transparent' ? undefined : s }}
                title={s === 'transparent' ? 'Нет' : s}
                onClick={() => {
                  onChange(s === 'transparent' ? '' : s);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div class="color-custom">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#888888'} onInput={(e) => onChange(e.currentTarget.value)} />
            <input class="input input-sm" value={value || ''} placeholder="#rrggbb" onChange={(e) => onChange(e.currentTarget.value.trim())} />
          </div>
        </div>
      )}
    </span>
  );
}

export function Spinner({ label = 'Загрузка…' }) {
  return (
    <div class="spinner-wrap">
      <span class="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Avatar({ src, name = '', color = '#555', size = 32 }) {
  // инициалы — по первым буквам слов (скобки, кавычки и прочие знаки пропускаем)
  const initials =
    (String(name || '').match(/[\p{L}\p{N}]+/gu) || ['?'])
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?';
  return (
    <span class="avatar" style={{ width: size + 'px', height: size + 'px', '--c': color, fontSize: Math.round(size * 0.4) + 'px' }} title={name}>
      {src ? <img src={src} alt="" /> : initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Плавающее окно (листы персонажей, настройки и т.п.)
// ---------------------------------------------------------------------------

let zTop = 100;
export function bringToFront() {
  return ++zTop;
}

function loadPos(key) {
  try {
    return JSON.parse(localStorage.getItem('win:' + key) || 'null');
  } catch {
    return null;
  }
}
function savePos(key, pos) {
  try {
    localStorage.setItem('win:' + key, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

export function FloatingWindow({ id, title, onClose, children, width = 640, height = 560, minWidth = 280, minHeight = 160, headerExtra, class: cls = '', icon }) {
  const saved = loadPos(id);
  const [pos, setPos] = useState(() => {
    const w = Math.min(saved?.w || width, window.innerWidth - 20);
    const hh = Math.min(saved?.h || height, window.innerHeight - 20);
    const x = saved?.x ?? Math.max(10, (window.innerWidth - w) / 2 + ((zTop % 7) - 3) * 24);
    const y = saved?.y ?? Math.max(10, (window.innerHeight - hh) / 2 + ((zTop % 5) - 2) * 24);
    return { x: Math.min(x, window.innerWidth - 120), y: Math.min(Math.max(0, y), window.innerHeight - 60), w, h: hh };
  });
  const [z, setZ] = useState(() => bringToFront());
  const [collapsed, setCollapsed] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  const startDrag = (e, mode) => {
    if (e.button !== 0) return;
    if (mode === 'move' && e.target.closest('button, input, select, .no-drag')) return;
    e.preventDefault();
    setZ(bringToFront());
    const sx = e.clientX,
      sy = e.clientY;
    const start = { ...posRef.current };
    const shield = document.createElement('div');
    shield.className = 'drag-shield';
    shield.style.cursor = mode === 'move' ? 'grabbing' : 'nwse-resize';
    document.body.appendChild(shield);
    const move = (ev) => {
      const dx = ev.clientX - sx,
        dy = ev.clientY - sy;
      if (mode === 'move') setPos({ ...start, x: Math.min(window.innerWidth - 60, Math.max(-start.w + 80, start.x + dx)), y: Math.min(window.innerHeight - 30, Math.max(0, start.y + dy)) });
      else setPos({ ...start, w: Math.max(minWidth, start.w + dx), h: Math.max(minHeight, start.h + dy) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      shield.remove();
      savePos(id, posRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div class={'fwin ' + cls + (collapsed ? ' collapsed' : '')} style={{ left: pos.x + 'px', top: pos.y + 'px', width: pos.w + 'px', height: collapsed ? 'auto' : pos.h + 'px', zIndex: z }} onMouseDown={() => z !== zTop && setZ(bringToFront())} role="dialog" aria-label={title}>
      <div class="fwin-head" onPointerDown={(e) => startDrag(e, 'move')} onDblClick={(e) => !e.target.closest('button,input') && setCollapsed(!collapsed)}>
        {icon && <Icon name={icon} size={16} />}
        <span class="fwin-title">{title}</span>
        {headerExtra}
        <IconButton icon={collapsed ? 'chevDown' : 'chevUp'} title={collapsed ? 'Развернуть' : 'Свернуть'} size={15} onClick={() => setCollapsed(!collapsed)} />
        {onClose && <IconButton icon="x" title="Закрыть" size={16} onClick={onClose} />}
      </div>
      {!collapsed && <div class="fwin-body">{children}</div>}
      {!collapsed && <div class="fwin-resize" onPointerDown={(e) => startDrag(e, 'resize')} aria-hidden="true" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Контекстное меню
// ---------------------------------------------------------------------------

let ctxState = null;
const ctxListeners = new Set();

export function openContextMenu(x, y, items) {
  ctxState = { x, y, items };
  for (const l of ctxListeners) l();
}
export function closeContextMenu() {
  ctxState = null;
  for (const l of ctxListeners) l();
}

export function ContextMenuHost() {
  const [, force] = useState(0);
  const ref = useRef();
  const [sub, setSub] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    const l = () => {
      setSub(null);
      force((x) => x + 1);
    };
    ctxListeners.add(l);
    const close = (e) => {
      if (ctxState && ref.current && !ref.current.contains(e.target)) closeContextMenu();
    };
    const esc = (e) => e.key === 'Escape' && closeContextMenu();
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', esc);
    return () => {
      ctxListeners.delete(l);
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', esc);
      clearTimeout(timer.current);
    };
  }, []);
  if (!ctxState) return null;
  const { x, y, items } = ctxState;
  const left = Math.min(x, window.innerWidth - 230);
  const top = Math.min(y, window.innerHeight - Math.min(items.length * 32 + 12, window.innerHeight - 20));
  // переключение подменю с небольшой задержкой — чтобы его не закрывало при движении мыши наискосок
  const hoverTop = (i) => {
    clearTimeout(timer.current);
    if (i === sub) return;
    timer.current = setTimeout(() => setSub(i), sub === null ? 0 : 160);
  };
  const keepSub = () => clearTimeout(timer.current);
  const itemButton = (it, i, level) => (
    <button
      type="button"
      key={i}
      class={'ctx-item ' + (it.danger ? 'danger' : '') + (it.checked ? ' checked' : '')}
      disabled={it.disabled}
      role="menuitem"
      onMouseEnter={level === 0 ? () => hoverTop(null) : undefined}
      onClick={() => {
        closeContextMenu();
        it.action && it.action();
      }}
    >
      {it.icon ? <Icon name={it.icon} size={15} /> : <span class="ctx-ic" />}
      <span>{it.label}</span>
      {it.checked && <Icon name="check" size={14} />}
    </button>
  );
  const renderItems = (list, level) =>
    list.map((it, i) =>
      it === '-' ? (
        <div class="ctx-sep" key={i} />
      ) : it.children && level === 0 ? (
        <div class={'ctx-item ctx-has-sub' + (it.disabled ? ' disabled' : '')} key={i} role="menuitem" aria-haspopup="true" aria-expanded={sub === i} onMouseEnter={() => !it.disabled && hoverTop(i)} onClick={() => !it.disabled && setSub(i)}>
          {it.icon && <Icon name={it.icon} size={15} />}
          <span>{it.label}</span>
          <Icon name="chevRight" size={14} />
          {sub === i && <SubMenu onEnter={keepSub}>{renderItems(it.children, 1)}</SubMenu>}
        </div>
      ) : (
        itemButton(it, i, level)
      ),
    );
  return (
    <div class="ctx-menu" role="menu" ref={ref} style={{ left: left + 'px', top: Math.max(4, top) + 'px' }} onContextMenu={(e) => e.preventDefault()}>
      {renderItems(items, 0)}
    </div>
  );
}

/** Подменю: помещается в окно (слева, если справа нет места; прокрутка, если длинное) */
function SubMenu({ children, onEnter }) {
  const ref = useRef();
  const [style, setStyle] = useState({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = el.parentElement.getBoundingClientRect();
    const maxH = window.innerHeight - 16;
    const w = el.offsetWidth;
    const h = Math.min(el.scrollHeight, maxH);
    let left = parent.right + 2;
    if (left + w > window.innerWidth - 8) left = Math.max(8, parent.left - w - 2);
    let top = parent.top - 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
    setStyle({ position: 'fixed', left: left + 'px', top: top + 'px', marginLeft: 0, maxHeight: maxH + 'px', overflowY: 'auto' });
  }, []);
  return (
    <div class="ctx-sub" role="menu" ref={ref} style={style} onMouseEnter={onEnter} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

export function useForceUpdate() {
  const [, set] = useState(0);
  return useCallback(() => set((x) => x + 1), []);
}
