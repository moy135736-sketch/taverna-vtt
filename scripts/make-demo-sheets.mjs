#!/usr/bin/env node
// Атрибуты персонажей примера стола (server/demo/*-attrs.json), снятые с настоящего листа D&D 5E:
// персонаж создаётся в браузере, значения вводятся через движок листа, его скрипты считают остальное.
// Запуск: сервер на BASE (по умолчанию http://localhost:3000), затем
//   node scripts/make-demo-sheets.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'demo');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const api = (p, body) => page.evaluate(async ([p, body]) => (await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Taverna': '1' }, body: body ? JSON.stringify(body) : undefined })).json(), [p, body]);
await page.goto(BASE);
await api('/api/auth/register', { username: 'demo' + Date.now().toString(36), password: 'secret123', displayName: 'Генератор' });
const sheet = (await api('/api/sheets')).sheets.find((s) => s.sourceRef === 'DD5thEditionLegacy');
const game = (await api('/api/games', { name: 'генерация примера', sheetId: sheet.id })).game;
await page.goto(`${BASE}/game/${game.id}`);
await page.waitForSelector('.board-world', { state: 'attached' });
const rowId = () => '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 11);
const dump = async (charId, file) => {
  const attrs = await page.evaluate((cid) => [...window.__board.store.attrs.get(cid).values()].map((a) => [a.name, a.current, a.max]), charId);
  const keep = attrs.filter(([, c, m]) => !(String(c) === '' && String(m ?? '') === ''));
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(keep).replace(/\],\[/g, '],\n['));
  console.log(file, keep.length, 'атрибутов');
};
const setter = (charId) => async (vals, wait = 1000) => {
  await page.evaluate(([cid, vals]) => window.__sheets.setAttrs(cid, vals, { source: 'player' }), [charId, vals]);
  await page.waitForTimeout(wait);
};
const open = (name) =>
  page.evaluate(async (name) => {
    const r = await window.__board.net.create('char', { name, inJournals: [], controlledBy: [], abilities: [] });
    window.__board.hooks.openCharacter(r.id);
    return r.id;
  }, name);

// ---- герой: паладин 3 уровня ----
{
  const charId = await open('Тарен');
  await page.waitForTimeout(3000);
  const set = setter(charId);
  await set({ mancer_confirm_flag: '', mancer_cancel: 'on', l1mancer_status: 'completed' });
  for (const [k, v] of [['strength_base', '16'], ['dexterity_base', '10'], ['constitution_base', '14'], ['intelligence_base', '8'], ['wisdom_base', '12'], ['charisma_base', '15']]) await set({ [k]: v });
  await set({ class: 'Paladin' }, 2000);
  await set({ base_level: '3' }, 2000);
  await set({ race: 'Человек', background: 'Послушник', alignment: 'Законно-добрый' });
  await set({ hp_max: '28' });
  await set({ hp: '24' });
  const r = rowId();
  await set({ [`repeating_attack_${r}_atkname`]: 'Длинный меч', [`repeating_attack_${r}_atkattr_base`]: '@{strength_mod}', [`repeating_attack_${r}_dmgbase`]: '1d8', [`repeating_attack_${r}_dmgattr`]: '@{strength_mod}', [`repeating_attack_${r}_dmgtype`]: 'рубящий' }, 2500);
  await set({ ac: '18' }, 2500);
  await dump(charId, 'hero-attrs.json');
}

async function makeNpc(name, file, stats, actions) {
  const charId = await open(name);
  await page.waitForTimeout(3000);
  const set = setter(charId);
  await set({ mancer_confirm_flag: '', mancer_cancel: 'on', l1mancer_status: 'completed' });
  await set({ npc: '1' }, 2000);
  for (const [k, v] of Object.entries(stats)) await set({ [k]: v }, 500);
  for (const a of actions) {
    const r = rowId();
    const vals = {};
    for (const [k, v] of Object.entries(a)) vals[`repeating_npcaction_${r}_${k}`] = v;
    await set(vals, 2500);
  }
  await page.waitForTimeout(2000);
  await dump(charId, file);
}

await makeNpc('Гоблин', path.join(OUT, 'goblin-attrs.json'), {
  npc_name: 'Гоблин', npc_type: 'Маленький гуманоид (гоблиноид), нейтрально-злой', npc_ac: '15', npc_actype: 'кожаный доспех, щит',
  hp_max: '7', hp: '7', npc_hpformula: '2d6', npc_speed: '30 фт.',
  strength_base: '8', dexterity_base: '14', constitution_base: '10', intelligence_base: '10', wisdom_base: '8', charisma_base: '8',
  npc_challenge: '1/4', npc_languages: 'общий, гоблинский', npc_senses: 'тёмное зрение 60 фт.',
}, [
  { name: 'Скимитар', attack_flag: 'on', attack_type: 'Melee', attack_range: '5 фт.', attack_target: 'одна цель', attack_tohit: '4', attack_damage: '1d6+2', attack_damagetype: 'рубящий', damage_flag: '{{damage=1}} {{dmg1flag=1}}' },
  { name: 'Короткий лук', attack_flag: 'on', attack_type: 'Ranged', attack_range: '80/320 фт.', attack_target: 'одна цель', attack_tohit: '4', attack_damage: '1d6+2', attack_damagetype: 'колющий', damage_flag: '{{damage=1}} {{dmg1flag=1}}' },
]);
await makeNpc('Хобгоблин Грук', path.join(OUT, 'boss-attrs.json'), {
  npc_name: 'Хобгоблин Грук', npc_type: 'Средний гуманоид (гоблиноид), законно-злой', npc_ac: '18', npc_actype: 'кольчуга, щит',
  hp_max: '26', hp: '26', npc_hpformula: '4d8+8', npc_speed: '30 фт.',
  strength_base: '13', dexterity_base: '12', constitution_base: '14', intelligence_base: '10', wisdom_base: '10', charisma_base: '9',
  npc_challenge: '1/2', npc_languages: 'общий, гоблинский', npc_senses: 'тёмное зрение 60 фт.',
}, [
  { name: 'Длинный меч', attack_flag: 'on', attack_type: 'Melee', attack_range: '5 фт.', attack_target: 'одна цель', attack_tohit: '3', attack_damage: '1d8+1', attack_damagetype: 'рубящий', damage_flag: '{{damage=1}} {{dmg1flag=1}}', description: 'Воинское превосходство: раз в ход +2d6 урона, если рядом с целью союзник Грука.' },
]);
await browser.close();
