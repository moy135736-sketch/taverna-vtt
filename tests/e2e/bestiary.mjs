// e2e: бестиарий мастера — монстры SRD 5.2.1 на карту (персонаж в журнале, токены по размеру, кнопки бросков),
// статблок в окне персонажа, броски только мастеру, лист D&D 2024, загрузка монстров по ссылке с GitHub и из файла
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body, method) =>
    page.evaluate(
      async ([p, body, method]) => {
        const r = await fetch(p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, ...(await r.json()) };
      },
      [p, body, method],
    );
  const r = await api('/api/auth/register', { username: 'bs' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { ctx, page, api, user: r.user };
}
let gm, pl;
async function step(name, fn) {
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n').slice(0, 4).join(' | '));
    failures.push(name);
    const n = failures.length;
    await gm?.page.screenshot({ path: `${SHOTS}/bestiary-fail-${n}-gm.png` }).catch(() => {});
    await pl?.page.screenshot({ path: `${SHOTS}/bestiary-fail-${n}-pl.png` }).catch(() => {});
  }
}
async function waitFor(page, fn, arg, what, timeout = 8000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(what);
  }
}
const objs = (page, re) => page.evaluate((src) => [...window.__board.store.col.obj.values()].filter((o) => new RegExp(src).test(o.name || '')).map((o) => ({ id: o.id, name: o.name, w: o.w, h: o.h, layer: o.layer, bars: o.bars, represents: o.represents, src: o.src })), re.source);
const monsterChars = (page) => page.evaluate(() => [...window.__board.store.col.char.values()].filter((c) => c.statblock).map((c) => ({ id: c.id, name: c.name, folder: c.folder, sb: c.statblock.id, source: c.statblock.source, abilities: (c.abilities || []).length })));
const lastMsg = (page) => page.evaluate(() => {
  const m = window.__board.store.messages.at(-1);
  return m ? { id: m.id, who: m.who, type: m.type, content: m.content, inline: (m.inlinerolls || []).length, roll: m.roll?.total, toGM: !!m.toGM } : null;
});
const bestiary = gm => gm.page.locator('.bestiary-modal');
async function openBestiary() {
  await gm.page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  await gm.page.locator('.journal-panel').getByRole('button', { name: 'Бестиарий' }).click();
  await gm.page.locator('.bst-item').first().waitFor();
}
async function placeFromBestiary(id, count = 1, hidden = false) {
  await gm.page.locator(`.bst-item[data-mid="${id}"]`).click();
  await gm.page.locator('.bst-count input').fill(String(count));
  const t = gm.page.locator('.bst-foot .toggle input');
  if ((await t.isChecked()) !== hidden) await gm.page.locator('.bst-foot .toggle').click();
  await gm.page.locator('.bst-foot').getByRole('button', { name: 'На карту' }).click();
  await gm.page.locator('.bestiary-modal').waitFor({ state: 'detached' });
}

