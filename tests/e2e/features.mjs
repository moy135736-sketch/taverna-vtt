// e2e: интерфейс стола — чат, таблицы, макросы, материалы, настройки токена, маркеры,
// порядок ходов, туман, линейка, пинг, эффекты, погода, музыка. Мастер и игрок одновременно.
// Запуск: node tests/e2e/features.mjs (сервер на http://localhost:3000, свежий перезапуск — из-за лимита регистраций)
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
const ASSETS = process.env.ASSETS || path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const failures = [];

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_TUNNEL|Failed to load resource|ERR_CONNECTION/.test(t)) errors.push(`[${name}] ${m.type()}: ${t.slice(0, 300)}`);
  });
  await page.goto(BASE);
  const api = (p, body, method) =>
    page.evaluate(
      async ([p, body, method]) => {
        const r = await fetch(p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [p, body, method],
    );
  const r = await api('/api/auth/register', { username: 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  if (!r.user) throw new Error('регистрация: ' + JSON.stringify(r));
  return { ctx, page, api, user: r.user, name };
}

async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n')[0]);
    failures.push(name);
    const safe = name.replace(/[^\p{L}\p{N}]+/gu, '_');
    await gm.page.screenshot({ path: `${SHOTS}/feat-fail-${safe}-gm.png` }).catch(() => {});
    await pl.page.screenshot({ path: `${SHOTS}/feat-fail-${safe}-pl.png` }).catch(() => {});
  }
}

const say = async (u, text) => {
  const box = u.page.getByLabel('Сообщение в чат');
  await box.fill(text);
  await box.press('Enter');
};
const chatTab = (u) => u.page.getByRole('tab', { name: 'Чат' }).click();
const lastMsgs = (u, sel, n = 3) => u.page.locator(`.textchatcontainer ${sel}`).evaluateAll((els, n) => els.slice(-n).map((e) => e.textContent), n);
const waitText = async (u, sel, text, timeout = 6000) => {
  await u.page.locator(`.textchatcontainer ${sel}`, { hasText: text }).last().waitFor({ timeout });
};
const board = (u, fn, arg) => u.page.evaluate(fn, arg);
const boardBox = (u) => u.page.locator('.board').boundingBox();
/** точка доски по долям её размера (вне панели настроек инструмента в левом верхнем углу) */
async function boardPoint(u, fx, fy) {
  const box = await boardBox(u);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}
async function screenOf(u, wx, wy) {
  const box = await boardBox(u);
  const p = await u.page.evaluate(([x, y]) => window.__board.worldToScreen(x, y), [wx, wy]);
  return { x: box.x + p.x, y: box.y + p.y };
}

const gm = await newUser('Мастер');
const pl = await newUser('Аня');
let game;

await step('подготовка: стол, игрок по коду', async () => {
  const sheets = (await gm.api('/api/sheets')).sheets;
  game = (await gm.api('/api/games', { name: 'Проверка интерфейса', sheetId: sheets.find((s) => s.sourceRef === 'DD5thEditionLegacy').id })).game;
  const j = await pl.api('/api/games/join', { code: game.inviteCode });
  if (!j.game) throw new Error(JSON.stringify(j));
  for (const u of [gm, pl]) {
    await u.page.goto(`${BASE}/game/${game.id}`);
    await u.page.waitForSelector('.board-world', { state: 'attached' });
  }
  await gm.page.waitForTimeout(600);
});

// ---------------------------------------------------------------- чат
await step('чат: /em, /desc, /ooc, /as видны игроку', async () => {
  await say(gm, '/em осматривает зал');
  await waitText(pl, '.message.emote', 'осматривает зал');
  await say(gm, '/desc Тёмный зал, пахнет сыростью');
  await waitText(pl, '.message.desc', 'пахнет сыростью');
  await say(gm, '/ooc перерыв 5 минут');
  await waitText(pl, '.message.ooc', 'перерыв');
  await say(gm, '/as "Страж" Стой, кто идёт?');
  await waitText(pl, '.message', 'Стой, кто идёт?');
  const by = await pl.page.locator('.textchatcontainer .message', { hasText: 'Стой, кто идёт?' }).last().locator('.by').textContent();
  if (!by.includes('Страж')) throw new Error('говорит: ' + by);
});

await step('чат: шёпот игроку и мастеру', async () => {
  await say(gm, '/w Аня Под камнем ключ');
  await waitText(pl, '.message.whisper', 'Под камнем ключ');
  await say(pl, '/w gm Я проверяю ловушки');
  await waitText(gm, '.message.whisper', 'Я проверяю ловушки');
});

await step('чат: /gr скрыт от игрока', async () => {
  const before = await pl.page.locator('.textchatcontainer .message').count();
  await say(gm, '/gr 1d20+1000');
  await gm.page.locator('.textchatcontainer .message.gmrollresult').last().waitFor({ timeout: 5000 });
  await pl.page.waitForTimeout(700);
  const after = await pl.page.locator('.textchatcontainer .message').count();
  const leaked = await pl.page.locator('.textchatcontainer .message.gmrollresult').count();
  if (leaked) throw new Error('игрок видит скрытый бросок');
  if (after !== before) console.log('   (у игрока появилось сообщений:', after - before, ')');
});

await step('чат: inline-бросок и шаблон default', async () => {
  await say(pl, 'Атакую! [[1d20+5]] урон [[2d6+3]]');
  await waitText(gm, '.message', 'Атакую!');
  const n = await gm.page.locator('.textchatcontainer .message', { hasText: 'Атакую!' }).last().locator('.inlinerollresult').count();
  if (n !== 2) throw new Error('inline-бросков: ' + n);
  await say(gm, '&{template:default} {{name=Огненный шар}} {{Спасбросок=ЛОВ 15}} {{Урон=[[8d6]]}}');
  await pl.page.locator('.textchatcontainer .sheet-rolltemplate-default', { hasText: 'Огненный шар' }).last().waitFor({ timeout: 5000 });
});

await step('макросы: имена с пробелами, способности, |max и запрос ?{}', async () => {
  await board(gm, async () => {
    const b = window.__board;
    const ch = await b.net.create('char', { name: 'Тарен Светлый', abilities: [{ id: 'ab1', name: 'Удар', action: '/r 1d20+@{Тарен Светлый|hp}+?{Бонус|2} Удар мечом', istokenaction: false }] });
    await b.net.request('attrs:set', { charId: ch.id, set: [{ name: 'hp', current: 10, max: 30 }] });
  });
  await gm.page.waitForTimeout(300);
  await chatTab(gm);
  await say(gm, '%{Тарен Светлый|Удар}');
  const q = gm.page.locator('.query-modal');
  await q.waitFor({ timeout: 4000 });
  await q.locator('input, select').first().fill('5');
  await q.locator('button[type=submit]').click();
  await gm.page.waitForTimeout(800);
  const last = (await lastMsgs(gm, '.message.rollresult', 1))[0] || '';
  if (!/1d20\s*\+\s*10\s*\+\s*5/.test(last.replace(/\s+/g, ' '))) throw new Error('бросок: ' + last);
  await say(gm, 'Макс. HP: [[@{Тарен Светлый|hp|max}]]');
  await gm.page.waitForTimeout(700);
  const t = (await lastMsgs(gm, '.message', 1))[0] || '';
  if (!t.includes('30')) throw new Error('|max: ' + t);
});

// ---------------------------------------------------------------- таблицы и макросы
await step('таблица бросков через интерфейс', async () => {
  await gm.page.getByRole('tab', { name: 'Макросы и таблицы бросков' }).click();
  await gm.page.locator('.sect-head', { hasText: 'Таблицы бросков' }).getByRole('button', { name: 'Новая' }).click();
  const modal = gm.page.locator('.modal', { hasText: 'Таблица бросков' });
  await modal.waitFor();
  await modal.getByLabel('Имя (используется в 1t[имя])').fill('встречи');
  await modal.getByRole('button', { name: 'Строка' }).click();
  await modal.getByRole('button', { name: 'Строка' }).click();
  const rows = modal.locator('tbody tr');
  await rows.nth(0).locator('input').first().fill('Гоблины');
  await rows.nth(1).locator('input').first().fill('Волки');
  await modal.getByRole('button', { name: 'Сохранить' }).click();
  await gm.page.waitForTimeout(400);
  await chatTab(gm);
  await say(gm, '/r 1t[встречи]');
  await gm.page.waitForTimeout(800);
  const last = (await lastMsgs(gm, '.message.rollresult', 1))[0] || '';
  if (!/Гоблины|Волки/.test(last)) throw new Error('результат: ' + last);
});

await step('макрос через интерфейс и панель макросов', async () => {
  await gm.page.getByRole('tab', { name: 'Макросы и таблицы бросков' }).click();
  await gm.page.locator('.sect-head', { hasText: 'Макросы' }).getByRole('button', { name: 'Новый' }).click();
  const modal = gm.page.locator('.modal', { hasText: 'Новый макрос' });
  await modal.getByLabel('Имя (без пробелов)').fill('атака');
  await modal.getByLabel('Команды').fill('/r 1d20+7 Атака мечом');
  await modal.getByRole('button', { name: 'Сохранить' }).click();
  const btn = gm.page.locator('.macro-bar .mbtn', { hasText: 'атака' });
  await btn.waitFor({ timeout: 4000 });
  await chatTab(gm);
  const before = await gm.page.locator('.textchatcontainer .message.rollresult').count();
  await btn.click();
  await gm.page.waitForTimeout(800);
  const after = await gm.page.locator('.textchatcontainer .message.rollresult').count();
  if (after !== before + 1) throw new Error('бросков было ' + before + ', стало ' + after);
  // #макрос в чате
  await say(gm, '#атака');
  await gm.page.waitForTimeout(800);
  const after2 = await gm.page.locator('.textchatcontainer .message.rollresult').count();
  if (after2 !== after + 1) throw new Error('#атака не сработал');
});

// ---------------------------------------------------------------- материалы
await step('материал (хэндаут): создать и показать игроку', async () => {
  await gm.page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await gm.page.getByRole('button', { name: 'Материал', exact: true }).click();
  const win = gm.page.locator('.fwin', { hasText: 'Новый материал' });
  await win.waitFor();
  await win.getByRole('button', { name: 'Редактировать' }).click();
  await win.getByLabel('Название').fill('Письмо');
  await win.getByLabel('Текст').fill('Встретимся **в полночь** у старой мельницы.');
  await win.getByRole('button', { name: 'Сохранить' }).click();
  await gm.page.waitForTimeout(300);
  await gm.page.locator('.fwin', { hasText: 'Письмо' }).getByRole('button', { name: 'Показать всем сейчас' }).click();
  const pw = pl.page.locator('.fwin', { hasText: 'Письмо' });
  await pw.waitFor({ timeout: 5000 });
  const html = await pw.locator('.handout-text').innerHTML();
  if (!html.includes('<strong>в полночь</strong>') && !html.includes('<b>в полночь</b>')) throw new Error('текст: ' + html);
  await pl.page.locator('.fwin', { hasText: 'Письмо' }).locator('.icon-btn[title="Закрыть"]').click();
  await gm.page.locator('.fwin', { hasText: 'Письмо' }).locator('.icon-btn[title="Закрыть"]').click();
});

// ---------------------------------------------------------------- токены
let tokId;
await step('токен: настройки, новый бар, цвет и имя', async () => {
  tokId = await board(gm, async () => {
    const b = window.__board;
    const ch = await b.net.create('char', { name: 'Огр' });
    await b.net.request('attrs:set', { charId: ch.id, set: [{ name: 'hp', current: 59, max: 59 }] });
    const o = await b.tokenFromCharacter(ch.id, 420, 280);
    return o?.id || [...b.store.col.obj.values()].find((x) => x.represents === ch.id)?.id;
  });
  await gm.page.waitForTimeout(500);
  const o = await board(gm, (id) => window.__board.store.col.obj.get(id), tokId);
  const c = await screenOf(gm, o.x + o.w / 2, o.y + o.h / 2);
  await gm.page.mouse.click(c.x, c.y);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await gm.page.locator('.ctx-item', { hasText: 'Настройки токена' }).click();
  const win = gm.page.locator('.fwin', { hasText: 'настройки' });
  await win.waitFor();
  await win.getByRole('tab', { name: 'Бары' }).click();
  const before = (await board(gm, (id) => window.__board.store.col.obj.get(id).bars, tokId)).length;
  await win.getByRole('button', { name: 'Добавить бар' }).click();
  await gm.page.waitForTimeout(400);
  const bars = await board(gm, (id) => window.__board.store.col.obj.get(id).bars, tokId);
  if (bars.length !== before + 1) throw new Error(`баров было ${before}, стало ${bars.length}`);
  const nameInput = win.locator('.bar-edit').last().getByPlaceholder('Подпись (HP, мана…)');
  await nameInput.fill('Ярость');
  await nameInput.press('Enter');
  await gm.page.waitForTimeout(400);
  const bars2 = await board(gm, (id) => window.__board.store.col.obj.get(id).bars, tokId);
  if (bars2.at(-1).name !== 'Ярость') throw new Error('имя бара: ' + bars2.at(-1).name);
  await win.getByRole('tab', { name: 'Основное' }).click();
  const nm = win.getByLabel('Имя', { exact: true });
  await nm.fill('Огр-вожак');
  await nm.press('Enter');
  await gm.page.waitForTimeout(400);
  const nm2 = await board(gm, (id) => window.__board.store.col.obj.get(id).name, tokId);
  if (nm2 !== 'Огр-вожак') throw new Error('имя токена: ' + nm2);
  await win.locator('.icon-btn[title="Закрыть"]').click();
});

await step('токен: быстрое изменение бара в кружке над токеном', async () => {
  const o = await board(gm, (id) => window.__board.store.col.obj.get(id), tokId);
  const c = await screenOf(gm, o.x + o.w / 2, o.y + o.h / 2);
  await gm.page.mouse.click(c.x, c.y);
  const bub = gm.page.locator('.bar-bubble').first();
  await bub.waitFor({ timeout: 3000 });
  const before = Number(await board(gm, (id) => window.__board.store.col.obj.get(id).bars[0].value, tokId));
  await bub.click();
  await bub.fill('-9');
  await bub.press('Enter');
  await gm.page.waitForTimeout(500);
  const after = Number(await board(pl, (id) => window.__board.store.col.obj.get(id)?.bars?.[0]?.value, tokId));
  if (after !== before - 9) throw new Error(`было ${before}, стало ${after}`);
});

await step('токен: маркер состояния из контекстного меню', async () => {
  const o = await board(gm, (id) => window.__board.store.col.obj.get(id), tokId);
  const c = await screenOf(gm, o.x + o.w / 2, o.y + o.h / 2);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await gm.page.locator('.ctx-item', { hasText: 'Маркеры состояния' }).hover();
  await gm.page.locator('.ctx-sub .ctx-item', { hasText: 'Отравлен' }).click();
  await gm.page.waitForTimeout(400);
  const mk = await board(pl, (id) => window.__board.store.col.obj.get(id)?.markers, tokId);
  if (!JSON.stringify(mk || []).includes('poisoned')) throw new Error('маркеры у игрока: ' + JSON.stringify(mk));
});

await step('порядок ходов: добавить, следующий ход', async () => {
  const o = await board(gm, (id) => window.__board.store.col.obj.get(id), tokId);
  const c = await screenOf(gm, o.x + o.w / 2, o.y + o.h / 2);
  await gm.page.mouse.click(c.x, c.y, { button: 'right' });
  await gm.page.locator('.ctx-item', { hasText: 'Порядок ходов' }).click();
  const win = gm.page.locator('.fwin', { hasText: 'Порядок ходов' });
  await win.waitFor();
  await win.getByRole('button', { name: 'Своя запись' }).click().catch(async () => win.locator('.icon-btn[title^="Своя запись"]').click());
  const dlg = gm.page.locator('.modal', { hasText: 'Запись в порядке ходов' });
  await dlg.locator('input').first().fill('Ловушка');
  await dlg.locator('input').first().press('Enter');
  await gm.page.waitForTimeout(500);
  const list = await board(pl, () => window.__board.store.state.turnorder || []);
  if (list.length !== 2) throw new Error('записей у игрока: ' + list.length);
  await win.getByRole('button', { name: 'Следующий ход' }).click();
  await gm.page.waitForTimeout(400);
  const list2 = await board(pl, () => window.__board.store.state.turnorder || []);
  if (list2[0].id !== list[1].id) throw new Error('ход не перешёл');
  await win.locator('.icon-btn[title="Закрыть"]').click();
});

await step('бар: игрок не может менять чужой токен', async () => {
  const r = await board(pl, async (id) => window.__board.net.update('obj', id, { x: 0, y: 0 }), tokId);
  await pl.page.waitForTimeout(300);
  const x = await board(gm, (id) => window.__board.store.col.obj.get(id).x, tokId);
  if (x === 0) throw new Error('игрок сдвинул токен мастера');
});

// ---------------------------------------------------------------- туман, линейка, пинг, эффекты
await step('туман: инструмент, открыть прямоугольник мышью', async () => {
  await gm.page.locator('.tool-btn[aria-label^="Туман войны"]').click();
  const enable = gm.page.locator('.tool-options .link-btn', { hasText: 'Включить' });
  if (await enable.count()) await enable.click();
  await gm.page.waitForTimeout(300);
  const before = await board(gm, () => (window.__board.store.page.fogOps || []).length);
  const a = await boardPoint(gm, 0.45, 0.45);
  const b = await boardPoint(gm, 0.8, 0.85);
  await gm.page.mouse.move(a.x, a.y);
  await gm.page.mouse.down();
  await gm.page.mouse.move(b.x, b.y, { steps: 6 });
  await gm.page.mouse.up();
  await gm.page.waitForTimeout(500);
  const ops = await board(pl, () => window.__board.store.page.fogOps || []);
  if (ops.length !== before + 1 || ops.at(-1).mode !== 'reveal') throw new Error('операций тумана у игрока: ' + ops.length);
  const fogOn = await board(pl, () => !!window.__board.store.page.fog?.enabled);
  if (!fogOn) throw new Error('туман не включился у игрока');
  await pl.page.screenshot({ path: `${SHOTS}/feat-fog-player.png` });
  // Ctrl+Z отменяет открытие тумана
  await gm.page.locator('.board').focus();
  await gm.page.keyboard.press('Control+z');
  await pl.page.waitForTimeout(600);
  const ops2 = await board(pl, () => window.__board.store.page.fogOps || []);
  if (ops2.length !== before) throw new Error('отмена тумана не сработала: ' + ops2.length);
  await gm.page.keyboard.press('Control+y');
  await pl.page.waitForTimeout(600);
  const ops3 = await board(pl, () => window.__board.store.page.fogOps || []);
  if (ops3.length !== before + 1) throw new Error('повтор тумана не сработал: ' + ops3.length);
  await gm.page.locator('.tool-btn[aria-label^="Выбор"]').click();
});

await step('линейка: измерение показывает расстояние', async () => {
  await gm.page.locator('.tool-btn[aria-label^="Линейка"]').click();
  const a0 = await boardPoint(gm, 0.4, 0.6);
  const w0 = await gm.page.evaluate(([x, y]) => {
    const r = document.querySelector('.board').getBoundingClientRect();
    return window.__board.screenToWorld(x - r.left, y - r.top);
  }, [a0.x, a0.y]);
  const cs = await board(gm, () => window.__board.store.page.cellSize);
  const cx = (Math.floor(w0.x / cs) + 0.5) * cs,
    cy = (Math.floor(w0.y / cs) + 0.5) * cs;
  const a = await screenOf(gm, cx, cy);
  const b = await screenOf(gm, cx + cs * 4, cy);
  await gm.page.mouse.move(a.x, a.y);
  await gm.page.mouse.down();
  await gm.page.mouse.move(b.x, b.y, { steps: 5 });
  await gm.page.waitForTimeout(200);
  const label = await gm.page.locator('.board svg text').allTextContents();
  await gm.page.mouse.up();
  if (!label.some((t) => /20\s*фт/.test(t))) throw new Error('подписи: ' + JSON.stringify(label));
  await gm.page.locator('.tool-btn[aria-label^="Выбор"]').click();
});

await step('пинг долгим нажатием доходит до игрока', async () => {
  const p = await boardPoint(gm, 0.6, 0.7);
  await gm.page.mouse.move(p.x, p.y);
  await gm.page.mouse.down();
  await gm.page.waitForTimeout(800);
  await gm.page.mouse.up();
  await pl.page.locator('.ping').first().waitFor({ state: 'attached', timeout: 3000 });
});

await step('спецэффект доходит до игрока', async () => {
  await gm.page.locator('.tool-btn[aria-label^="Спецэффекты"]').click();
  const p = await boardPoint(gm, 0.55, 0.75);
  await gm.page.mouse.click(p.x, p.y);
  await pl.page.waitForTimeout(250);
  const n = await board(pl, () => window.__board.fx.parts?.length ?? -1);
  if (!(n > 0)) throw new Error('частиц у игрока: ' + n);
  await gm.page.locator('.tool-btn[aria-label^="Выбор"]').click();
});

await step('погода из настроек сцены', async () => {
  await board(gm, () => {
    const s = window.__board.store;
    return window.__board.net.update('page', s.page.id, { weather: { type: 'rain', intensity: 0.6, wind: 0.3 } });
  });
  await pl.page.waitForTimeout(600);
  const w = await board(pl, () => window.__board.fx.weather?.type || window.__board.store.page.weather?.type);
  if (w !== 'rain') throw new Error('погода у игрока: ' + w);
  await pl.page.screenshot({ path: `${SHOTS}/feat-weather-player.png` });
  await board(gm, () => window.__board.net.update('page', window.__board.store.page.id, { weather: { type: 'none' } }));
});

// ---------------------------------------------------------------- музыка
await step('музыка: загрузка трека и синхронный запуск у игрока', async () => {
  await gm.page.getByRole('tab', { name: 'Музыка и звуки' }).click();
  await gm.page.locator('.jukebox-panel input[type=file]').setInputFiles(path.join(ASSETS, 'tone.wav'));
  const row = gm.page.locator('.track-row').first();
  await row.waitFor({ timeout: 8000 });
  await row.locator('.run-btn').click();
  await pl.page.waitForTimeout(800);
  const playing = await board(pl, () => Object.keys(window.__board.store.state.jukebox?.playing || {}).length);
  if (playing !== 1) throw new Error('играет у игрока: ' + playing);
  await gm.page.getByRole('button', { name: 'Стоп всё' }).click();
  await pl.page.waitForTimeout(500);
  const playing2 = await board(pl, () => Object.keys(window.__board.store.state.jukebox?.playing || {}).length);
  if (playing2 !== 0) throw new Error('не остановилось');
});

await step('музыка: плейлист по порядку, переход по окончании трека', async () => {
  await gm.page.getByRole('tab', { name: 'Музыка и звуки' }).click();
  await gm.page.locator('.jukebox-panel input[type=file]').setInputFiles(path.join(ASSETS, 'tone.wav'));
  await gm.page.waitForTimeout(1200);
  await board(gm, async () => {
    const b = window.__board;
    const list = [...b.store.col.track.values()];
    for (const [i, t] of list.entries()) await b.net.update('track', t.id, { playlist: 'Бой', name: 'Трек ' + (i + 1) });
  });
  await gm.page.waitForTimeout(500);
  await gm.page.locator('.pl-head', { hasText: 'Бой' }).getByRole('button', { name: 'Играть плейлист по порядку' }).click();
  await pl.page.waitForTimeout(600);
  const st1 = await board(pl, () => window.__board.store.state.jukebox?.playlist);
  if (!st1 || st1.queue.length !== 2 || st1.index !== 0) throw new Error('плейлист у игрока: ' + JSON.stringify(st1));
  await gm.page.locator('.now-playing').waitFor();
  // трек длится 2 секунды — дальше сервер включает следующий
  await pl.page.waitForTimeout(3500);
  const st2 = await board(pl, () => window.__board.store.state.jukebox?.playlist);
  if (!st2 || st2.index !== 1) throw new Error('не перешёл к следующему: ' + JSON.stringify(st2));
  await gm.page.getByRole('button', { name: 'Остановить плейлист' }).click();
  await pl.page.waitForTimeout(500);
  const st3 = await board(pl, () => window.__board.store.state.jukebox);
  if (st3?.playlist || Object.keys(st3?.playing || {}).length) throw new Error('не остановился: ' + JSON.stringify(st3));
});

await step('журнал чата скачивается одним файлом', async () => {
  await gm.page.getByRole('tab', { name: 'Настройки' }).click();
  const [dl] = await Promise.all([gm.page.waitForEvent('download', { timeout: 15000 }), gm.page.getByRole('button', { name: 'Скачать журнал чата' }).click()]);
  const file = await dl.path();
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes('Стой, кто идёт?') || !html.includes('sheet-rolltemplate-default')) throw new Error('в журнале нет сообщений');
  console.log('   файл:', dl.suggestedFilename(), Math.round(html.length / 1024), 'КБ');
});

