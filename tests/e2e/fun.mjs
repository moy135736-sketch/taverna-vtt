// e2e: «чтобы было приятно играть» — реакции, свои кубики, эффекты бросков в чате, итоги вечера,
// кинотрюки мастера и ловушки на карте
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
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.goto(BASE);
  const api = (p, body, method) =>
    page.evaluate(
      async ([p, body, method]) =>
        (await fetch(p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(),
      [p, body, method],
    );
  const r = await api('/api/auth/register', { username: 'fn' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), password: 'secret123', displayName: name });
  return { ctx, page, api, user: r.user };
}
let gm, pl;
async function step(name, fn, group = '') {
  if (ONLY.length && !ONLY.includes(group)) return;
  try {
    await fn();
    console.log('✓', name);
  } catch (e) {
    console.log('✗', name, '—', e.message.split('\n').slice(0, 4).join(' | '));
    failures.push(name);
    const n = failures.length;
    await gm?.page.screenshot({ path: `${SHOTS}/fun-fail-${n}-gm.png` }).catch(() => {});
    await pl?.page.screenshot({ path: `${SHOTS}/fun-fail-${n}-pl.png` }).catch(() => {});
  }
}
async function waitFor(page, fn, arg, what, timeout = 8000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(what);
  }
}
async function chat(page, text) {
  await page.getByRole('tab', { name: 'Чат' }).click();
  await page.locator('.chat-text').fill(text);
  await page.locator('.chat-text').press('Enter');
}
const lastMsgId = (page, re) => page.evaluate((src) => [...window.__board.store.messages].reverse().find((m) => new RegExp(src).test(m.content || ''))?.id, re.source);

gm = await newUser('Мастер');
pl = await newUser('Игрок');
const game = (await gm.api('/api/games', { name: 'Весёлый стол' })).game;
await pl.api('/api/games/join', { code: game.inviteCode });
await gm.page.goto(`${BASE}/game/${game.id}`);
await pl.page.goto(`${BASE}/game/${game.id}`);
await gm.page.waitForSelector('.board');
await pl.page.waitForSelector('.board');
await gm.page.evaluate(() => window.__board.store.setTool('select'));

const ids = await gm.page.evaluate(async (plId) => {
  const { net, store } = window.__board;
  const pageId = store.ui.pageId;
  const ch = await net.create('char', { name: 'Тарен', controlledBy: [plId], inJournals: [plId] });
  const t = await net.create('obj', {
    type: 'shape',
    shape: 'ellipse',
    fill: '#2d4e9b',
    pageId,
    layer: 'objects',
    x: 560,
    y: 280,
    w: 70,
    h: 70,
    name: 'Тарен',
    represents: ch.id,
    controlledBy: [plId],
    bars: [{ id: 'b1', name: 'HP', value: '30', max: '30', color: '#d63a3a', link: '', visibility: 'all', editable: 'owners', showText: 'always' }],
  });
  return { ch: ch.id, t: t.id };
}, pl.user.id);
await pl.page.waitForFunction((id) => window.__board.store.col.obj.has(id), ids.t);

// ---------------------------------------------------------------------------------------------
// Реакции
await step(
  'реакция под сообщением: игрок ставит 😂, мастер видит, второй щелчок снимает',
  async () => {
    await chat(gm.page, 'Вы входите в тёмную таверну.');
    await waitFor(pl.page, () => [...document.querySelectorAll('.textchatcontainer .message')].some((m) => m.textContent.includes('тёмную таверну')), null, 'сообщение не пришло');
    const msg = pl.page.locator('.textchatcontainer .message', { hasText: 'тёмную таверну' }).last();
    await msg.hover();
    await msg.locator('.react-add').click();
    await pl.page.locator('.react-picker').waitFor();
    await pl.page.screenshot({ path: `${SHOTS}/fun-react-picker.png` });
    await pl.page.locator('.react-picker button', { hasText: '😂' }).click();
    await waitFor(gm.page, () => [...document.querySelectorAll('.textchatcontainer .react-chip')].some((c) => c.textContent === '😂1'), null, 'мастер не видит реакцию');
    // мастер добавляет ту же — 2; игрок снимает — 1
    await gm.page.locator('.textchatcontainer .react-chip', { hasText: '😂' }).click();
    await waitFor(pl.page, () => [...document.querySelectorAll('.textchatcontainer .react-chip')].some((c) => c.textContent === '😂2'), null, 'не стало 2');
    await pl.page.locator('.textchatcontainer .react-chip', { hasText: '😂' }).click();
    await waitFor(gm.page, () => [...document.querySelectorAll('.textchatcontainer .react-chip')].some((c) => c.textContent === '😂1' && c.classList.contains('on')), null, 'не стало 1');
    // реакции сохраняются: после перезагрузки на месте
    await pl.page.reload();
    await pl.page.waitForSelector('.board');
    await pl.page.getByRole('tab', { name: 'Чат' }).click();
    await waitFor(pl.page, () => [...document.querySelectorAll('.textchatcontainer .react-chip')].some((c) => c.textContent === '😂1'), null, 'после перезагрузки реакции нет');
    // мусорная реакция отклоняется
    const id = await lastMsgId(gm.page, /тёмную таверну/);
    const bad = await pl.page.evaluate((id) => window.__board.net.request('chat:react', { id, emoji: '<b>' }), id);
    if (!bad?.error) throw new Error('приняли неизвестную реакцию');
  },
  'react',
);

