// Живой слой оформления под доской: в «Фэнтези» — ночное небо с искрами по краям карты,
// в «Киберпанке» — полоса сканирования при входе за стол. Только украшение: событий не ловит.
//
// Искры и звёзды меняются ступеньками — 15 раз в секунду, и все в одни и те же моменты (длительности
// и задержки кратны 0,2 с, ход — steps на весь цикл). Любая плавная анимация на весь экран заставляет
// видеокарту пересобирать его на каждом кадре экрана (на игровом ноутбуке — 144 раза в секунду);
// так — 15 раз, а глазу медленные искры и мерцание кажутся такими же.
import { useMemo, useEffect, useRef } from 'preact/hooks';

const TICK = 15; // смен кадра в секунду у искр
const STAR_TICK = 5; // и у звёзд (кратно: моменты совпадают с искрами)
const q = (s) => Math.round(s * 5) / 5; // кратно 0,2 с — целое число шагов и там и там

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Анимация нужна: оформление «Фэнтези», не «без анимации», не облегчённое, не уменьшение движения в системе */
function motionAllowed() {
  const c = document.documentElement.classList;
  if (c.contains('theme-still') || c.contains('theme-lite') || c.contains('teapot')) return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function ThemeDecor({ theme }) {
  const ref = useRef(null);
  const { motes, stars } = useMemo(() => {
    const r = seeded(20261017);
    const motes = Array.from({ length: 22 }, () => {
      const d = q(14 + r() * 16);
      return {
        x: (2 + r() * 96).toFixed(1) + '%',
        s: (2.5 + r() * 3.5).toFixed(1) + 'px',
        d,
        delay: -q(r() * d),
        sway: Math.round((r() - 0.5) * 160),
        o: Number((0.55 + r() * 0.45).toFixed(2)),
        cool: r() < 0.22,
      };
    });
    const stars = Array.from({ length: 14 }, () => ({
      x: (1 + r() * 98).toFixed(1) + '%',
      y: (1 + r() * 98).toFixed(1) + '%',
      d: q(2.5 + r() * 4),
      delay: -q(r() * 6),
    }));
    return { motes, stars };
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (theme !== 'fantasy' || !root?.animate) return;
    let anims = [];
    const stop = () => {
      for (const a of anims) a.cancel();
      anims = [];
    };
    const start = () => {
      if (anims.length || !motionAllowed()) return;
      root.querySelectorAll('.fx-mote').forEach((el, i) => {
        const m = motes[i];
        anims.push(
          el.animate(
            [
              { opacity: 0, transform: 'translate3d(0, 0, 0) scale(0.6)', offset: 0 },
              { opacity: m.o, offset: 0.12 },
              { transform: `translate3d(${m.sway}px, -48vh, 0) scale(1)`, offset: 0.5 },
              { opacity: m.o, offset: 0.82 },
              { opacity: 0, transform: `translate3d(${-m.sway / 2}px, -96vh, 0) scale(0.7)`, offset: 1 },
            ],
            { duration: m.d * 1000, delay: m.delay * 1000, iterations: Infinity, easing: `steps(${Math.round(m.d * TICK)}, end)` },
          ),
        );
      });
      root.querySelectorAll('.fx-star').forEach((el, i) => {
        const st = stars[i];
        anims.push(
          el.animate(
            [
              { opacity: 0.15, transform: 'scale(0.6)' },
              { opacity: 1, transform: 'scale(1.15)' },
            ],
            { duration: st.d * 1000, delay: st.delay * 1000, iterations: Infinity, direction: 'alternate', easing: `steps(${Math.round(st.d * STAR_TICK)}, end)` },
          ),
        );
      });
    };
    const sync = () => (motionAllowed() ? start() : stop());
    sync();
    // «без анимации», облегчение и режим чайника включаются классами на <html>
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', sync);
    return () => {
      mo.disconnect();
      mq?.removeEventListener?.('change', sync);
      stop();
    };
  }, [theme, motes, stars]);

  if (theme === 'fantasy')
    return (
      <div class="fx-ambient" aria-hidden="true" ref={ref}>
        <div class="fx-stars" />
        <div class="fx-stars b" />
        <div class="fx-mist" />
        {stars.map((st, i) => (
          <i key={'s' + i} class="fx-star" style={{ '--x': st.x, '--y': st.y }} />
        ))}
        {motes.map((m, i) => (
          <i key={i} class={m.cool ? 'fx-mote cool' : 'fx-mote'} style={{ '--x': m.x, '--s': m.s }} />
        ))}
      </div>
    );
  if (theme === 'cyber') return <div class="cy-scan" aria-hidden="true" />;
  return null;
}