gm = await newUser('Мастер');
pl = await newUser('Игрок');
const sheet = (await gm.api('/api/sheets')).sheets.find((s) => s.sourceRef === 'DnD2024');
if (!sheet) throw new Error('нет листа DnD2024');
const game = (await gm.api('/api/games', { name: 'Логово', sheetId: sheet.id })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
await gm.page.goto(`${BASE}/game/${game.id}`);
await pl.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await pl.page.waitForSelector('.board');
await gm.page.evaluate(() => window.__board.store.setTool('select'));

await step('бестиарий: только у мастера; 330 монстров SRD 5.2.1, поиск по-русски, фильтры типа и опасности', async () => {
  await pl.page.getByRole('tab', { name: 'Журнал: персонажи и материалы' }).click();
  if (await pl.page.locator('.journal-panel').getByRole('button', { name: 'Бестиарий' }).count()) throw new Error('у игрока есть кнопка бестиария');
  await openBestiary();
  const n = await gm.page.locator('.bst-item').count();
  if (n !== 330) throw new Error('монстров: ' + n);
  await gm.page.getByLabel('Поиск монстра').fill('гоблин');
  const names = await gm.page.locator('.bst-item').evaluateAll((els) => els.map((e) => e.dataset.mid));
  if (!names.includes('goblin-warrior') || !names.includes('goblin-boss')) throw new Error('гоблины: ' + names);
  await gm.page.getByLabel('Поиск монстра').fill('');
  await gm.page.getByLabel('Тип существа').selectOption('dragon');
  await gm.page.getByLabel('Опасность').selectOption('17-30');
  const dragons = await gm.page.locator('.bst-cr').allInnerTexts();
  if (!dragons.length || dragons.some((c) => Number(c) < 17)) throw new Error('драконы 17+: ' + dragons);
  // статблок справа: древний красный дракон
  await gm.page.locator('.bst-item[data-mid="ancient-red-dragon"]').click();
  await gm.page.locator('.bst-preview .sb-name', { hasText: 'Ancient Red Dragon' }).waitFor();
  if (!(await gm.page.locator('.bst-preview').textContent()).includes('Древний красный дракон')) throw new Error('нет русского имени');
  if (!(await gm.page.locator('.bst-preview h4', { hasText: 'Legendary Actions' }).count())) throw new Error('нет легендарных действий');
  if (!(await gm.page.locator('.bst-credit').textContent()).includes('Creative Commons Attribution 4.0')) throw new Error('нет атрибуции SRD');
  await gm.page.getByLabel('Тип существа').selectOption('');
  await gm.page.getByLabel('Опасность').selectOption('');
  await gm.page.screenshot({ path: `${SHOTS}/bestiary-modal.png` });
});

let goblinChar = null;
await step('три гоблина-воина на карту: персонаж в «Монстрах», токены 1×1 с номерами и своими хитами, видны игроку', async () => {
  await gm.page.getByLabel('Поиск монстра').fill('goblin warrior');
  await placeFromBestiary('goblin-warrior', 3);
  await waitFor(gm.page, () => [...window.__board.store.col.obj.values()].filter((o) => /^Goblin Warrior/.test(o.name || '')).length === 3, null, 'нет трёх токенов');
  const toks = await objs(gm.page, /^Goblin Warrior/);
  const names = toks.map((t) => t.name).sort();
  if (names.join('|') !== 'Goblin Warrior|Goblin Warrior 2|Goblin Warrior 3') throw new Error('имена: ' + names);
  if (toks.some((t) => t.w !== 70 || t.h !== 70 || t.layer !== 'objects')) throw new Error('размер или слой: ' + JSON.stringify(toks.map((t) => [t.w, t.h, t.layer])));
  if (toks.some((t) => t.bars?.[0]?.value !== 10 || t.bars[0].max !== 10 || t.bars[0].link)) throw new Error('хиты: ' + JSON.stringify(toks[0].bars));
  if (!toks.every((t) => /^data:image\/svg\+xml/.test(t.src))) throw new Error('картинка токена');
  // токены не слиплись: между ними клетка
  const xs = await gm.page.evaluate(() => [...window.__board.store.col.obj.values()].filter((o) => /^Goblin Warrior/.test(o.name || '')).map((o) => [o.x, o.y]));
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (Math.abs(xs[i][0] - xs[j][0]) < 140 && Math.abs(xs[i][1] - xs[j][1]) < 140) throw new Error('токены рядом: ' + JSON.stringify(xs));
  const chars = await monsterChars(gm.page);
  if (chars.length !== 1 || chars[0].folder !== 'Монстры' || chars[0].sb !== 'goblin-warrior' || chars[0].source !== 'SRD 5.2.1') throw new Error('персонаж: ' + JSON.stringify(chars));
  goblinChar = chars[0].id;
  if (toks.some((t) => t.represents !== goblinChar)) throw new Error('токены не связаны с персонажем');
  // атрибуты для листа
  const at = await gm.page.evaluate(async (id) => {
    const m = await window.__board.net.ensureAttrs(id);
    const g = (n) => m.get(n)?.current;
    return { hp: g('hp'), hpMax: m.get('hp')?.max, ac: g('ac'), dex: g('dexterity'), stealth: g('stealth_prof'), pb: g('pb_custom') };
  }, goblinChar);
  if (String(at.hp) !== '10' || String(at.hpMax) !== '10' || String(at.ac) !== '15' || String(at.dex) !== '15' || String(at.stealth) !== '2' || String(at.pb) !== '2') throw new Error('атрибуты: ' + JSON.stringify(at));
  // лист D&D 2024 пересчитался сам, без открытия: Скрытность +6 (экспертиза), инициатива +2
  await waitFor(gm.page, (id) => String(window.__board.store.getAttr(id, 'stealth_bonus')?.current) === '6' && String(window.__board.store.getAttr(id, 'initiative_bonus')?.current) === '2', goblinChar, 'лист не пересчитан: ' + JSON.stringify(await gm.page.evaluate((id) => ['stealth_bonus', 'initiative_bonus', 'pb'].map((n) => window.__board.store.getAttr(id, n)?.current), goblinChar)), 5000);
  await waitFor(pl.page, () => [...window.__board.store.col.obj.values()].filter((o) => /^Goblin Warrior/.test(o.name || '')).length === 3, null, 'игрок не видит гоблинов');
  // в журнале — картинка токена
  await gm.page.locator('.j-item', { hasText: 'Goblin Warrior' }).locator('img').waitFor();
});

await step('спрятанный гоблин — на слое мастера, тот же персонаж; игрок его не видит', async () => {
  await openBestiary();
  await gm.page.getByLabel('Поиск монстра').fill('goblin warrior');
  if (!(await gm.page.locator('.bst-foot').textContent()).includes('Уже в журнале')) throw new Error('нет подсказки «уже в журнале»');
  await placeFromBestiary('goblin-warrior', 1, true);
  await waitFor(gm.page, () => [...window.__board.store.col.obj.values()].some((o) => o.name === 'Goblin Warrior 4'), null, 'нет четвёртого');
  const t = (await objs(gm.page, /^Goblin Warrior 4$/))[0];
  if (t.layer !== 'gm') throw new Error('слой ' + t.layer);
  if ((await monsterChars(gm.page)).length !== 1) throw new Error('создан второй персонаж');
  await pl.page.waitForTimeout(400);
  if ((await objs(pl.page, /^Goblin Warrior 4$/)).length) throw new Error('игрок видит спрятанного');
});

await step('огр — большой: токен 2×2', async () => {
  await openBestiary();
  await gm.page.getByLabel('Поиск монстра').fill('огр');
  await placeFromBestiary('ogre');
  await waitFor(gm.page, () => [...window.__board.store.col.obj.values()].some((o) => o.name === 'Ogre'), null, 'нет огра');
  const o = (await objs(gm.page, /^Ogre$/))[0];
  if (o.w !== 140 || o.h !== 140) throw new Error(`размер ${o.w}×${o.h}`);
});

await step('кнопки токена: атака саблей — карточка в чат от имени гоблина, броски атаки и урона; видит и игрок', async () => {
  const id = (await objs(gm.page, /^Goblin Warrior 2$/))[0].id;
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), id);
  const btns = await gm.page.locator('.mbtn.ta').allInnerTexts();
  for (const b of ['Инициатива', 'Спасбросок', 'Scimitar', 'Shortbow', 'Nimble Escape (бонус)']) if (!btns.includes(b)) throw new Error('кнопки: ' + btns);
  const before = (await lastMsg(gm.page))?.id;
  await gm.page.locator('.mbtn.ta', { hasText: 'Scimitar' }).click();
  await waitFor(gm.page, (b) => window.__board.store.messages.at(-1)?.id !== b && /Scimitar/.test(window.__board.store.messages.at(-1)?.content || ''), before, 'нет броска');
  const m = await lastMsg(gm.page);
  if (m.who !== 'Goblin Warrior' || m.inline !== 3 || !/Атака=/.test(m.content) || !/Урон=/.test(m.content)) throw new Error('сообщение: ' + JSON.stringify(m));
  await waitFor(pl.page, () => /Scimitar/.test(window.__board.store.messages.at(-1)?.content || ''), null, 'игрок не видит атаку');
});

