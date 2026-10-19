import { useApp, useStoreEvents } from './hooks.js';
import { Icon } from '../ui/icons.jsx';
import { ColorInput, confirmDialog } from '../ui/components.jsx';
import { SHAPES } from './board/objview.js';
import { FX_TYPES, FX_COLORS } from './board/fx.js';
import { LAYER_NAMES } from '@shared/defaults.js';
import { TEMPLATE_SHAPES } from './board/templates.js';

const UI_KEYS = ['fogMode', 'fogShape', 'fogBrush', 'wallType', 'shapeType', 'strokeColor', 'fillColor', 'strokeWidth', 'fontSize', 'fxType', 'fxColor', 'rulerShape', 'rulerKeep', 'coneAngle', 'beamWidth'];

export function loadUiPrefs(store) {
  try {
    const p = JSON.parse(localStorage.getItem('tv:ui') || '{}');
    for (const k of UI_KEYS) if (p[k] !== undefined) store.ui[k] = p[k];
  } catch {
    /* ignore */
  }
}

function setUi(store, patch) {
  Object.assign(store.ui, patch);
  try {
    const p = {};
    for (const k of UI_KEYS) p[k] = store.ui[k];
    localStorage.setItem('tv:ui', JSON.stringify(p));
  } catch {
    /* ignore */
  }
  store.emit('tool', store.ui.tool);
}

const TOOL_GROUPS = (gm) =>
  [
    [
      { id: 'select', icon: 'select', label: 'Выбор и перемещение (V)' },
      { id: 'pan', icon: 'hand', label: 'Перемещение по карте (H, или пробел)' },
      { id: 'ruler', icon: 'ruler', label: 'Линейка (R). Пробел или ПКМ — точка поворота' },
    ],
    [
      { id: 'draw', icon: 'pencil', label: 'Рисовать от руки (D)' },
      { id: 'line', icon: 'line', label: 'Линия' },
      { id: 'poly', icon: 'polygon', label: 'Многоугольник (двойной щелчок — завершить)' },
      { id: 'shape', icon: 'shapes', label: 'Фигура-токен (растягивается, можно дать бары и права)' },
      { id: 'text', icon: 'text', label: 'Текст' },
    ],
    gm
      ? [
          { id: 'fog', icon: 'cloud', label: 'Туман войны: открыть/скрыть область' },
          { id: 'wall', icon: 'wall', label: 'Стены и двери (динамический свет)' },
          { id: 'light', icon: 'bulb', label: 'Источник света' },
          { id: 'pin', icon: 'ping', label: 'Метка на карте: заметка или ссылка на материал' },
        ]
      : null,
    [{ id: 'fx', icon: 'sparkles', label: 'Спецэффекты (тяните для лучей и конусов)' }],
  ].filter(Boolean);

export function Toolbar() {
  const app = useApp();
  const { store } = app;
  useStoreEvents(store, ['tool', 'layer', 'snapshot', 'game', 'page', 'col:page', 'ui:cine'], (ev, a, id) => ev !== 'col:page' || id === store.ui.pageId);
  const tool = store.ui.tool;
  const gm = store.isGM;
  return (
    <nav class="g-tools" aria-label="Инструменты">
      {/* кнопки прокручиваются, если не помещаются по высоте (большой масштаб страницы, низкий экран) */}
      <div class="g-tools-scroll">
        {TOOL_GROUPS(gm).map((group, gi) => (
          <div class="tool-group" key={gi}>
            {group.map((t) => (
              <button type="button" class={'tool-btn ' + (tool === t.id ? 'active' : '')} title={t.label} aria-label={t.label} aria-pressed={tool === t.id} onClick={() => store.setTool(t.id)}>
                <Icon name={t.icon} size={20} />
              </button>
            ))}
          </div>
        ))}
        {gm && <LayerPicker />}
        {gm && (
          <div class="tool-group cine-group">
            <button
              type="button"
              class={'tool-btn ' + (store.ui.cineOpen ? 'active' : '')}
              title="Кинотрюки: титры, рассказчик, затемнение, тряска, вспышка, камера"
              aria-label="Кинотрюки"
              aria-pressed={!!store.ui.cineOpen}
              onClick={() => {
                store.ui.cineOpen = !store.ui.cineOpen;
                store.emit('ui:cine');
              }}
            >
              <Icon name="clapper" size={20} />
            </button>
          </div>
        )}
      </div>
      <ToolOptions />
    </nav>
  );
}

