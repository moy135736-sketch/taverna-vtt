// e2e: пример стола «Логово гоблинов» — создание из лобби, содержимое, вид игрока (свет, стены, двери)
// Запуск: node tests/e2e/demo.mjs (сервер на http://localhost:3000)
import { chromium } from 'playwright-core';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'taverna-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
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
  const api = (p, body) =>
    page.evaluate(
      async ([p, body]) => {
        const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [p, body],
    );
  const r = await api('/api/auth/register', { username: 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
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
    await gm.page.screenshot({ path: `${SHOTS}/demo-fail-${safe}-gm.png` }).catch(() => {});
    if (pl) await pl.page.screenshot({ path: `${SHOTS}/demo-fail-${safe}-pl.png` }).catch(() => {});
  }
}

const boardBox = (u) => u.page.locator('.board').boundingBox();
async function screenOf(u, wx, wy) {
  const box = await boardBox(u);
  const p = await u.page.evaluate(([x, y]) => window.__board.worldToScreen(x, y), [wx, wy]);
  return { x: box.x + p.x, y: box.y + p.y };
}
/** перетащить токен мышью из центра в точку мира */
async function dragToken(u, id, wx, wy) {
  const o = await u.page.evaluate((id) => window.__board.store.col.obj.get(id), id);
  const from = await screenOf(u, o.x + o.w / 2, o.y + o.h / 2);
  const to = await screenOf(u, wx, wy);
  await u.page.mouse.move(from.x, from.y);
  await u.page.mouse.down();
  for (let i = 1; i <= 12; i++) await u.page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  await u.page.mouse.up();
  await u.page.waitForTimeout(700);
  return u.page.evaluate((id) => window.__board.store.col.obj.get(id), id);
}
/** средняя яркость области экрана вокруг точки мира (по скриншоту) */
async function brightness(u, wx, wy, r = 20) {
  const c = await screenOf(u, wx, wy);
  const buf = await u.page.screenshot({ clip: { x: c.x - r, y: c.y - r, width: r * 2, height: r * 2 } });
  return u.page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = new OffscreenCanvas(img.width, img.height);
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return Math.round(s / (d.length / 4));
  }, buf.toString('base64'));
}

const gm = await newUser('Мастер');
let pl = null;
let game;
const CS = 70;