await step('статблок в окне персонажа: открыт сразу; щелчок по действию — бросок; инициатива двум выделенным', async () => {
  await gm.page.locator('.j-item', { hasText: 'Goblin Warrior' }).click();
  await gm.page.locator('.statblock-tab .sb-name', { hasText: 'Goblin Warrior' }).waitFor();
  if ((await gm.page.locator('.char-tabs .tab.active').innerText()) !== 'Статблок') throw new Error('открыта не вкладка статблока');
  const before = (await lastMsg(gm.page))?.id;
  await gm.page.locator('.statblock-tab button.sb-ename', { hasText: 'Shortbow' }).click();
  await waitFor(gm.page, (b) => window.__board.store.messages.at(-1)?.id !== b && /Shortbow/.test(window.__board.store.messages.at(-1)?.content || ''), before, 'нет броска лука');
  // без броска — описанием
  await gm.page.locator('.statblock-tab button.sb-ename', { hasText: 'Nimble Escape' }).click();
  await waitFor(gm.page, () => /Nimble Escape/.test(window.__board.store.messages.at(-1)?.content || '') && /Disengage/.test(window.__board.store.messages.at(-1)?.content || ''), null, 'нет описания');
  const ids = (await objs(gm.page, /^Goblin Warrior( 2| 3)?$/)).filter((t) => t.name !== 'Goblin Warrior').map((t) => t.id);
  await gm.page.evaluate((ids) => window.__board.store.setSelection(ids), ids);
  await gm.page.locator('.sbt-bar').getByRole('button', { name: 'Инициатива' }).click();
  await waitFor(gm.page, (ids) => ids.every((id) => (window.__board.store.game?.state?.turnorder || window.__board.store.turnorder || []).some?.((e) => e.tokenId === id)), ids, 'нет в порядке ходов');
  const tos = await gm.page.evaluate((ids) => (window.__board.store.game?.state?.turnorder || window.__board.store.turnorder || []).filter((e) => ids.includes(e.tokenId)).map((e) => e.pr), ids);
  if (tos.length !== 2 || tos[0] !== tos[1]) throw new Error('общая инициатива: ' + tos);
  await gm.page.screenshot({ path: `${SHOTS}/bestiary-statblock.png` });
});