function LayerPicker() {
  const { store } = useApp();
  const layer = store.ui.layer;
  const icons = { map: 'map', objects: 'users', foreground: 'layers', gm: 'eyeOff', walls: 'wall' };
  return (
    <div class="tool-group layer-group" role="radiogroup" aria-label="Слой">
      {['map', 'objects', 'foreground', 'gm', 'walls'].map((l) => (
        <button type="button" role="radio" aria-checked={layer === l} class={'tool-btn layer-btn ' + (layer === l ? 'active' : '')} title={'Слой: ' + LAYER_NAMES[l]} onClick={() => store.setLayer(l)}>
          <Icon name={icons[l]} size={18} />
        </button>
      ))}
    </div>
  );
}

function ToolOptions() {
  const app = useApp();
  const { store, net } = app;
  const ui = store.ui;
  const tool = ui.tool;
  const page = store.page;
  const set = (patch) => setUi(store, patch);
  let body = null;

  if (['draw', 'line', 'poly', 'shape', 'text'].includes(tool)) {
    body = (
      <>
        {tool === 'shape' && (
          <div class="opt-row shapes-row">
            {Object.entries(SHAPES).map(([k, s]) => (
              <button type="button" class={'chip ' + ((ui.shapeType || 'rect') === k ? 'on' : '')} onClick={() => set({ shapeType: k })} title={s.name}>
                {s.name}
              </button>
            ))}
          </div>
        )}
        <div class="opt-row">
          <span class="opt-label">Линия</span>
          <ColorInput value={ui.strokeColor || '#000000'} onChange={(v) => set({ strokeColor: v })} />
          {tool !== 'text' && (
            <>
              <span class="opt-label">Заливка</span>
              <ColorInput value={ui.fillColor ?? (tool === 'shape' ? '#c0392b88' : '')} onChange={(v) => set({ fillColor: v })} />
            </>
          )}
        </div>
        <div class="opt-row">
          {tool === 'text' ? (
            <label class="opt-label">
              Размер <input type="number" class="input input-sm" style={{ width: '64px' }} min={8} max={200} value={ui.fontSize || 28} onChange={(e) => set({ fontSize: Number(e.currentTarget.value) || 28 })} />
            </label>
          ) : (
            <label class="opt-label">
              Толщина <input type="range" min={1} max={30} value={ui.strokeWidth || 4} onInput={(e) => set({ strokeWidth: Number(e.currentTarget.value) })} />
            </label>
          )}
        </div>
      </>
    );
  } else if (tool === 'fog' && store.isGM) {
    const fogOn = page?.fog?.enabled;
    body = (
      <>
        {!fogOn && (
          <p class="opt-note">
            Туман на этой сцене выключен.{' '}
            <button type="button" class="link-btn" onClick={() => net.update('page', page.id, { fog: { ...(page.fog || {}), enabled: true } })}>
              Включить
            </button>
          </p>
        )}
        <div class="opt-row">
          <button type="button" class={'chip ' + ((ui.fogMode || 'reveal') === 'reveal' ? 'on' : '')} onClick={() => set({ fogMode: 'reveal' })}>
            Открыть
          </button>
          <button type="button" class={'chip ' + (ui.fogMode === 'hide' ? 'on' : '')} onClick={() => set({ fogMode: 'hide' })}>
            Скрыть
          </button>
        </div>
        <div class="opt-row">
          {[
            ['rect', 'Прямоугольник'],
            ['ellipse', 'Овал'],
            ['poly', 'Многоугольник'],
            ['brush', 'Кисть'],
          ].map(([k, n]) => (
            <button type="button" class={'chip ' + ((ui.fogShape || 'rect') === k ? 'on' : '')} onClick={() => set({ fogShape: k })}>
              {n}
            </button>
          ))}
        </div>
        {ui.fogShape === 'brush' && (
          <label class="opt-label">
            Кисть, клеток <input type="range" min={0.5} max={6} step={0.5} value={ui.fogBrush || 1} onInput={(e) => set({ fogBrush: Number(e.currentTarget.value) })} /> {ui.fogBrush || 1}
          </label>
        )}
        <div class="opt-row">
          <button type="button" class="chip" onClick={async () => (await confirmDialog({ title: 'Скрыть всю сцену?', okText: 'Скрыть всё' })) && app.board()?.fogReset('hideAll')}>
            Скрыть всё
          </button>
          <button type="button" class="chip" onClick={() => app.board()?.fogReset('revealAll')}>
            Открыть всё
          </button>
        </div>
        <div class="opt-row">
          <span class="opt-note">Ctrl+Z — отменить последнее действие с туманом.</span>
        </div>
      </>
    );
  } else if (tool === 'wall' && store.isGM) {
    const lightOn = page?.lighting?.enabled;
    body = (
      <>
        {!lightOn && (
          <p class="opt-note">
            Динамический свет выключен.{' '}
            <button type="button" class="link-btn" onClick={() => net.update('page', page.id, { lighting: { ...(page.lighting || {}), enabled: true } })}>
              Включить
            </button>
          </p>
        )}
        <div class="opt-row">
          {[
            ['wall', 'Стена'],
            ['door', 'Дверь'],
            ['window', 'Окно'],
          ].map(([k, n]) => (
            <button type="button" class={'chip ' + ((ui.wallType || 'wall') === k ? 'on' : '')} onClick={() => set({ wallType: k })}>
              {n}
            </button>
          ))}
        </div>
        <p class="opt-note">Щёлкайте, чтобы ставить точки. Двойной щелчок или Enter — закончить, Esc — отмена. Alt — без привязки к сетке. Править стены — на слое «Стены и свет».</p>
      </>
    );
  } else if (tool === 'light') {
    body = <p class="opt-note">Щёлкните по карте, чтобы поставить источник света. Радиус и цвет — в настройках объекта на слое «Стены и свет».</p>;
  } else if (tool === 'pin') {
    body = <p class="opt-note">Щёлкните по карте, чтобы поставить метку: подпись, заметка для игроков, ссылка на материал. Игроки открывают метку щелчком; метка на слое мастера видна только вам.</p>;
  } else if (tool === 'fx') {
    body = (
      <>
        <div class="opt-row chips-wrap">
          {Object.entries(FX_TYPES).map(([k, t]) => (
            <button type="button" class={'chip ' + ((ui.fxType || 'burst') === k ? 'on' : '')} onClick={() => set({ fxType: k })}>
              {t.name}
            </button>
          ))}
        </div>
        <div class="opt-row chips-wrap">
          {Object.entries(FX_COLORS).map(([k, c]) => (
            <button type="button" class={'chip fx-color ' + ((ui.fxColor || 'fire') === k ? 'on' : '')} style={{ '--c': c.c[2] }} onClick={() => set({ fxColor: k })}>
              {c.name}
            </button>
          ))}
        </div>
      </>
    );
  } else if (tool === 'ruler') {
    const shape = ui.rulerShape || 'line';
    const units = page?.units || 'фт';
    body = (
      <>
        <div class="opt-row chips-wrap" role="radiogroup" aria-label="Что измерять">
          {Object.entries(TEMPLATE_SHAPES).map(([k, n]) => (
            <button type="button" role="radio" aria-checked={shape === k} class={'chip ' + (shape === k ? 'on' : '')} onClick={() => set({ rulerShape: k })}>
              {n}
            </button>
          ))}
        </div>
        {shape === 'cone' && (
          <div class="opt-row">
            <span class="opt-label">Угол</span>
            {[
              [53.13, '53° (D&D)'],
              [60, '60°'],
              [90, '90°'],
            ].map(([a, n]) => (
              <button type="button" class={'chip ' + (Math.abs((ui.coneAngle || 53.13) - a) < 0.5 ? 'on' : '')} onClick={() => set({ coneAngle: a })}>
                {n}
              </button>
            ))}
          </div>
        )}
        {shape === 'beam' && (
          <label class="opt-label">
            Ширина, {units}{' '}
            <input type="number" class="input input-sm" style={{ width: '70px' }} min={1} value={ui.beamWidth || page?.scale || 5} onChange={(e) => set({ beamWidth: Number(e.currentTarget.value) || page?.scale || 5 })} />
          </label>
        )}
        {shape !== 'line' && (
          <label class="opt-label check-row">
            <input type="checkbox" checked={!!ui.rulerKeep} onChange={(e) => set({ rulerKeep: e.currentTarget.checked })} /> Оставлять область на карте
          </label>
        )}
        <p class="opt-note">
          {shape === 'line'
            ? 'Тяните, чтобы измерить. Пробел или правая кнопка добавляет точку поворота.'
            : 'Тяните от точки начала: от центра круга, вершины конуса или угла куба. Клетки внутри области подсвечиваются. Alt — без привязки к сетке.'}
        </p>
      </>
    );
  }
  if (!body) return null;
  return <div class="tool-options">{body}</div>;
}