await step('лобби: кнопка «Открыть пример стола» создаёт стол', async () => {
  await gm.page.goto(BASE);
  await gm.page.getByRole('button', { name: 'Открыть пример стола' }).click();
  await gm.page.waitForURL(/\/game\//, { timeout: 15000 });
  await gm.page.waitForSelector('.board-world', { state: 'attached' });
  await gm.page.waitForTimeout(1200);
  const id = gm.page.url().split('/game/')[1];
  game = (await gm.api('/api/games')).games.find((g) => g.id === id);
  if (!game) throw new Error('стол не найден');
  if (!game.sheet) throw new Error('у примера нет листа персонажа');
});

let ids = {};
await step('содержимое: стены, двери, свет, токены, персонажи, памятки', async () => {
  const info = await gm.page.evaluate(() => {
    const s = window.__board.store;
    const objs = s.objsOnPage();
    const by = (f) => objs.filter(f);
    return {
      walls: by((o) => o.type === 'wall' && o.wallType === 'wall').length,
      doors: by((o) => o.type === 'wall' && o.wallType === 'door').map((o) => o.id),
      lights: by((o) => o.light?.enabled).length,
      hero: by((o) => o.name === 'Тарен')[0]?.id,
      goblins: by((o) => /^Гоблин/.test(o.name)).map((o) => o.id),
      boss: by((o) => o.name === 'Грук' && o.layer === 'gm')[0]?.id,
      chars: [...s.col.char.values()].map((c) => c.name),
      handouts: [...s.col.handout.values()].map((h) => h.name),
      tables: s.col.rtable.size,
      macros: s.col.macro.size,
      lighting: s.page?.lighting?.enabled,
    };
  });
  console.log('   ', JSON.stringify({ ...info, doors: info.doors.length, goblins: info.goblins.length }));
  if (info.walls < 10 || info.doors.length !== 2 || info.lights < 2) throw new Error('карта неполная');
  if (!info.hero || info.goblins.length !== 3 || !info.boss) throw new Error('токены неполные');
  if (info.chars.length !== 3 || info.handouts.length !== 2 || !info.tables || !info.macros) throw new Error('журнал неполный');
  if (!info.lighting) throw new Error('динамический свет выключен');
  ids = info;
  await gm.page.screenshot({ path: `${SHOTS}/demo-gm.png` });
});

await step('игрок входит по коду и получает героя', async () => {
  pl = await newUser('Аня');
  const j = await pl.api('/api/games/join', { code: game.inviteCode });
  if (!j.game) throw new Error(JSON.stringify(j));
  const heroChar = await gm.page.evaluate((id) => window.__board.store.col.obj.get(id).represents, ids.hero);
  await gm.page.evaluate(([cid, uid]) => window.__board.net.update('char', cid, { controlledBy: [uid] }), [heroChar, pl.user.id]);
  await pl.page.goto(`${BASE}/game/${game.id}`);
  await pl.page.waitForSelector('.board-world', { state: 'attached' });
  await pl.page.waitForTimeout(1500);
  const v = await pl.page.evaluate(([hero, boss]) => {
    const s = window.__board.store;
    return { control: s.canControlObj(s.col.obj.get(hero)), boss: s.col.obj.has(boss), handouts: [...s.col.handout.values()].map((h) => h.name) };
  }, [ids.hero, ids.boss]);
  if (!v.control) throw new Error('игрок не управляет героем');
  if (v.boss) throw new Error('игрок видит токен со слоя мастера');
  if (v.handouts.length !== 1) throw new Error('памятки игрока: ' + v.handouts.join(', '));
});

await step('вид игрока: зал освещён, казарма в темноте', async () => {
  // центрируем вид игрока на карте, чтобы обе комнаты попали в кадр
  await pl.page.evaluate(() => window.__board.fitPage?.());
  await pl.page.waitForTimeout(800);
  const hall = await brightness(pl, 5.5 * CS, 3 * CS);
  const barracks = await brightness(pl, 17 * CS, 6.5 * CS);
  console.log('   яркость: зал', hall, ', казарма', barracks);
  await pl.page.screenshot({ path: `${SHOTS}/demo-player.png` });
  if (!(hall > barracks + 30)) throw new Error(`зал ${hall} не светлее казармы ${barracks}`);
  const hidden = await pl.page.evaluate((ids) => ids.filter((id) => document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains('unseen')).length, ids.goblins);
  if (hidden !== 3) throw new Error('гоблинов в темноте скрыто: ' + hidden);
  const doors = await pl.page.locator('.door-btn').count();
  if (doors !== 1) throw new Error('игроку видно дверей: ' + doors + ' (ожидалась одна — в зале)');
});

await step('метки на карте: игрок открывает заметку у костра, метку мастера не видит', async () => {
  const pins = await pl.page.evaluate(() => [...window.__board.store.col.obj.values()].filter((o) => o.type === 'pin').map((o) => ({ id: o.id, name: o.name })));
  if (pins.length !== 1 || pins[0].name !== 'Кострище') throw new Error('метки игрока: ' + JSON.stringify(pins));
  const gmPins = await gm.page.evaluate(() => [...window.__board.store.col.obj.values()].filter((o) => o.type === 'pin').length);
  if (gmPins !== 2) throw new Error('меток у мастера: ' + gmPins);
  await pl.page.locator(`.obj[data-oid="${pins[0].id}"]`).click();
  await pl.page.getByText('Угли ещё тёплые').waitFor({ timeout: 4000 });
  await pl.page.screenshot({ path: `${SHOTS}/demo-pin.png` });
  await pl.page.keyboard.press('Escape');
});

await step('мастер ставит метку инструментом и настраивает её', async () => {
  await gm.page.locator('.tool-btn[aria-label^="Метка на карте"]').click();
  const p = await screenOf(gm, 4 * CS, 6 * CS);
  await gm.page.mouse.click(p.x, p.y);
  await gm.page.getByRole('dialog', { name: 'Метка на карте' }).waitFor({ timeout: 4000 });
  const dlg = gm.page.getByRole('dialog', { name: 'Метка на карте' });
  await dlg.locator('input.input').first().fill('Тайник');
  await dlg.locator('textarea').fill('Под плитой пола — пустота.');
  await dlg.getByRole('button', { name: 'Сохранить' }).click();
  await pl.page.waitForFunction(() => [...window.__board.store.col.obj.values()].some((o) => o.type === 'pin' && o.name === 'Тайник'), null, { timeout: 4000 });
});

await step('стена с закрытой дверью не пускает героя', async () => {
  const o = await dragToken(pl, ids.hero, 11.5 * CS, 4.5 * CS);
  console.log('   герой на', o.x / CS, o.y / CS);
  if (o.x + o.w > 9 * CS + 1) throw new Error('герой прошёл сквозь дверь: x=' + o.x);
});

await step('мастер открывает дверь — герой проходит, гоблины видны', async () => {
  // открыть именно дверь зала (у x = 9 клеток)
  await gm.page.evaluate(() => {
    const s = window.__board.store;
    for (const o of s.objsOnPage()) if (o.type === 'wall' && o.wallType === 'door' && o.pts[0] === 9 * 70) window.__board.net.update('obj', o.id, { open: true });
  });
  await pl.page.waitForTimeout(800);
  const o = await dragToken(pl, ids.hero, 11.5 * CS, 4.5 * CS);
  console.log('   герой на', o.x / CS, o.y / CS);
  if (o.x < 10 * CS) throw new Error('герой не прошёл в открытую дверь: x=' + o.x);
  await pl.page.waitForTimeout(600);
  const gob = await brightness(pl, 15.5 * CS, 4.5 * CS, 14);
  console.log('   яркость у гоблина', gob);
  await pl.page.screenshot({ path: `${SHOTS}/demo-player-door.png` });
  const shown = await pl.page.evaluate((ids) => ids.filter((id) => !document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains('unseen')).length, ids.goblins);
  console.log('   видно гоблинов:', shown);
  if (shown < 1) throw new Error('гоблины в свете героя не показаны');
});

await step('гоблин уходит в тёмную кладовую — у игрока пропадает', async () => {
  const gid = ids.goblins[2];
  await gm.page.evaluate(([id, x, y]) => window.__board.net.update('obj', id, { x, y }), [gid, 4 * CS, 12 * CS]);
  await pl.page.waitForFunction((id) => document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains('unseen'), gid, { timeout: 5000 });
});

await step('мастер «глазами игроков»: скрытое полупрозрачно', async () => {
  await gm.page.evaluate(() => {
    const s = window.__board.store;
    s.ui.gmViewAsPlayer = true;
    s.emit('ui:viewAsPlayer');
  });
  await gm.page.waitForTimeout(500);
  const dim = await gm.page.evaluate((ids) => ids.filter((id) => document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains('unseen-gm')).length, ids.goblins);
  const hidden = await gm.page.locator('.obj.unseen').count();
  console.log('   полупрозрачных у мастера:', dim, ', скрытых:', hidden);
  if (hidden) throw new Error('у мастера токены скрыты');
  if (dim !== 1) throw new Error('ожидался один полупрозрачный гоблин');
  await gm.page.screenshot({ path: `${SHOTS}/demo-gm-as-player.png` });
  await gm.page.evaluate(() => {
    window.__board.store.ui.gmViewAsPlayer = false;
    window.__board.store.emit('ui:viewAsPlayer');
  });
  await gm.page.waitForTimeout(400);
  if (await gm.page.locator('.obj.unseen-gm').count()) throw new Error('после выхода из режима остались полупрозрачные');
});

await step('общий обзор: глазами гоблина-перебежчика игрок видит кладовую', async () => {
  const gid = ids.goblins[2];
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { vision: { enabled: true, range: 0, darkvision: 60, angle: 360, shared: true } }), gid);
  await pl.page.waitForFunction((id) => !document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains('unseen'), gid, { timeout: 5000 });
  const can = await pl.page.evaluate((id) => window.__board.store.canControlObj(window.__board.store.col.obj.get(id)), gid);
  if (can) throw new Error('общий обзор не должен давать управление');
  await gm.page.evaluate((id) => window.__board.net.update('obj', id, { vision: { enabled: false, shared: false } }), gid);
  await pl.page.waitForFunction((id) => document.querySelector(`.obj[data-oid="${id}"]`)?.classList.contains('unseen'), gid, { timeout: 5000 });
});