await step('«Броски видны только мастеру»: и из статблока, и кнопкой токена; игрок их не получает', async () => {
  await gm.page.locator('.sbt-bar .toggle').click();
  const plBefore = (await lastMsg(pl.page))?.id;
  await gm.page.locator('.statblock-tab button.sb-ename', { hasText: 'Scimitar' }).click();
  await waitFor(gm.page, () => {
    const m = window.__board.store.messages.at(-1);
    return /Scimitar/.test(m?.content || '') && (m.type === 'whisper' || m.toGM);
  }, null, 'атака не шёпотом');
  await gm.page.locator('.sbt-bar').getByRole('button', { name: 'Спасбросок' }).click();
  // спасбросок спрашивает характеристику
  const q = gm.page.locator('.query-dialog, .modal', { hasText: 'Спасбросок' }).last();
  await q.waitFor();
  await q.getByRole('button', { name: /OK|Бросить|Готово/ }).first().click();
  await waitFor(gm.page, () => {
    const m = window.__board.store.messages.at(-1);
    return /Спасбросок/.test(m?.content || '') && (m.type === 'whisper' || m.toGM);
  }, null, 'спасбросок не шёпотом');
  const tid = (await objs(gm.page, /^Goblin Warrior 3$/))[0].id;
  await gm.page.evaluate((id) => window.__board.store.setSelection([id]), tid);
  await gm.page.locator('.mbtn.ta', { hasText: 'Shortbow' }).click();
  await waitFor(gm.page, () => {
    const m = window.__board.store.messages.at(-1);
    return /Shortbow/.test(m?.content || '') && (m.type === 'whisper' || m.toGM);
  }, null, 'кнопка токена не шёпотом');
  await pl.page.waitForTimeout(600);
  if ((await lastMsg(pl.page))?.id !== plBefore) throw new Error('игрок получил скрытый бросок: ' + JSON.stringify(await lastMsg(pl.page)));
  await gm.page.locator('.sbt-bar .toggle').click();
});

