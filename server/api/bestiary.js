// Бестиарий: загрузка монстров с GitHub через сервер — запасной путь, когда браузер мастера
// не может забрать файл сам (сеть, политика браузера). Только файлы с raw.githubusercontent.com
// и gist.githubusercontent.com, не больше 25 МБ.
import express from 'express';
import { requireUser } from '../auth.js';

export const bestiaryRouter = express.Router();
bestiaryRouter.use(requireUser);

const HOSTS = new Set(['raw.githubusercontent.com', 'gist.githubusercontent.com']);
export const BESTIARY_MAX_BYTES = 25 * 1024 * 1024;
const TOO_BIG = 'Файл слишком большой (больше 25 МБ)';

/** Текст файла с GitHub (перенаправления — только на те же сайты) */
export async function fetchGithubText(url, { fetchImpl = globalThis.fetch, hops = 3, timeoutMs = 20000 } = {}) {
  let next = String(url || '').trim();
  for (let i = 0; i <= hops; i++) {
    let u;
    try {
      u = new URL(next);
    } catch {
      throw new Error('Неверная ссылка');
    }
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error('Через сервер загружаются только файлы с raw.githubusercontent.com и gist.githubusercontent.com');
    const r = await fetchImpl(u.toString(), {
      redirect: 'manual',
      headers: { 'User-Agent': 'Taverna-VTT', Accept: 'application/json, text/markdown, text/plain;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const loc = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      next = new URL(loc, u).toString();
      continue;
    }
    if (!r.ok) throw new Error(r.status === 404 ? 'На GitHub нет такого файла (404)' : `GitHub ответил ${r.status}`);
    if (Number(r.headers.get('content-length') || 0) > BESTIARY_MAX_BYTES) throw new Error(TOO_BIG);
    const chunks = [];
    let size = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BESTIARY_MAX_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error(TOO_BIG);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  throw new Error('Слишком много перенаправлений');
}

// не больше 30 загрузок за 10 минут на человека
const recent = new Map();
function allow(userId) {
  const t = Date.now();
  const list = (recent.get(userId) || []).filter((x) => t - x < 10 * 60000);
  if (list.length >= 30) return false;
  list.push(t);
  recent.set(userId, list);
  if (recent.size > 1000) for (const [k, v] of recent) if (!v.some((x) => t - x < 10 * 60000)) recent.delete(k);
  return true;
}

bestiaryRouter.post('/fetch', async (req, res) => {
  if (!allow(req.user.id)) return res.status(429).json({ error: 'Слишком много загрузок подряд — подождите несколько минут' });
  try {
    const text = await fetchGithubText(req.body?.url);
    res.json({ text });
  } catch (e) {
    const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'GitHub не ответил вовремя' : e?.message?.startsWith('fetch failed') ? 'Сервер не смог связаться с GitHub' : e?.message || 'Не удалось загрузить';
    res.status(400).json({ error: msg });
  }
});
