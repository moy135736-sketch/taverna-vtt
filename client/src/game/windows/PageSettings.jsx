import { useState, useEffect } from 'preact/hooks';
import { useApp, useStoreEvents } from '../hooks.js';
import { FloatingWindow, Field, Toggle, ColorInput, Button, confirmDialog, toast } from '../../ui/components.jsx';
import { WEATHER } from '../board/fx.js';
import { DIAGONAL_RULES } from '@shared/defaults.js';

function Num({ value, onCommit, ...rest }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input class="input input-sm" type="number" value={v} onInput={(e) => setV(e.currentTarget.value)} onBlur={() => Number(v) !== Number(value) && onCommit(Number(v))} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} {...rest} />;
}

export function PageSettings({ winKey, id }) {
  const app = useApp();
  const { store, net } = app;
  useStoreEvents(store, ['col:page'], (ev, p, pid) => pid === id);
  const p = store.col.page.get(id);
  const [name, setName] = useState(p?.name || '');
  if (!p || !store.isGM) return null;
  const upd = (patch) => net.update('page', id, patch).then((r) => r?.error && toast(r.error, 'error'));
  // через доску, чтобы действие можно было отменить Ctrl+Z (если сцена открыта)
  const fogReset = (mode) => (store.ui.pageId === id && app.board() ? app.board().fogReset(mode) : net.request('fog', { pageId: id, reset: mode }));
  const fog = p.fog || {};
  const li = p.lighting || {};
  const w = p.weather || {};
  return (
    <FloatingWindow id="page-settings" title={'Сцена: ' + p.name} onClose={() => app.closeWin(winKey)} width={520} height={680} icon="map">
      <div class="page-settings">
        <Field label="Название">
          <input class="input input-sm" value={name} onInput={(e) => setName(e.currentTarget.value)} onBlur={() => name !== p.name && upd({ name })} />
        </Field>
        <h4 class="sub-h">Размер и сетка</h4>
        <div class="grid-2">
          <Field label="Ширина, клеток">
            <Num value={p.width} min={1} max={500} onCommit={(v) => v > 0 && upd({ width: Math.min(500, v) })} />
          </Field>
          <Field label="Высота, клеток">
            <Num value={p.height} min={1} max={500} onCommit={(v) => v > 0 && upd({ height: Math.min(500, v) })} />
          </Field>
          <Field label="Клетка, пикселей">
            <Num value={p.cellSize} min={10} max={500} onCommit={(v) => v >= 10 && upd({ cellSize: v })} />
          </Field>
          <Field label="Сетка">
            <select class="input input-sm" value={p.gridType} onChange={(e) => upd({ gridType: e.currentTarget.value })}>
              <option value="square">Квадраты</option>
              <option value="hex">Гексы (вертикальные)</option>
              <option value="hexr">Гексы (горизонтальные)</option>
              <option value="none">Без сетки</option>
            </select>
          </Field>
          <Field label="Одна клетка =">
            <div class="row">
              <Num value={p.scale} min={0.1} step={0.5} onCommit={(v) => v > 0 && upd({ scale: v })} style={{ width: '70px' }} />
              <input class="input input-sm" value={p.units} onChange={(e) => upd({ units: e.currentTarget.value })} style={{ width: '70px' }} aria-label="Единицы" />
            </div>
          </Field>
          <Field label="Диагонали">
            <select class="input input-sm" value={p.diagonal} onChange={(e) => upd({ diagonal: e.currentTarget.value })}>
              {Object.entries(DIAGONAL_RULES).map(([k, n]) => (
                <option value={k}>{n}</option>
              ))}
            </select>
          </Field>
        </div>
        <div class="row row-wrap" style={{ gap: '14px', marginBottom: '8px' }}>
          <span class="small muted">Цвет сетки</span>
          <ColorInput value={p.gridColor} onChange={(v) => upd({ gridColor: v })} allowTransparent={false} />
          <input type="range" min={0} max={1} step={0.05} value={p.gridOpacity} onChange={(e) => upd({ gridOpacity: Number(e.currentTarget.value) })} title="Прозрачность сетки" />
          <Toggle checked={p.snap} onChange={(v) => upd({ snap: v })} label="Привязка к сетке" />
        </div>
        <div class="row" style={{ gap: '10px', marginBottom: '8px' }}>
          <span class="small muted">Фон страницы</span>
          <ColorInput value={p.bgColor} onChange={(v) => upd({ bgColor: v || '#ffffff' })} allowTransparent={false} />
        </div>

        <h4 class="sub-h">Туман войны (ручной)</h4>
        <Toggle checked={!!fog.enabled} onChange={(v) => upd({ fog: { ...fog, enabled: v } })} label="Включить туман" />
        <Field label="Прозрачность тумана для мастера" inline>
          <input type="range" min={0.1} max={0.9} step={0.05} value={fog.gmOpacity ?? 0.45} onChange={(e) => upd({ fog: { ...fog, gmOpacity: Number(e.currentTarget.value) } })} />
        </Field>
        <div class="row">
          <Button size="sm" onClick={async () => (await confirmDialog({ title: 'Скрыть всю сцену туманом?', okText: 'Скрыть' })) && fogReset('hideAll')}>
            Скрыть всё
          </Button>
          <Button size="sm" onClick={() => fogReset('revealAll')}>
            Открыть всё
          </Button>
        </div>

        <h4 class="sub-h">Динамический свет</h4>
        <div class="set-list">
          <Toggle checked={!!li.enabled} onChange={(v) => upd({ lighting: { ...li, enabled: v } })} label="Включить стены, зрение и освещение" />
          <Toggle checked={!!li.daylight} onChange={(v) => upd({ lighting: { ...li, daylight: v } })} label="Дневной свет (всё освещено, видно в пределах обзора)" />
          {li.daylight && (
            <Field label="Яркость дня" inline>
              <input type="range" min={0.1} max={1} step={0.05} value={li.daylightLevel ?? 1} onChange={(e) => upd({ lighting: { ...li, daylightLevel: Number(e.currentTarget.value) } })} />
            </Field>
          )}
          <Toggle checked={!!li.explorer} onChange={(v) => upd({ lighting: { ...li, explorer: v } })} label="Режим исследователя (увиденное остаётся тусклым)" />
          <Toggle checked={li.restrictMovement !== false} onChange={(v) => upd({ lighting: { ...li, restrictMovement: v } })} label="Стены не пускают токены игроков" />
          <Toggle checked={!!li.sharedVision} onChange={(v) => upd({ lighting: { ...li, sharedVision: v } })} label="Общий обзор отряда: все игроки видят глазами всех токенов игроков" />
          {!li.sharedVision && <p class="small muted" style={{ margin: "2px 0 4px 44px" }}>Каждый игрок видит только глазами своих токенов. Поделиться обзором одного токена — «Общий обзор» в его настройках.</p>}
          <Field label="Темнота для игроков" inline>
            <input type="range" min={0.3} max={1} step={0.05} value={li.darkness ?? 1} onChange={(e) => upd({ lighting: { ...li, darkness: Number(e.currentTarget.value) } })} />
          </Field>
        </div>

        <h4 class="sub-h">Погода и атмосфера</h4>
        <div class="row row-wrap chips-wrap">
          {Object.entries(WEATHER).map(([k, n]) => (
            <button type="button" class={'chip ' + ((w.type || 'none') === k ? 'on' : '')} onClick={() => upd({ weather: { ...w, type: k } })}>
              {n}
            </button>
          ))}
        </div>
        {w.type && w.type !== 'none' && (
          <div class="grid-2">
            <Field label="Сила">
              <input type="range" min={0.05} max={1} step={0.05} value={w.intensity ?? 0.5} onChange={(e) => upd({ weather: { ...w, intensity: Number(e.currentTarget.value) } })} />
            </Field>
            <Field label="Ветер">
              <input type="range" min={0} max={1} step={0.05} value={w.wind ?? 0.3} onChange={(e) => upd({ weather: { ...w, wind: Number(e.currentTarget.value) } })} />
            </Field>
            {w.type === 'fog' && (
              <Field label="Цвет тумана">
                <ColorInput value={w.color} onChange={(v) => upd({ weather: { ...w, color: v } })} />
              </Field>
            )}
          </div>
        )}
      </div>
    </FloatingWindow>
  );
}