await step('путь с поворотом: герой обходит угол за одно перетаскивание, мастер видит путь', async () => {
  const o = await pl.page.evaluate((id) => window.__board.store.col.obj.get(id), ids.hero);
  const from = await screenOf(pl, o.x + o.w / 2, o.y + o.h / 2);
  // через казарму вниз, в коридор к логову: прямой путь упирается в стену
  const route = [
    [17.5 * CS, 6.5 * CS],
    [18 * CS, 9.5 * CS],
  ];
  await pl.page.mouse.move(from.x, from.y);
  await pl.page.mouse.down();
  let prev = from;
  for (const [wx, wy] of route) {
    const to = await screenOf(pl, wx, wy);
    for (let i = 1; i <= 14; i++) await pl.page.mouse.move(prev.x + ((to.x - prev.x) * i) / 14, prev.y + ((to.y - prev.y) * i) / 14);
    prev = to;
  }
  await pl.page.waitForTimeout(300);
  const nodes = await pl.page.locator('.ruler-node').count();
  const gmLabel = await gm.page.locator('.ruler-text').allTextContents();
  await pl.page.mouse.up();
  await pl.page.waitForTimeout(700);
  const end = await pl.page.evaluate((id) => window.__board.store.col.obj.get(id), ids.hero);
  console.log('   точек пути:', nodes, '; у мастера:', gmLabel.join(' | '), '; герой на', end.x / CS, end.y / CS);
  if (nodes < 3) throw new Error('нет точки поворота на пути');
  if (!gmLabel.some((t) => t.includes('Тарен'))) throw new Error('мастер не видит путь героя');
  if (!(end.y >= 8 * CS && end.x >= 17 * CS - 1)) throw new Error('герой не дошёл до коридора');
  await pl.page.waitForTimeout(400);
  if (await gm.page.locator('.ruler-text').count()) throw new Error('путь у мастера не исчез после отпускания');
});

