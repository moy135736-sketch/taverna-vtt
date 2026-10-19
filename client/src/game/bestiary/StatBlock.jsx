// Статблок монстра в духе книги правил: имя, тип, КД, хиты, характеристики, разделы с действиями.
// Текст — как в SRD (английский); onEntry(раздел, номер, запись) — щелчок по названию действия (бросок в чат).
import { escapeHtml } from '@shared/text.js';
import { ABIL } from '@shared/bestiary.js';
import './statblock.css';

const ABIL_LABEL = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
const sign = (n) => (n >= 0 ? '+' : '−') + Math.abs(n);

/** Текст записи: _курсив_, **жирный**, переносы — абзацами (из чужих файлов — сначала экранируем) */
function richText(s) {
  return escapeHtml(String(s || ''))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])_(.+?)_(?=$|[\s).,;:<])/g, '$1<em>$2</em>')
    .split(/\n+/)
    .map((p, i) => (i ? `<span class="sb-para">${p}</span>` : p))
    .join('');
}

const SECTIONS = [
  ['traits', 'Traits'],
  ['actions', 'Actions'],
  ['bonus', 'Bonus Actions'],
  ['reactions', 'Reactions'],
  ['legendary', 'Legendary Actions'],
];

function AbilTable({ m, per, cls }) {
  const rows = [];
  for (let i = 0; i < ABIL.length; i += per) rows.push(ABIL.slice(i, i + per));
  return (
    <table class={'sb-abil ' + cls}>
      <thead>
        <tr>
          {rows[0].map(() => (
            <>
              <th />
              <th />
              <th>MOD</th>
              <th>SAVE</th>
            </>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            {row.map((a) => {
              const [score, mod, save] = m.abil[a];
              return (
                <>
                  <th scope="row">{ABIL_LABEL[a]}</th>
                  <td class="sb-score">{score}</td>
                  <td>{sign(mod)}</td>
                  <td class={save !== mod ? 'sb-prof' : ''}>{sign(save)}</td>
                </>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatBlock({ m, nameRu = '', onEntry, rollable = () => false }) {
  if (!m) return null;
  const line = (label, value) =>
    value ? (
      <p class="sb-line">
        <b>{label}</b> {value}
      </p>
    ) : null;
  return (
    <article class="statblock" aria-label={`Статблок: ${m.name}`}>
      <header class="sb-head">
        <h3 class="sb-name">{m.name}</h3>
        {nameRu && <span class="sb-ru">{nameRu}</span>}
        <p class="sb-kind">
          {m.size} {m.type}
          {m.alignment ? `, ${m.alignment}` : ''}
        </p>
      </header>
      <div class="sb-rule" />
      <div class="sb-core">
        <p class="sb-line">
          <b>AC</b> {m.ac}
          {m.acNote ? ` (${m.acNote})` : ''} <b class="sb-gap">Initiative</b> {sign(m.init)} ({10 + m.init})
        </p>
        <p class="sb-line">
          <b>HP</b> {m.hp}
          {m.hpFormula ? ` (${m.hpFormula})` : ''}
        </p>
        {line('Speed', m.speed)}
      </div>
      {/* характеристики: в ширину — 3 в ряд, на узком экране — по 2 */}
      <AbilTable m={m} per={3} cls="sb-abil-wide" />
      <AbilTable m={m} per={2} cls="sb-abil-narrow" />
      <div class="sb-props">
        {line('Skills', m.skills)}
        {line('Vulnerabilities', m.vulnerabilities)}
        {line('Resistances', m.resistances)}
        {line('Immunities', m.immunities)}
        {line('Gear', m.gear)}
        {line('Senses', m.senses)}
        {line('Languages', m.languages)}
        <p class="sb-line">
          <b>CR</b> {m.cr} (XP {Number(m.xp || 0).toLocaleString('en-US')}; PB +{m.pb})
        </p>
      </div>
      {SECTIONS.map(([key, title]) =>
        m[key]?.length ? (
          <section class="sb-sec">
            <h4>{title}</h4>
            {key === 'legendary' && m.legendaryIntro && <p class="sb-intro" dangerouslySetInnerHTML={{ __html: richText(m.legendaryIntro) }} />}
            {m[key].map((e, i) => (
              <p class="sb-entry">
                {onEntry ? (
                  <button type="button" class={'sb-ename' + (rollable(key, i) ? ' roll' : '')} title={rollable(key, i) ? 'Бросить в чат' : 'Показать в чате'} onClick={() => onEntry(key, i, e)}>
                    {e.name}.
                  </button>
                ) : (
                  <b class="sb-ename">{e.name}.</b>
                )}{' '}
                <span dangerouslySetInnerHTML={{ __html: richText(e.text) }} />
              </p>
            ))}
          </section>
        ) : null,
      )}
    </article>
  );
}