await step(
  'реакция над токеном: игрок выделяет Тарена и жмёт 🔥 — у мастера всплывает над токеном',
  async () => {
    await pl.page.evaluate((t) => window.__board.store.setSelection([t]), ids.t);
    await pl.page.locator('.react-float-btn').click();
    await pl.page.locator('.react-picker button', { hasText: '🔥' }).click();
    await waitFor(gm.page, () => [...document.querySelectorAll('.board .react-float')].some((e) => e.textContent === '🔥'), null, 'у мастера нет реакции над токеном', 4000);
    await gm.page.screenshot({ path: `${SHOTS}/fun-react-float.png` });
    // без токена — у аватара
    await pl.page.evaluate(() => window.__board.store.setSelection([]));
    await gm.page.locator('.react-float-btn').click();
    await gm.page.locator('.react-picker button', { hasText: '👏' }).click();
    await waitFor(pl.page, () => [...document.querySelectorAll('.react-float.at-avatar')].some((e) => e.textContent === '👏'), null, 'у игрока нет реакции у аватара мастера', 4000);
  },
  'react',
);

// ---------------------------------------------------------------------------------------------
// Свои кубики и эффект броска в чате
await step(
  'свои кубики: игрок выбирает «Лава» — у мастера его бросок катится лавовыми кубиками',
  async () => {
    await gm.page.evaluate(() => localStorage.setItem('tv:diceanim', '2d'));
    await pl.page.getByRole('tab', { name: 'Настройки' }).click();
    await pl.page.locator('.ds-skin[data-skin="lava"]').click();
    await waitFor(gm.page, (id) => window.__board.store.members.get(id)?.dice?.skin === 'lava', pl.user.id, 'мастер не узнал о наборе игрока');
    await pl.page.locator('.ds-skin[data-skin="lava"][aria-checked="true"]').waitFor();
    await pl.page.locator('.dice-style').screenshot({ path: `${SHOTS}/fun-dice-skins.png` });
    // пробный бросок — объёмные кубики набора, только у себя
    await pl.page.evaluate(() => localStorage.setItem('tv:dice3d', 'force'));
    const before = await pl.page.evaluate(() => window.__dice3d?.rolls || 0);
    await pl.page.getByRole('button', { name: 'Бросить пробный' }).click();
    await waitFor(pl.page, (b) => (window.__dice3d?.rolls || 0) > b && window.__dice3d.last.skin === 'lava' && window.__dice3d.last.results.length === 6, before, 'пробный бросок не тем набором', 15000);
    // настоящий бросок игрока — у мастера плоские кубики того же набора
    await chat(pl.page, '/r 1d20+2');
    await waitFor(gm.page, () => !!document.querySelector('.dice-group[data-skin="lava"] canvas'), null, 'у мастера кубики не того набора');
    // набор сохраняется в аккаунте
    const me = await pl.api('/api/auth/me');
    if (me.user?.settings?.dice?.skin !== 'lava') throw new Error('набор не сохранился в аккаунте');
  },
  'dice',
);