await step('действие токена героя бросает атаку с настоящего листа D&D 5E', async () => {
  await pl.page.evaluate((id) => window.__board.store.setSelection([id]), ids.hero);
  await pl.page.getByRole('tab', { name: 'Чат' }).click();
  await pl.page.locator('.macro-bar .mbtn', { hasText: 'Длинный-меч' }).click();
  await pl.page.locator('.textchatcontainer .sheet-rolltemplate-atk').last().waitFor({ timeout: 8000 });
  const txt = await pl.page.locator('.textchatcontainer .sheet-rolltemplate-atk').last().textContent();
  if (!/Длинный меч/.test(txt) || !/\+5/.test(txt)) throw new Error('шаблон атаки: ' + txt.slice(0, 120));
  // щелчок по названию атаки в шаблоне — бросок урона (кнопка строки листа)
  const before = await pl.page.locator('.textchatcontainer .message').count();
  await pl.page.locator('.textchatcontainer .sheet-rolltemplate-atk').last().locator('a', { hasText: 'Длинный меч' }).first().click();
  await pl.page.waitForFunction((n) => document.querySelectorAll('.textchatcontainer .message').length > n, before, { timeout: 8000 });
  const dmg = await pl.page.locator('.textchatcontainer .message').last().textContent();
  if (!/рубящий/.test(dmg)) throw new Error('бросок урона: ' + dmg.slice(0, 160));
});

await step('лист гоблина у мастера — блок характеристик NPC', async () => {
  const gobChar = await gm.page.evaluate(() => [...window.__board.store.col.char.values()].find((c) => c.name === 'Гоблин').id);
  await gm.page.evaluate((id) => window.__board.hooks.openCharacter(id), gobChar);
  const frame = gm.page.frameLocator('.sheet-frame').last();
  await frame.locator('.charsheet').waitFor({ timeout: 15000 });
  await gm.page.waitForTimeout(1500);
  const name = await frame.locator('span[name="attr_npc_name"]').first().textContent();
  if (name.trim() !== 'Гоблин') throw new Error('имя NPC: ' + name);
});

await step('памятка открывается у игрока', async () => {
  await pl.page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await pl.page.getByText('Памятка: с чего начать').click();
  await pl.page.getByText('Добро пожаловать в «Таверну»!').waitFor({ timeout: 5000 });
  await pl.page.screenshot({ path: `${SHOTS}/demo-guide.png` });
});

console.log('ошибки:', errors.length ? '\n' + errors.slice(0, 30).join('\n') : 'нет');
await browser.close();
if (failures.length) {
  console.log('Провалено:', failures.join('; '));
  process.exit(1);
}
