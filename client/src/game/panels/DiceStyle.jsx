// «Мои кубики» в «Для меня»: набор кубиков и эффект, с которым бросок прилетает в чат.
// Выбор хранится в аккаунте и виден всем за столом; пробный бросок и показ эффекта — только у себя.
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../../api.js';
import { DICE_SKINS, skinLook } from '../dice3d/skins.js';
import { paintSwatch } from '../dice3d/patterns.js';
import { ROLL_FX, cleanDiceStyle } from '@shared/diceStyle.js';
import { useApp, useStoreEvents } from '../hooks.js';
import { Button, Field, Toggle, toast } from '../../ui/components.jsx';
import { playRollFx, resolveFx, rollFxEnabled, setRollFxEnabled } from '../chat/rollFx.js';
import { teapot } from '../../ui/teapot.js';

function Swatch({ look }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(40 * dpr);
    paintSwatch(c, look);
  }, [look.key]);
  return <canvas ref={ref} class="ds-swatch" aria-hidden="true" />;
}

export function DiceStyle() {
  const app = useApp();
  const { store } = app;
  useStoreEvents(store, ['members']);
  const me = store.members.get(store.me.id);
  const [style, setStyle] = useState(() => cleanDiceStyle(me?.dice || app.user?.settings?.dice));
  const [fxOn, setFxOn] = useState(rollFxEnabled());
  const demo = useRef();
  const color = me?.color || app.user?.color || '#7a2e2e';

  const save = async (patch) => {
    const next = { ...style, ...patch };
    setStyle(next);
    try {
      const d = await api.patch('/api/auth/me', { settings: { dice: next } });
      if (app.user && d?.user) app.user.settings = d.user.settings;
    } catch (e) {
      toast('Не удалось сохранить: ' + e.message, 'error');
    }
  };
  const showFx = (fx = style.fx, mood = '') => {
    const id = resolveFx(fx);
    if (id && demo.current) playRollFx(demo.current, id, mood);
  };
  const current = DICE_SKINS.find((s) => s.id === style.skin) || DICE_SKINS[0];

  return (
    <div class="dice-style">
      <p class="small muted">Ваши кубики и эффект броска видят все за столом.</p>
      <div class="ds-grid" role="radiogroup" aria-label="Набор кубиков">
        {DICE_SKINS.map((s) => {
          const look = skinLook(s.id, color);
          const on = s.id === current.id;
          return (
            <button type="button" role="radio" aria-checked={on} class={'ds-skin' + (on ? ' on' : '')} title={s.name} data-skin={s.id} onClick={() => !on && save({ skin: s.id })}>
              <Swatch look={look} />
              <span>{s.name}</span>
            </button>
          );
        })}
      </div>
      <div class="row row-wrap ds-actions">
        <Button size="sm" icon="dice" onClick={() => app.previewDice(current.id)}>
          Бросить пробный
        </Button>
      </div>
      <Field label="Бросок в чате" inline hint="С каким эффектом ваши броски появляются в чате у всех.">
        <select
          class="input input-sm"
          value={style.fx}
          aria-label="Эффект броска в чате"
          onChange={(e) => {
            const fx = e.currentTarget.value;
            save({ fx });
            setTimeout(() => showFx(fx), 30);
          }}
        >
          {ROLL_FX.map(([id, name]) => (
            <option value={id}>{name}</option>
          ))}
        </select>
      </Field>
      <div class="ds-demo-row">
        <div class="ds-demo msg-wrap" ref={demo}>
          <div class="ds-demo-msg message">
            <span class="by">Пробный бросок:</span> <span class="ds-demo-num rolled">17</span>
          </div>
        </div>
        <Button size="sm" kind="ghost" onClick={() => showFx()} disabled={!resolveFx(style.fx)}>
          Показать
        </Button>
        <Button size="sm" kind="ghost" title="Как выглядит на натуральной 20" onClick={() => showFx(style.fx, 'crit')} disabled={!resolveFx(style.fx)}>
          Крит
        </Button>
      </div>
      <div class="set-list">
        <Toggle
          checked={fxOn}
          onChange={(v) => {
            setRollFxEnabled(v);
            setFxOn(v);
          }}
          label="Показывать эффекты бросков (на этом устройстве)"
        />
        {teapot() && <p class="small muted">Сейчас включён режим чайника: эффекты бросков не показываются, кубики плоские.</p>}
      </div>
    </div>
  );
}