await step(
  'эффект броска: игрок выбирает «Искры» — у мастера бросок прилетает в чат с искрами; выключатель на устройстве',
  async () => {
    await pl.page.getByRole('tab', { name: 'Настройки' }).click();
    await pl.page.getByLabel('Эффект броска в чате').selectOption('sparks');
    await waitFor(gm.page, (id) => window.__board.store.members.get(id)?.dice?.fx === 'sparks', pl.user.id, 'мастер не узнал об эффекте игрока');
    await gm.page.getByRole('tab', { name: 'Чат' }).click();
    await chat(pl.page, '/r 1d20+4');
    await waitFor(gm.page, () => !!document.querySelector('.rfx.rfx-sparks .spark'), null, 'у мастера нет искр', 5000);
    await gm.page.screenshot({ path: `${SHOTS}/fun-roll-fx.png` });
    // мастер выключил эффекты у себя — броски без эффекта
    await gm.page.waitForTimeout(3000);
    await gm.page.evaluate(() => localStorage.setItem('tv:rollfx', '0'));
    await chat(pl.page, '/r 1d20+5');
    await gm.page.waitForTimeout(1200);
    if (await gm.page.evaluate(() => !!document.querySelector('.rfx'))) throw new Error('эффект показан, хотя выключен');
    await gm.page.evaluate(() => localStorage.removeItem('tv:rollfx'));
  },
  'dice',
);

await step(
  'профиль: игрок сменил имя — за столом новое имя сразу, без перезахода',
  async () => {
    await pl.api('/api/auth/me', { displayName: 'Игрок Тарен' }, 'PATCH');
    await waitFor(gm.page, (id) => window.__board.store.members.get(id)?.displayName === 'Игрок Тарен', pl.user.id, 'имя не обновилось у мастера');
    await pl.api('/api/auth/me', { displayName: 'Игрок' }, 'PATCH');
  },
  'dice',
);

// ---------------------------------------------------------------------------------------------
// Итоги вечера
await step(
  'итоги вечера: мастер подводит итоги — карточка с наградами и моментом вечера у всех',
  async () => {
    await chat(pl.page, 'Я открываю сундук. Что может пойти не так?');
    await waitFor(gm.page, () => [...document.querySelectorAll('.textchatcontainer .message')].some((m) => m.textContent.includes('Что может пойти не так')), null, 'реплика не дошла');
    // мастеру смешно: две реакции на реплику игрока — это «момент вечера»
    const id = await lastMsgId(gm.page, /Что может пойти не так/);
    for (const e of ['😂', '💀']) {
      const r = await gm.page.evaluate(([id, e]) => window.__board.net.request('chat:react', { id, emoji: e }), [id, e]);
      if (r?.error) throw new Error(r.error);
    }
    for (let i = 0; i < 3; i++) await chat(pl.page, '/r 1d20+1');
    await chat(gm.page, '/r 2d6');
    await gm.page.waitForTimeout(400);
    await chat(gm.page, '/итоги');
    for (const p of [gm.page, pl.page]) await waitFor(p, () => !!document.querySelector('.textchatcontainer .message.summary .sum-card'), null, 'нет карточки итогов');
    const info = await pl.page.evaluate(() => {
      const c = [...document.querySelectorAll('.message.summary')].pop();
      return {
        title: c.querySelector('.sum-title')?.textContent,
        rolls: Number(c.querySelector('.sum-stat b')?.textContent),
        awards: [...c.querySelectorAll('.sum-award')].map((a) => a.dataset.award + ':' + a.textContent),
        moment: c.querySelector('.sum-moment')?.textContent || '',
        private: !!c.querySelector('.sum-private'),
      };
    });
    if (info.title !== 'Итоги вечера') throw new Error('заголовок: ' + info.title);
    if (!(info.rolls >= 4)) throw new Error('бросков в итогах: ' + info.rolls);
    if (!info.awards.some((a) => a.startsWith('soul:') && a.includes('Тарен') === false && a.includes('Игрок'))) throw new Error('нет «Души компании» у игрока: ' + info.awards.join(' / '));
    if (!info.moment.includes('Что может пойти не так')) throw new Error('нет момента вечера: ' + info.moment);
    if (info.private) throw new Error('итоги мастера помечены как личные');
    await pl.page.locator('.message.summary').last().screenshot({ path: `${SHOTS}/fun-summary.png` });
    // игрок может посмотреть итоги сам — видны только ему
    const before = await gm.page.evaluate(() => document.querySelectorAll('.message.summary').length);
    await chat(pl.page, '/итоги всё');
    await waitFor(pl.page, () => [...document.querySelectorAll('.message.summary')].some((c) => c.querySelector('.sum-private') && c.querySelector('.sum-title')?.textContent === 'Итоги кампании'), null, 'нет личных итогов кампании у игрока');
    await gm.page.waitForTimeout(500);
    if ((await gm.page.evaluate(() => document.querySelectorAll('.message.summary').length)) !== before) throw new Error('личные итоги игрока видны мастеру');
  },
  'summary',
);