await step('лист D&D 2024 у монстра: характеристики, бонус мастерства, Скрытность с экспертизой', async () => {
  await gm.page.locator('.char-tabs').getByRole('tab', { name: 'Лист' }).click();
  await gm.page.frameLocator('.sheet-frame').locator('.sheet').waitFor({ timeout: 30000 });
  const get = (n) => gm.page.evaluate(([c, n]) => window.__board.store.getAttr(c, n)?.current, [goblinChar, n]);
  for (let i = 0; i < 60 && String(await get('stealth_bonus')) !== '6'; i++) await gm.page.waitForTimeout(100);
  const v = { pb: await get('pb'), stealth: await get('stealth_bonus'), dexSave: await get('dexterity_save'), strMod: await get('strength_mod') };
  if (String(v.pb) !== '2' || String(v.stealth) !== '6' || String(v.dexSave) !== '2' || String(v.strMod) !== '-1') throw new Error('лист: ' + JSON.stringify(v));
  await gm.page.locator('.char-win').getByRole('button', { name: 'Закрыть' }).click();
});

const OGRE_JSON = {
  'swamp-ogre': {
    name: 'Swamp Ogre',
    size: 'huge',
    type: 'giant',
    alignment: 'chaotic evil',
    armor_class: 12,
    hit_points: 95,
    hit_dice: '10d12+30',
    speed: { walk: 40, swim: 30 },
    strength: 21,
    dexterity: 8,
    constitution: 16,
    intelligence: 5,
    wisdom: 7,
    charisma: 7,
    challenge_rating: '4',
    actions: [{ name: 'Mire Club', desc: 'Melee Attack Roll: +7, reach 10 ft. Hit: 18 (3d8 + 5) Bludgeoning damage.' }],
  },
};

await step('по ссылке на gist: монстры прямо с GitHub (CSP пускает, браузер забирает сам)', async () => {
  let hits = 0;
  await gm.page.route('https://gist.githubusercontent.com/**', (route) => {
    hits++;
    route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(OGRE_JSON) });
  });
  await openBestiary();
  await gm.page.getByRole('button', { name: 'По ссылке' }).click();
  if ((await gm.page.getByLabel('Ссылка на монстров').inputValue()) !== 'https://gist.github.com/krisimmig/f4b7d2a30cadd2d94107f5533ba9c85c') throw new Error('нет ссылки мастера по умолчанию');
  await gm.page.getByRole('button', { name: 'Загрузить' }).click();
  await gm.page.locator('.bst-item[data-mid="swamp-ogre"]').waitFor();
  if (hits !== 1) throw new Error('запросов к gist: ' + hits);
  if (!/^Gist: krisimmig\//.test(await gm.page.getByLabel('Источник', { exact: true }).inputValue())) throw new Error('источник');
  await placeFromBestiary('swamp-ogre');
  await waitFor(gm.page, () => [...window.__board.store.col.obj.values()].some((o) => o.name === 'Swamp Ogre'), null, 'нет болотного огра');
  const o = (await objs(gm.page, /^Swamp Ogre$/))[0];
  if (o.w !== 210) throw new Error('огромный — 3×3, а не ' + o.w);
  const ch = (await monsterChars(gm.page)).find((c) => c.sb === 'swamp-ogre');
  if (!/^Gist: /.test(ch?.source || '')) throw new Error('источник персонажа: ' + JSON.stringify(ch));
  await gm.page.unroute('https://gist.githubusercontent.com/**');
});

