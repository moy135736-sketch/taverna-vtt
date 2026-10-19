// Журнал чата в отдельный HTML-файл (архив сессии): все видимые пользователю сообщения
import chatCss from './chat.css?raw';
import { messageHtml } from './message.js';
import { R20_FONTS_CSS } from '../sheet/base-css.js';
import { escapeHtml } from '@shared/text.js';

export async function exportChatLog(app, onProgress) {
  const { store, net, sheets } = app;
  const all = new Map();
  let before = Date.now() + 1000;
  for (let i = 0; i < 400; i++) {
    const r = await net.request('chat:history', { before });
    const list = r?.messages || [];
    if (!list.length) break;
    for (const m of list) all.set(m.id, m);
    const oldest = Math.min(...list.map((m) => m.ts));
    if (!(oldest < before)) break;
    before = oldest;
    onProgress?.(all.size);
  }
  const msgs = [...all.values()].sort((a, b) => a.ts - b.ts);
  let prev = null;
  const body = msgs
    .map((m) => {
      const h = messageHtml(m, { store, sheet: sheets.template, prev, actions: false });
      prev = m;
      return h;
    })
    .join('\n');
  const origin = location.origin;
  const fonts = R20_FONTS_CSS.replace(/url\('\//g, `url('${origin}/`);
  const title = `${store.game?.name || 'Стол'} — журнал чата`;
  const first = msgs[0] ? new Date(msgs[0].ts) : new Date();
  const last = msgs.length ? new Date(msgs[msgs.length - 1].ts) : new Date();
  const fmt = (d) => d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body { margin: 0; background: #f7f4ee; color: #222; font-family: "Alegreya Sans", "Helvetica Neue", Arial, sans-serif; }
header { padding: 20px 24px 8px; font-family: Georgia, serif; }
header h1 { margin: 0 0 4px; font-size: 26px; }
header p { margin: 0; color: #6b5f50; }
.textchatcontainer { max-width: 760px; margin: 0 auto; padding: 8px 16px 40px; }
${fonts}
${chatCss}
${sheets.template ? sheets.template.chatCss() : ''}
</style></head><body>
<header><h1>${escapeHtml(store.game?.name || 'Стол')}</h1><p>Журнал чата: ${msgs.length} сообщ., ${fmt(first)} — ${fmt(last)}</p></header>
<div class="textchatcontainer"><div class="content ${store.settings.chatAvatars === false ? 'withoutavatars' : 'withavatars'}">
${body}
</div></div></body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  // латиница в имени файла: не все браузеры сохраняют кириллические имена у blob-ссылок
  const safe = translit(store.game?.name || 'game')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  a.download = `${safe || 'game'}-chat-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return msgs.length;
}

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
function translit(s) {
  return String(s).replace(/[а-яёіїєґ]/gi, (c) => {
    const t = TR[c.toLowerCase()] ?? '';
    return c === c.toLowerCase() ? t : t.charAt(0).toUpperCase() + t.slice(1);
  });
}