// ---------------------------------------------------------------------------------------------
// Кинотрюки
await step(
  'кинотрюки: титры и голос рассказчика у игрока, щелчок скрывает титры',
  async () => {
    await gm.page.getByRole('button', { name: 'Кинотрюки' }).click();
    await gm.page.getByLabel('Заголовок титров', { exact: true }).fill('Глава II. Пепел');
    await gm.page.getByLabel('Подзаголовок титров').fill('Три дня спустя');
    await gm.page.getByRole('button', { name: 'Показать титры' }).click();
    await waitFor(pl.page, () => document.querySelector('.cine-title h2')?.textContent === 'Глава II. Пепел', null, 'у игрока нет титров');
    await pl.page.waitForTimeout(1700);
    await pl.page.screenshot({ path: `${SHOTS}/fun-cine-title.png` });
    await gm.page.screenshot({ path: `${SHOTS}/fun-cine-panel.png` });
    await pl.page.locator('.cine-title').click();
    await waitFor(pl.page, () => !document.querySelector('.cine-title'), null, 'титры не скрылись по щелчку');
    // рассказчик: полосы и субтитры
    await gm.page.getByLabel('Текст рассказчика').fill('Ветер стих. Где-то в темноте скрипнула дверь.');
    await gm.page.getByRole('button', { name: 'Сказать' }).click();
    await waitFor(pl.page, () => document.querySelector('.cine-narr')?.textContent.includes('скрипнула дверь') && !!document.querySelector('.cine-bars.on'), null, 'у игрока нет рассказчика');
    await pl.page.waitForTimeout(1800);
    await pl.page.screenshot({ path: `${SHOTS}/fun-cine-narr.png` });
  },
  'cine',
);

await step(
  'кинотрюки: затемнение держится и после перезахода, тряска и вспышка из чата, игроку трюки недоступны',
  async () => {
    await gm.page.getByRole('button', { name: 'Затемнение' }).click();
    await waitFor(pl.page, () => !!document.querySelector('.cine-fade.on:not(.gm)'), null, 'у игрока нет затемнения');
    await waitFor(gm.page, () => !!document.querySelector('.cine-fade.on.gm .cine-fade-note'), null, 'мастер не видит, что игроки в темноте');
    await pl.page.reload();
    await pl.page.waitForSelector('.board');
    await waitFor(pl.page, () => !!document.querySelector('.cine-fade.on'), null, 'после перезахода затемнение пропало');
    await chat(gm.page, '/затемнение выкл');
    await waitFor(pl.page, () => !document.querySelector('.cine-fade.on'), null, 'затемнение не снялось');
    await chat(gm.page, '/тряска сильно');
    await waitFor(pl.page, () => !!document.querySelector('.g-board-wrap.cine-shake.strong'), null, 'нет тряски', 4000);
    await chat(gm.page, '/вспышка красная');
    await waitFor(pl.page, () => !!document.querySelector('.cine-flash.red'), null, 'нет вспышки', 4000);
    // игрок не может
    await chat(pl.page, '/титры Я главный');
    await pl.page.waitForTimeout(600);
    if (await gm.page.evaluate(() => document.querySelector('.cine-title h2')?.textContent === 'Я главный')) throw new Error('игрок показал титры');
    const r = await pl.page.evaluate(() => window.__board.net.request('cine', { kind: 'flash' }));
    if (!r?.error) throw new Error('игрок запустил вспышку');
  },
  'cine',
);

