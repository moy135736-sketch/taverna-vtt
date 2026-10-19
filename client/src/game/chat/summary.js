// Карточка «Итоги вечера» в чате: награды, момент вечера и вся статистика по игрокам (данные считает сервер)
import { escapeHtml } from '@shared/text.js';

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const e = (s) => escapeHtml(String(s ?? ''));
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#888888');

function whenLine(s) {
  if (!s.from || !s.to) return '';
  if (s.scope === 'all') {
    const d = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    return `с ${d(s.from)} по ${d(s.to)}`;
  }
  const dur = Math.max(0, s.to - s.from);
  const h = Math.floor(dur / 3600000);
  const m = Math.round((dur % 3600000) / 60000);
  const day = new Date(s.from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const len = dur >= 60000 ? ` (${h ? h + ' ч ' : ''}${m} мин)` : '';
  return `${day}, ${time(s.from)}–${time(s.to)}${len}`;
}

const nameHtml = (w) => `<b class="sum-name" style="--pc:${safeColor(w.color)}">${e(w.name)}</b>${w.player ? ` <span class="sum-player">${e(w.player)}</span>` : ''}`;

export function summaryHtml(s) {
  const t = s.total || {};
  const stat = (n, one, few, many) => `<div class="sum-stat"><b>${n}</b><span>${plural(n, one, few, many)}</span></div>`;
  let html = `<div class="sum-card">`;
  html += `<div class="sum-head"><div class="sum-title">${s.scope === 'all' ? 'Итоги кампании' : 'Итоги вечера'}</div><div class="sum-when">${e(whenLine(s))}</div></div>`;
  html += `<div class="sum-stats">${stat(t.rolls || 0, 'бросок', 'броска', 'бросков')}${stat(t.nat20 || 0, 'двадцатка', 'двадцатки', 'двадцаток')}${stat(t.nat1 || 0, 'единица', 'единицы', 'единиц')}${stat(t.messages || 0, 'реплика', 'реплики', 'реплик')}</div>`;
  if (s.awards?.length) {
    html += `<ul class="sum-awards">`;
    for (const a of s.awards)
      html += `<li class="sum-award" data-award="${e(a.id)}"><span class="sum-ico" aria-hidden="true">${e(a.icon)}</span><span class="sum-award-body"><span class="sum-award-title">${e(a.title)}</span> ${a.who.map(nameHtml).join(', ')}<span class="sum-why">${e(a.text)}</span></span></li>`;
    html += `</ul>`;
  }
  if (s.moment) {
    const m = s.moment;
    html += `<div class="sum-moment"><div class="sum-moment-h">Момент вечера</div><q>${e(m.text)}</q> <span class="sum-moment-who" style="--pc:${safeColor(m.color)}">— ${e(m.who)}</span> <span class="sum-moment-r">${(m.reactions || []).map(([em, n]) => `${e(em)}${n}`).join(' ')}</span></div>`;
  }
  if (s.players?.length) {
    html += `<details class="sum-details"><summary>Статистика по игрокам</summary><table class="sum-table"><thead><tr><th>Кто</th><th title="Бросков">Бр.</th><th title="Средний d20">d20</th><th title="Натуральных 20">20</th><th title="Единиц на d20">1</th><th>Лучший</th></tr></thead><tbody>`;
    for (const p of s.players)
      html += `<tr><td>${nameHtml({ name: p.char || p.name, player: p.char ? p.name : '', color: p.color })}</td><td>${p.rolls}</td><td>${p.avg === null || p.avg === undefined ? '—' : String(p.avg).replace('.', ',')}</td><td>${p.nat20}</td><td>${p.nat1}</td><td>${p.best ? e(p.best.total) : '—'}</td></tr>`;
    html += `</tbody></table></details>`;
  }
  html += `</div>`;
  return html;
}