// ---------------------------------------------------------------- права и сцены
await step('игрок получает только свою сцену; переход на другую сцену', async () => {
  const ids = await board(gm, async () => {
    const b = window.__board;
    const p2 = await b.net.create('page', { name: 'Логово', width: 10, height: 10 });
    await b.net.create('obj', { type: 'shape', shape: 'star', pageId: p2.id, layer: 'objects', x: 70, y: 70, w: 70, h: 70, fill: '#ff0', name: 'Сокровище' });
    return { p2: p2.id, p1: b.store.state.playerPageId };
  });
  await pl.page.waitForTimeout(500);
  const seen = await board(pl, () => ({ pages: window.__board.store.col.page.size, treasure: [...window.__board.store.col.obj.values()].some((o) => o.name === 'Сокровище') }));
  if (seen.pages !== 1 || seen.treasure) throw new Error('игрок видит чужую сцену: ' + JSON.stringify(seen));
  await board(gm, (p2) => window.__board.net.request('state', { playerPageId: p2 }), ids.p2);
  await pl.page.waitForTimeout(900);
  const now = await board(pl, () => ({ page: window.__board.store.ui.pageId, treasure: [...window.__board.store.col.obj.values()].some((o) => o.name === 'Сокровище') }));
  if (now.page !== ids.p2 || !now.treasure) throw new Error('после перехода: ' + JSON.stringify(now));
  await board(gm, (p1) => window.__board.net.request('state', { playerPageId: p1 }), ids.p1);
  await pl.page.waitForTimeout(700);
});

await step('исключённый игрок теряет доступ сразу', async () => {
  const r = await gm.api(`/api/games/${game.id}/members/${pl.user.id}`, {}, 'DELETE');
  if (!r.ok) throw new Error(JSON.stringify(r));
  await pl.page.locator('.game-fatal').waitFor({ timeout: 5000 });
  const res = await pl.page.evaluate(() => new Promise((ok) => window.__board.net.socket.emit('chat', { text: 'я ещё здесь' }, ok)).catch((e) => ({ error: String(e) })));
  await gm.page.waitForTimeout(400);
  const leaked = await gm.page.locator('.textchatcontainer .message', { hasText: 'я ещё здесь' }).count();
  if (leaked) throw new Error('сообщение исключённого дошло до чата');
});

await gm.page.screenshot({ path: `${SHOTS}/feat-final-gm.png` });
await pl.page.screenshot({ path: `${SHOTS}/feat-final-pl.png` });
console.log(failures.length ? `\nНе прошло: ${failures.length} — ${failures.join('; ')}` : '\nВсе проверки прошли');
console.log('ошибки консоли:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'нет');
await browser.close();
process.exit(failures.length ? 1 : 0);