await step(
  'кинотрюки: камера игрока плавно летит к виду мастера',
  async () => {
    await gm.page.evaluate(() => window.__board.centerOn(300, 220, 2.2));
    const z0 = await pl.page.evaluate(() => window.__board.cam.z);
    await gm.page.getByRole('button', { name: 'Камеру — к моему виду' }).click();
    // масштаб при пролёте сходится к цели чуть раньше центра — ждём и то и другое (последний кадр пролёта)
    try {
      await pl.page.waitForFunction(
        () => {
          const b = window.__board;
          const c = b.screenToWorld(b.W / 2, b.H / 2);
          return Math.abs(b.cam.z - 2.2) < 0.01 && Math.abs(c.x - 300) <= 2 && Math.abs(c.y - 220) <= 2;
        },
        null,
        { timeout: 5000 },
      );
    } catch {
      const c = await pl.page.evaluate(() => ({ ...window.__board.screenToWorld(window.__board.W / 2, window.__board.H / 2), z: window.__board.cam.z }));
      throw new Error(`камера игрока не прилетела: ${c.x},${c.y} z=${c.z} (было z=${z0})`);
    }
    await gm.page.getByRole('button', { name: 'Закрыть пульт' }).click();
  },
  'cine',
);

// ---------------------------------------------------------------------------------------------
// Ловушки
/** Экранная точка для мировой (для щелчков по доске) */
const screenOf = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const b = window.__board;
      const r = b.root.getBoundingClientRect();
      const p = b.worldToScreen(x, y);
      return { x: r.left + p.x, y: r.top + p.y };
    },
    [x, y],
  );

await step(
  'ловушка: мастер ставит яму из меню на карте и настраивает — игроку она не видна',
  async () => {
    await gm.page.evaluate(() => window.__board.centerOn(700, 315, 1));
    await gm.page.evaluate(() => window.__board.store.setSelection([]));
    const p = await screenOf(gm.page, 735, 315);
    await gm.page.mouse.click(p.x, p.y, { button: 'right' });
    await gm.page.getByText('Поставить ловушку здесь…').click();
    const dlg = gm.page.locator('.trap-dialog');
    await dlg.waitFor();
    await dlg.getByLabel('Название').fill('Яма');
    await dlg.getByLabel('Описание для всех').fill('Пол под {name} проваливается!');
    await dlg.getByPlaceholder('2d10').fill('2d6');
    await dlg.getByPlaceholder('Ловкость, Сл 13').fill('Ловкость, Сл 12');
    await dlg.getByText('Сразу снять выпавшее с хитов токена').click();
    await dlg.screenshot({ path: `${SHOTS}/fun-trap-dialog.png` });
    await dlg.getByRole('button', { name: 'Поставить ловушку' }).click();
    await dlg.waitFor({ state: 'detached' });
    await waitFor(gm.page, () => [...window.__board.store.col.obj.values()].some((o) => o.trap?.name === 'Яма' && o.trap.damage && o.layer === 'gm' && o.x === 700 && o.y === 280), null, 'ловушка не сохранилась');
    await waitFor(gm.page, () => !!document.querySelector('.obj.trap'), null, 'мастер не видит значок ловушки');
    ids.trap = await gm.page.evaluate(() => [...window.__board.store.col.obj.values()].find((o) => o.trap?.name === 'Яма').id);
    await pl.page.waitForTimeout(400);
    if (await pl.page.evaluate((id) => window.__board.store.col.obj.has(id), ids.trap)) throw new Error('игрок видит ловушку');
    await gm.page.screenshot({ path: `${SHOTS}/fun-trap-gm.png` });
  },
  'trap',
);