await step('репозиторий Markdown SRD: браузеру GitHub недоступен — загрузка через сервер стола', async () => {
  const aborted = [];
  await gm.page.route('https://raw.githubusercontent.com/**', (route) => {
    aborted.push(route.request().url());
    route.abort('failed');
  });
  const asked = [];
  await gm.page.route('**/api/bestiary/fetch', async (route) => {
    const url = JSON.parse(route.request().postData() || '{}').url;
    asked.push(url);
    const md = url.endsWith('animals.md')
      ? '### Bog Toad\n\n_Large Beast, Unaligned_\n\n**AC** 11 **Initiative** +1 (11)<br>\n**HP** 39 (6d10 + 6)<br>\n**CR** 1 (XP 200; PB +2)\n'
      : '### Kobold Sapper\n\n_Small Dragon, Neutral_\n\n**AC** 14 **Initiative** +2 (12)<br>\n**HP** 7 (3d6 − 3)<br>\n**CR** 1/8 (XP 25; PB +2)\n\n#### Actions\n\n**_Dagger._** _Melee or Ranged Attack Roll:_ +4, reach 5 ft. or range 20/60 ft. _Hit:_ 4 (1d4 + 2) Piercing damage.\n';
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: md }) });
  });
  await openBestiary();
  await gm.page.getByRole('button', { name: 'По ссылке' }).click();
  await gm.page.getByRole('button', { name: 'репозиторий' }).click();
  await gm.page.getByRole('button', { name: 'Загрузить' }).click();
  await waitFor(gm.page, () => /^GitHub: downfallx\/dnd-5e-srd-markdown/.test(document.querySelector('.bst-src')?.value || ''), null, 'не загрузилось');
  const got = await gm.page.locator('.bst-item').evaluateAll((els) => els.map((e) => e.dataset.mid).join(','));
  if (got !== 'bog-toad,kobold-sapper') throw new Error('загружено: ' + got);
  if (asked.length !== 2 || !asked.every((u) => u.startsWith('https://raw.githubusercontent.com/downfallx/dnd-5e-srd-markdown/HEAD/'))) throw new Error('запросы: ' + asked + ' / оборваны: ' + aborted);
  await gm.page.keyboard.press('Escape');
  await gm.page.unroute('https://raw.githubusercontent.com/**');
  await gm.page.unroute('**/api/bestiary/fetch');
  // сам сервер берёт только файлы GitHub
  const r = await gm.api('/api/bestiary/fetch', { url: 'http://127.0.0.1:3000/api/health' });
  if (r.status !== 400 || !/только файлы/.test(r.error)) throw new Error('сервер: ' + JSON.stringify(r));
});

await step('из файла: Markdown со своим монстром', async () => {
  await openBestiary();
  const md = '## Мои\n\n### Cave Troll\n\n_Large Giant, Chaotic Evil_\n\n**AC** 15 **Initiative** +1 (11)<br>\n**HP** 84 (8d10 + 40)<br>\n**Speed** 30 ft.<br>\n**CR** 5 (XP 1,800; PB +3)\n\n#### Actions\n\n**_Rend._** _Melee Attack Roll:_ +7, reach 10 ft. _Hit:_ 11 (2d6 + 4) Slashing damage.\n';
  await gm.page.locator('.bst-bar input[type=file]').setInputFiles({ name: 'тролли.md', mimeType: 'text/markdown', buffer: Buffer.from(md) });
  await gm.page.locator('.bst-item[data-mid="cave-troll"]').waitFor();
  if ((await gm.page.getByLabel('Источник', { exact: true }).inputValue()) !== 'Файл: тролли.md') throw new Error('источник файла');
  await gm.page.locator('.bst-foot').getByRole('button', { name: 'В журнал' }).click();
  await gm.page.locator('.statblock-tab .sb-name', { hasText: 'Cave Troll' }).waitFor();
  const ch = (await monsterChars(gm.page)).find((c) => c.sb === 'cave-troll');
  if (!ch || ch.abilities !== 3) throw new Error('персонаж тролля: ' + JSON.stringify(ch));
  await gm.page.keyboard.press('Escape');
});

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