await step(
  'ловушка: Тарен идёт через яму — останавливается на ней, в чате бросок и спасбросок, хиты сняты, ловушка разряжена',
  async () => {
    await pl.page.getByRole('tab', { name: 'Чат' }).click();
    await gm.page.getByRole('tab', { name: 'Чат' }).click();
    await pl.page.evaluate((id) => window.__board.net.update('obj', id, { x: 840, y: 280 }), ids.t);
    await waitFor(pl.page, (id) => window.__board.store.col.obj.get(id)?.x === 700, ids.t, 'токен не остановился на ловушке');
    await waitFor(pl.page, () => [...document.querySelectorAll('.message.trap')].some((m) => m.textContent.includes('Пол под Тарен проваливается!') && m.textContent.includes('Ловкость, Сл 12') && m.querySelector('.inlinerollresult')), null, 'нет карточки ловушки у игрока');
    await waitFor(gm.page, () => [...document.querySelectorAll('.message.system')].some((m) => m.textContent.includes('Ловушка «Яма»: попался Тарен') && m.textContent.includes('разряжена')), null, 'мастеру не пришло сообщение');
    const total = await pl.page.evaluate(() => {
      const m = [...window.__board.store.messages].reverse().find((x) => x.type === 'trap');
      return m.inlinerolls[m.inlinerolls.length - 1].total;
    });
    await waitFor(pl.page, ([id, hp]) => String(window.__board.store.col.obj.get(id)?.bars?.[0]?.value) === String(hp), [ids.t, 30 - total], `хиты не сняты (урон ${total})`);
    await waitFor(gm.page, (id) => window.__board.store.col.obj.get(id)?.trap?.armed === false && !!document.querySelector('.obj.trap.trap-off'), ids.trap, 'ловушка не разрядилась');
    await pl.page.locator('.message.trap').last().screenshot({ path: `${SHOTS}/fun-trap-chat.png` });
    // разряженная не срабатывает
    const n = await pl.page.evaluate(() => document.querySelectorAll('.message.trap').length);
    await pl.page.evaluate((id) => window.__board.net.update('obj', id, { x: 560, y: 280 }), ids.t);
    await pl.page.waitForTimeout(300);
    await pl.page.evaluate((id) => window.__board.net.update('obj', id, { x: 840, y: 280 }), ids.t);
    await waitFor(pl.page, (id) => window.__board.store.col.obj.get(id)?.x === 840, ids.t, 'токен не дошёл');
    await pl.page.waitForTimeout(500);
    if ((await pl.page.evaluate(() => document.querySelectorAll('.message.trap').length)) !== n) throw new Error('разряженная ловушка сработала');
  },
  'trap',
);

await step(
  'ловушка «на всех»: не трогает ходы мастера без разрешения, остаётся взведённой, после срабатывания видна игрокам',
  async () => {
    const r = await gm.page.evaluate(async () => {
      const { net, store } = window.__board;
      const pageId = store.ui.pageId;
      const npc = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#7a2e2e', pageId, layer: 'objects', x: 140, y: 560, w: 70, h: 70, name: 'Гоблин' });
      const trap = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#00000022', pageId, layer: 'gm', x: 280, y: 560, w: 70, h: 70, name: 'Капкан', trap: { name: 'Капкан', trigger: 'any', gmMoves: false, once: false, reveal: true, stop: false, message: 'Щёлк! {name} в капкане.' } });
      return { npc: npc.id, trap: trap.id };
    });
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 490, y: 560 }), r.npc);
    await gm.page.waitForTimeout(600);
    if (await gm.page.evaluate(() => [...document.querySelectorAll('.message.trap')].some((m) => m.textContent.includes('Гоблин в капкане')))) throw new Error('сработала от хода мастера');
    // мастеру — подсказка, почему не сработала
    await waitFor(gm.page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Капкан') && t.textContent.includes('ходы мастера её не задевают')), null, 'нет подсказки «ходы мастера не задевают»', 4000);
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { trap: { ...window.__board.store.col.obj.get(id).trap, gmMoves: true } }), r.trap);
    await gm.page.waitForTimeout(300);
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 140, y: 560 }), r.npc);
    await waitFor(pl.page, () => [...document.querySelectorAll('.message.trap')].some((m) => m.textContent.includes('Щёлк! Гоблин в капкане.')), null, 'капкан не сработал');
    // не останавливает и остаётся взведённым; игрок теперь видит капкан, но не его настройки
    await waitFor(gm.page, ([npc, trap]) => {
      const s = window.__board.store;
      return s.col.obj.get(npc)?.x === 140 && s.col.obj.get(trap)?.trap?.armed === true && s.col.obj.get(trap)?.trap?.count === 1 && s.col.obj.get(trap)?.layer === 'map';
    }, [r.npc, r.trap], 'капкан: не то состояние после срабатывания');
    await waitFor(pl.page, (id) => !!window.__board.store.col.obj.get(id) && window.__board.store.col.obj.get(id).trap === undefined, r.trap, 'игрок не видит капкан или видит его настройки');
  },
  'trap',
);

await step(
  'ловушка по умолчанию: игрок тянет Тарена мышью — Тарен остаётся на ловушке, у всех описание; мастеру — уведомление',
  async () => {
    // Тарена — в начало ряда; ловушку по умолчанию — на его пути (клетка 420…490 × 140…210)
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 140, y: 140 }), ids.t);
    await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id)?.x === 140, ids.t);
    await gm.page.evaluate(() => window.__board.centerOn(455, 300, 1));
    await gm.page.evaluate(() => window.__board.store.setSelection([]));
    const p = await screenOf(gm.page, 455, 175);
    await gm.page.mouse.click(p.x, p.y, { button: 'right' });
    await gm.page.getByText('Поставить ловушку здесь…').click();
    const dlg = gm.page.locator('.trap-dialog');
    await dlg.getByRole('button', { name: 'Поставить ловушку' }).click();
    await dlg.waitFor({ state: 'detached' });
    const trapId = await gm.page.evaluate(() => [...window.__board.store.col.obj.values()].find((o) => o.trap && o.x === 420 && o.y === 140)?.id);
    if (!trapId) throw new Error('ловушка не поставлена');
    // игрок тянет мышью насквозь: пока тянет — ловушка молчит; отпустил за ловушкой — сработала, Тарен остановлен на ней
    await pl.page.evaluate(() => window.__board.store.setSelection([]));
    await pl.page.evaluate(() => window.__board.centerOn(455, 300, 1));
    const before = await pl.page.evaluate(() => document.querySelectorAll('.message.trap').length);
    const a = await screenOf(pl.page, 175, 175);
    const b = await screenOf(pl.page, 735, 175);
    await pl.page.mouse.move(a.x, a.y);
    await pl.page.mouse.down();
    for (let i = 1; i <= 24; i++) {
      await pl.page.mouse.move(a.x + ((b.x - a.x) * i) / 24, a.y);
      await pl.page.waitForTimeout(30);
    }
    await pl.page.waitForTimeout(700);
    if ((await pl.page.evaluate(() => document.querySelectorAll('.message.trap').length)) !== before) throw new Error('ловушка сработала, пока токен ещё тянут');
    if ((await gm.page.evaluate((id) => window.__board.store.col.obj.get(id)?.trap?.armed, trapId)) !== true) throw new Error('ловушка разрядилась до хода');
    await pl.page.mouse.up();
    await waitFor(gm.page, (id) => window.__board.store.col.obj.get(id)?.x === 420, ids.t, 'у мастера Тарен не на ловушке');
    await pl.page.waitForTimeout(700);
    const at = await pl.page.evaluate((id) => window.__board.store.col.obj.get(id)?.x, ids.t);
    if (at !== 420) throw new Error('у игрока Тарен не на ловушке: x=' + at);
    await waitFor(pl.page, () => [...document.querySelectorAll('.message.trap')].some((m) => m.textContent.includes('Тарен попадается в ловушку!')), null, 'нет описания по умолчанию');
    await waitFor(gm.page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('попался Тарен')), null, 'мастеру нет уведомления', 4000);
    // мастер тоже задевает ловушку по умолчанию: взвести снова и провести Тарена самому
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { trap: { ...window.__board.store.col.obj.get(id).trap, armed: true } }), trapId);
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 140, y: 140 }), ids.t);
    await gm.page.waitForTimeout(300);
    const n = await gm.page.evaluate(() => document.querySelectorAll('.message.trap').length);
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 700, y: 140 }), ids.t);
    await waitFor(gm.page, (n) => document.querySelectorAll('.message.trap').length > n, n, 'ход мастера не задел ловушку по умолчанию');
  },
  'trap',
);

await step(
  'ловушка: протянул над ловушкой и вернул назад, не переходя её, — хода через ловушку не было',
  async () => {
    const r = await gm.page.evaluate(async () => {
      const { net, store } = window.__board;
      const pageId = store.ui.pageId;
      const trap = await net.create('obj', { type: 'shape', shape: 'rect', pageId, layer: 'gm', x: 420, y: 420, w: 70, h: 70, name: 'Плита', trap: { name: 'Плита', message: 'Щёлкнула плита под {name}' } });
      return { trap: trap.id };
    });
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 140, y: 420 }), ids.t);
    await pl.page.waitForFunction((id) => window.__board.store.col.obj.get(id)?.y === 420, ids.t);
    await pl.page.evaluate(() => window.__board.centerOn(455, 455, 1));
    const n = await pl.page.evaluate(() => document.querySelectorAll('.message.trap').length);
    // туда за ловушку и обратно, отпустить до неё
    const a = await screenOf(pl.page, 175, 455);
    const far = await screenOf(pl.page, 700, 455);
    const back = await screenOf(pl.page, 315, 455);
    await pl.page.mouse.move(a.x, a.y);
    await pl.page.mouse.down();
    for (let i = 1; i <= 16; i++) {
      await pl.page.mouse.move(a.x + ((far.x - a.x) * i) / 16, a.y);
      await pl.page.waitForTimeout(30);
    }
    for (let i = 1; i <= 12; i++) {
      await pl.page.mouse.move(far.x + ((back.x - far.x) * i) / 12, a.y);
      await pl.page.waitForTimeout(30);
    }
    await pl.page.mouse.up();
    await waitFor(gm.page, (id) => window.__board.store.col.obj.get(id)?.x === 280, ids.t, 'Тарен не там, где отпустили');
    await pl.page.waitForTimeout(600);
    if ((await pl.page.evaluate(() => document.querySelectorAll('.message.trap').length)) !== n) throw new Error('сработала, хотя ход ловушку не пересёк');
    if ((await gm.page.evaluate((id) => window.__board.store.col.obj.get(id)?.trap?.armed, r.trap)) !== true) throw new Error('плита разрядилась');
    // а с точкой поворота через пробел — путь идёт через ловушку, хоть конец и рядом с началом
    await pl.page.evaluate(() => window.__board.centerOn(455, 455, 1));
    const s2 = await screenOf(pl.page, 315, 455);
    const mid = await screenOf(pl.page, 595, 455);
    const end = await screenOf(pl.page, 315, 595);
    await pl.page.mouse.move(s2.x, s2.y);
    await pl.page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await pl.page.mouse.move(s2.x + ((mid.x - s2.x) * i) / 12, s2.y);
      await pl.page.waitForTimeout(30);
    }
    await pl.page.keyboard.press(' ');
    for (let i = 1; i <= 12; i++) {
      await pl.page.mouse.move(mid.x + ((end.x - mid.x) * i) / 12, mid.y + ((end.y - mid.y) * i) / 12);
      await pl.page.waitForTimeout(30);
    }
    await pl.page.mouse.up();
    await waitFor(pl.page, () => [...document.querySelectorAll('.message.trap')].some((m) => m.textContent.includes('Щёлкнула плита под Тарен')), null, 'путь с поворотом через ловушку не засчитан');
  },
  'trap',
);

await step(
  'ловушка «только игроки»: мастер ведёт гоблина — не срабатывает, мастеру подсказка с кнопкой «Настроить»',
  async () => {
    const r = await gm.page.evaluate(async () => {
      const { net, store } = window.__board;
      const pageId = store.ui.pageId;
      const npc = await net.create('obj', { type: 'shape', shape: 'ellipse', fill: '#5a7a2e', pageId, layer: 'objects', x: 140, y: 700, w: 70, h: 70, name: 'Кобольд' });
      const trap = await net.create('obj', { type: 'shape', shape: 'rect', pageId, layer: 'gm', x: 420, y: 700, w: 70, h: 70, name: 'Сеть', trap: { name: 'Сеть' } });
      return { npc: npc.id, trap: trap.id };
    });
    await gm.page.evaluate((id) => window.__board.net.update('obj', id, { x: 700, y: 700 }), r.npc);
    await waitFor(gm.page, () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Сеть') && t.textContent.includes('Кобольд') && t.textContent.includes('только токены игроков')), null, 'нет подсказки', 4000);
    if (await gm.page.evaluate((id) => window.__board.store.col.obj.get(id)?.trap?.count, r.trap)) throw new Error('ловушка сработала на кобольда');
    await gm.page.locator('.toast', { hasText: 'Сеть' }).getByRole('button', { name: 'Настроить' }).click();
    await gm.page.locator('.trap-dialog').waitFor();
    await gm.page.locator('.trap-dialog').getByRole('button', { name: 'Отмена' }).click();
  },
  'trap',
);

console.log('ошибки:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
if (failures.length || errors.length) process.exit(1);
