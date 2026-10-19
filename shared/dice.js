// Движок кубиков, совместимый с синтаксисом Roll20.
//
// Поддерживается: NdX, dF, d%, (выражение)dX, Nd(выражение), + - * / % **,
// floor/ceil/round/abs, метки [label], взрывы ! !! !p (с точками сравнения),
// k/kh/kl/d/dh/dl, r/ro, cs/cf, s/sa/sd, m/mt, успехи >N <N =N и провалы f,
// групповые броски {..., ...} с kh/kl/dh/dl/успехами, таблицы NtИмя / Nt[Имя].
//
// Модуль общий для сервера (бросает кости) и клиента (показывает подсказки).

export class RollError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RollError';
  }
}

export const LIMITS = {
  maxDice: 10000, // всего кубиков на одно выражение
  maxPerDieRepeats: 100, // взрывы/перебросы одного кубика
  maxSides: 1e9,
  maxDepth: 64,
  maxLength: 20000,
};

const FUNCS = ['floor', 'ceil', 'round', 'abs'];

// ---------------------------------------------------------------------------
// Парсер
// ---------------------------------------------------------------------------

class Parser {
  constructor(src) {
    this.s = src;
    this.pos = 0;
    this.depth = 0;
  }

  error(msg) {
    throw new RollError(msg + ` (позиция ${this.pos + 1} в «${this.s}»)`);
  }

  skipWs() {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 160) this.pos++;
      else break;
    }
  }

  ch(o = 0) {
    return this.s[this.pos + o];
  }

  isDigit(c) {
    return c !== undefined && c >= '0' && c <= '9';
  }

  // Выражение
  parseExpression() {
    if (++this.depth > LIMITS.maxDepth) this.error('Слишком глубокая вложенность');
    const r = this.parseAdditive();
    this.depth--;
    return r;
  }

  tryParse(fn) {
    const save = this.pos;
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof RollError)) throw e;
      this.pos = save;
      return null;
    }
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      this.skipWs();
      const c = this.ch();
      if (c === '+' || c === '-') {
        const save = this.pos;
        this.pos++;
        const right = this.trailing ? this.tryParse(() => this.parseMultiplicative()) : this.parseMultiplicative();
        if (!right) {
          this.pos = save;
          break;
        }
        left = { k: 'bin', op: c, a: left, b: right };
      } else break;
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parsePower();
    for (;;) {
      this.skipWs();
      const c = this.ch();
      if ((c === '*' && this.ch(1) !== '*') || c === '/' || c === '%') {
        const save = this.pos;
        this.pos++;
        const right = this.trailing ? this.tryParse(() => this.parsePower()) : this.parsePower();
        if (!right) {
          this.pos = save;
          break;
        }
        left = { k: 'bin', op: c, a: left, b: right };
      } else break;
    }
    return left;
  }

  parsePower() {
    const base = this.parseUnary();
    this.skipWs();
    if (this.ch() === '*' && this.ch(1) === '*') {
      const save = this.pos;
      this.pos += 2;
      const exp = this.trailing ? this.tryParse(() => this.parsePower()) : this.parsePower();
      if (!exp) {
        this.pos = save;
        return base;
      }
      return { k: 'bin', op: '**', a: base, b: exp };
    }
    return base;
  }

  parseUnary() {
    this.skipWs();
    const c = this.ch();
    if (c === '-') {
      this.pos++;
      return { k: 'neg', a: this.parseUnary() };
    }
    if (c === '+') {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    this.skipWs();
    const leading = this.parseLabels();
    const node = this.parsePrimary();
    if (leading.length) node.pre = leading;
    const labels = this.parseLabels();
    if (labels.length) node.labels = (node.labels || []).concat(labels);
    return node;
  }

  // [метка] — может быть несколько подряд
  parseLabels() {
    const out = [];
    for (;;) {
      const save = this.pos;
      this.skipWs();
      if (this.ch() === '[' && this.ch(1) !== '[') {
        const end = this.s.indexOf(']', this.pos + 1);
        if (end < 0) {
          this.pos = save;
          break;
        }
        out.push(this.s.slice(this.pos + 1, end));
        this.pos = end + 1;
      } else {
        this.pos = save;
        break;
      }
    }
    return out;
  }

  parseNumberLiteral() {
    const s = this.s;
    const start = this.pos;
    while (this.isDigit(s[this.pos])) this.pos++;
    if (s[this.pos] === '.' && this.isDigit(s[this.pos + 1])) {
      this.pos++;
      while (this.isDigit(s[this.pos])) this.pos++;
    }
    if (start === this.pos) this.error('Ожидалось число');
    return parseFloat(s.slice(start, this.pos));
  }

  parseInt() {
    const s = this.s;
    const start = this.pos;
    while (this.isDigit(s[this.pos])) this.pos++;
    if (start === this.pos) return null;
    return parseInt(s.slice(start, this.pos), 10);
  }

  isDiceStart(o = 0) {
    const c = this.ch(o);
    if (c !== 'd' && c !== 'D') return false;
    const n = this.ch(o + 1);
    return this.isDigit(n) || n === 'F' || n === 'f' || n === '%' || n === '(';
  }

  isTableStart(o = 0) {
    const c = this.ch(o);
    return (c === 't' || c === 'T') && this.ch(o + 1) === '[';
  }

  parsePrimary() {
    this.skipWs();
    const c = this.ch();
    // Пустой операнд — например, незаполненный атрибут в «floor(@{san}/2)» или «@{bonus}*2» — считаем нулём
    if (this.allowEmpty && (c === undefined || c === ')' || c === '*' || c === '/' || c === '%' || c === ',' || c === '}')) return { k: 'num', v: 0, empty: true };
    if (c === undefined) this.error('Неожиданный конец выражения');

    // Число, возможно количество кубиков
    if (this.isDigit(c) || (c === '.' && this.isDigit(this.ch(1)))) {
      const n = this.parseNumberLiteral();
      if (this.isDiceStart()) return this.parseDice({ k: 'num', v: n });
      if (this.isTableStart()) return this.parseTable({ k: 'num', v: n });
      return { k: 'num', v: n };
    }
    if (this.isDiceStart()) return this.parseDice({ k: 'num', v: 1 });
    if (this.isTableStart()) return this.parseTable({ k: 'num', v: 1 });

    if (c === '(') {
      this.pos++;
      const inner = this.parseExpression();
      this.skipWs();
      if (this.ch() !== ')') this.error('Ожидалась «)»');
      this.pos++;
      const node = { k: 'paren', a: inner };
      if (this.isDiceStart()) return this.parseDice(node);
      if (this.isTableStart()) return this.parseTable(node);
      return node;
    }

    if (c === '{') return this.parseGroup();

    // Функции
    const m = /^([a-zA-Z]+)\s*\(/.exec(this.s.slice(this.pos, this.pos + 12));
    if (m && FUNCS.includes(m[1].toLowerCase())) {
      this.pos += m[0].length;
      const inner = this.parseExpression();
      this.skipWs();
      if (this.ch() !== ')') this.error('Ожидалась «)»');
      this.pos++;
      return { k: 'fn', name: m[1].toLowerCase(), a: inner };
    }

    this.error(`Неожиданный символ «${c}»`);
  }

  parseTable(countNode) {
    this.pos++; // t
    let name;
    if (this.ch() === '[') {
      const end = this.s.indexOf(']', this.pos + 1);
      if (end < 0) this.error('Не закрыта таблица t[...]');
      name = this.s.slice(this.pos + 1, end);
      this.pos = end + 1;
    }
    return { k: 'table', count: countNode, name: name.trim() };
  }

  parseCP(required) {
    // точка сравнения: [<|>|=|<=|>=]?число
    const s = this.s;
    let op = '=';
    const c = s[this.pos];
    if (c === '<' || c === '>' || c === '=') {
      op = c;
      this.pos++;
      if (s[this.pos] === '=' && op !== '=') this.pos++;
    }
    const save = this.pos;
    let neg = false;
    if (s[this.pos] === '-') {
      neg = true;
      this.pos++;
    }
    if (!this.isDigit(s[this.pos])) {
      this.pos = save;
      if (required || op !== '=' || c === '=') this.error('Ожидалось число в точке сравнения');
      return null;
    }
    let v = this.parseNumberLiteral();
    if (neg) v = -v;
    return { op, v };
  }

  parseDice(countNode) {
    this.pos++; // d
    let sides;
    const c = this.ch();
    if (c === 'F' || c === 'f') {
      this.pos++;
      sides = 'F';
    } else if (c === '%') {
      this.pos++;
      sides = { k: 'num', v: 100 };
    } else if (c === '(') {
      this.pos++;
      const inner = this.parseExpression();
      this.skipWs();
      if (this.ch() !== ')') this.error('Ожидалась «)»');
      this.pos++;
      sides = { k: 'paren', a: inner };
    } else {
      const n = this.parseInt();
      if (n === null) this.error('Ожидалось число граней');
      sides = { k: 'num', v: n };
    }
    const node = { k: 'dice', count: countNode, sides, mods: this.parseDiceMods() };
    return node;
  }

  parseDiceMods() {
    const mods = { rr: [], cs: [], cf: [] };
    const s = this.s;
    for (;;) {
      const c = s[this.pos];
      const n = s[this.pos + 1];
      if (c === '!') {
        let type = 'explode';
        this.pos++;
        if (s[this.pos] === '!') {
          type = 'compound';
          this.pos++;
        } else if (s[this.pos] === 'p' || s[this.pos] === 'P') {
          type = 'penetrate';
          this.pos++;
        }
        mods.explode = { type, cp: this.parseCP(false) };
        continue;
      }
      if (c === 'k' || c === 'K') {
        this.pos++;
        let dir = 'h';
        if (s[this.pos] === 'h' || s[this.pos] === 'l') dir = s[this.pos++];
        const v = this.parseInt();
        mods.keep = { type: 'k' + dir, n: v === null ? 1 : v };
        continue;
      }
      if ((c === 'd' || c === 'D') && (n === 'h' || n === 'l' || this.isDigit(n))) {
        this.pos++;
        let dir = 'l';
        if (s[this.pos] === 'h' || s[this.pos] === 'l') dir = s[this.pos++];
        const v = this.parseInt();
        mods.keep = { type: 'd' + dir, n: v === null ? 1 : v };
        continue;
      }
      if (c === 'r' || c === 'R') {
        this.pos++;
        let once = false;
        if (s[this.pos] === 'o') {
          once = true;
          this.pos++;
        }
        const cp = this.parseCP(false) || { op: '=', v: 1 };
        mods.rr.push({ cp, once });
        continue;
      }
      if (c === 'c' && (n === 's' || n === 'f')) {
        this.pos += 2;
        const cp = this.parseCP(false);
        if (cp) mods[n === 's' ? 'cs' : 'cf'].push(cp);
        continue;
      }
      if (c === 's' || c === 'S') {
        // s, sa, sd — но не начало следующего слова
        if (n === 'a' || n === 'd') {
          mods.sort = n;
          this.pos += 2;
        } else {
          mods.sort = 'a';
          this.pos++;
        }
        continue;
      }
      if (c === 'm' || c === 'M') {
        this.pos++;
        let count = false;
        if (s[this.pos] === 't') {
          count = true;
          this.pos++;
        }
        const min = this.parseInt();
        const cp = s[this.pos] === '<' || s[this.pos] === '>' || s[this.pos] === '=' ? this.parseCP(true) : null;
        mods.match = { count, min: min || 2, cp };
        continue;
      }
      if (c === '>' || c === '<' || c === '=') {
        mods.success = this.parseCP(true);
        continue;
      }
      if ((c === 'f' || c === 'F') && (this.isDigit(n) || n === '<' || n === '>' || n === '=')) {
        this.pos++;
        mods.failure = this.parseCP(true);
        continue;
      }
      break;
    }
    return mods;
  }

  parseGroup() {
    this.pos++; // {
    const items = [];
    for (;;) {
      this.skipWs();
      if (this.ch() === '}') break;
      items.push(this.parseExpression());
      this.skipWs();
      if (this.ch() === ',') {
        this.pos++;
        continue;
      }
      if (this.ch() === '}') break;
      this.error('Ожидалась «,» или «}» в групповом броске');
    }
    this.pos++; // }
    if (!items.length) this.error('Пустой групповой бросок');
    const mods = {};
    const s = this.s;
    for (;;) {
      const c = s[this.pos];
      const n = s[this.pos + 1];
      if (c === 'k' || c === 'K') {
        this.pos++;
        let dir = 'h';
        if (s[this.pos] === 'h' || s[this.pos] === 'l') dir = s[this.pos++];
        const v = this.parseInt();
        mods.keep = { type: 'k' + dir, n: v === null ? 1 : v };
        continue;
      }
      if ((c === 'd' || c === 'D') && (n === 'h' || n === 'l' || this.isDigit(n))) {
        this.pos++;
        let dir = 'l';
        if (s[this.pos] === 'h' || s[this.pos] === 'l') dir = s[this.pos++];
        const v = this.parseInt();
        mods.keep = { type: 'd' + dir, n: v === null ? 1 : v };
        continue;
      }
      if (c === '>' || c === '<' || c === '=') {
        mods.success = this.parseCP(true);
        continue;
      }
      if ((c === 'f' || c === 'F') && (this.isDigit(n) || n === '<' || n === '>' || n === '=')) {
        this.pos++;
        mods.failure = this.parseCP(true);
        continue;
      }
      break;
    }
    return { k: 'group', items, mods };
  }
}

/**
 * Разобрать выражение.
 * @param {string} expr
 * @param {{allowTrailing?: boolean}} opts allowTrailing — разрешить текст-комментарий после выражения (/roll 1d20 Атака)
 */
export function parseRoll(expr, opts = {}) {
  if (typeof expr !== 'string') expr = String(expr ?? '');
  if (expr.length > LIMITS.maxLength) throw new RollError('Слишком длинное выражение');
  const p = new Parser(expr);
  p.trailing = !!opts.allowTrailing;
  p.allowEmpty = opts.allowEmpty !== false;
  p.skipWs();
  if (p.pos >= expr.length) throw new RollError('Пустой бросок');
  const ast = p.parseExpression();
  p.skipWs();
  let comment = '';
  if (p.pos < expr.length) {
    if (!opts.allowTrailing) p.error(`Неожиданный символ «${expr[p.pos]}»`);
    comment = expr.slice(p.pos).replace(/^\\\s?/, '').trim();
  }
  return { ast, comment, expression: expr.slice(0, p.pos).trim() };
}

// ---------------------------------------------------------------------------
// Вычисление
// ---------------------------------------------------------------------------

function cpMatch(cp, v) {
  if (!cp) return false;
  if (cp.op === '>') return v >= cp.v;
  if (cp.op === '<') return v <= cp.v;
  return v === cp.v;
}

function defaultRng(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

class Evaluator {
  constructor(ctx = {}) {
    this.rng = ctx.rng || defaultRng;
    this.tables = ctx.tables || null; // (name) => [{name, weight}]
    this.diceCount = 0;
    this.allDice = []; // все кубики для определения критов
    this.tableResults = [];
  }

  num(node) {
    const r = this.eval(node);
    return r.v;
  }

  eval(node) {
    switch (node.k) {
      case 'num':
        return { v: node.v, t: 'sum' };
      case 'paren': {
        const r = this.eval(node.a);
        node.res = r;
        return r;
      }
      case 'neg': {
        const r = this.eval(node.a);
        return { v: -r.v, t: r.t };
      }
      case 'fn': {
        const r = this.eval(node.a);
        let v = r.v;
        if (node.name === 'floor') v = Math.floor(v);
        else if (node.name === 'ceil') v = Math.ceil(v);
        else if (node.name === 'round') v = Math.round(v);
        else if (node.name === 'abs') v = Math.abs(v);
        return { v, t: r.t };
      }
      case 'bin': {
        const a = this.eval(node.a);
        const b = this.eval(node.b);
        let v;
        switch (node.op) {
          case '+':
            v = a.v + b.v;
            break;
          case '-':
            v = a.v - b.v;
            break;
          case '*':
            v = a.v * b.v;
            break;
          case '/':
            v = b.v === 0 ? 0 : a.v / b.v;
            break;
          case '%':
            v = b.v === 0 ? 0 : a.v % b.v;
            break;
          case '**':
            v = Math.pow(a.v, b.v);
            break;
        }
        const t = a.t === 'success' || b.t === 'success' ? 'success' : 'sum';
        return { v, t };
      }
      case 'dice':
        return this.evalDice(node);
      case 'group':
        return this.evalGroup(node);
      case 'table':
        return this.evalTable(node);
    }
    throw new RollError('Неизвестный узел выражения');
  }

  rollOne(sides) {
    if (++this.diceCount > LIMITS.maxDice) throw new RollError('Слишком много кубиков в броске');
    if (sides === 'F') return this.rng(3) - 2;
    if (sides === 0) return 0;
    return this.rng(sides);
  }

  evalDice(node) {
    if (!node.dice) {
      // Бросаем один раз; повторное вычисление (для групп) пересчитывает только сумму
      let count = Math.round(this.num(node.count));
      let sides = node.sides === 'F' ? 'F' : Math.round(this.num(node.sides));
      if (!Number.isFinite(count) || count < 0) throw new RollError('Неверное количество кубиков');
      // d0 — кубик без граней, всегда 0 (так ведёт себя Roll20; листы используют «d0» как «нет кубика»)
      if (sides !== 'F' && (!Number.isFinite(sides) || sides < 0)) throw new RollError('Неверное число граней');
      if (sides !== 'F' && sides > LIMITS.maxSides) throw new RollError('Слишком много граней');
      if (count > LIMITS.maxDice) throw new RollError('Слишком много кубиков в броске');
      node.n = count;
      node.s = sides;
      const mods = node.mods;
      const maxV = sides === 'F' ? 1 : sides;
      const minV = sides === 'F' ? -1 : 1;
      const dice = [];
      const rollWithRerolls = () => {
        let v = this.rollOne(sides);
        const prev = [];
        if (mods.rr.length && sides !== 0) {
          // одноразовые перебросы
          for (const r of mods.rr) {
            if (r.once && cpMatch(r.cp, v)) {
              prev.push(v);
              v = this.rollOne(sides);
            }
          }
          // многократные перебросы
          const many = mods.rr.filter((r) => !r.once);
          let guard = 0;
          while (many.length && many.some((r) => cpMatch(r.cp, v)) && guard++ < LIMITS.maxPerDieRepeats) {
            prev.push(v);
            v = this.rollOne(sides);
          }
        }
        return { v, prev };
      };
      const ex = sides === 0 ? null : mods.explode;
      const exCp = ex ? ex.cp || { op: '=', v: maxV } : null;
      for (let i = 0; i < count; i++) {
        const first = rollWithRerolls();
        const die = { v: first.v };
        if (first.prev.length) die.rr = first.prev;
        if (ex && ex.type === 'compound') {
          let last = first.v;
          let total = first.v;
          let guard = 0;
          const parts = [first.v];
          while (cpMatch(exCp, last) && guard++ < LIMITS.maxPerDieRepeats) {
            last = this.rollOne(sides);
            total += last;
            parts.push(last);
          }
          die.v = total;
          if (parts.length > 1) die.cp = parts;
          dice.push(die);
        } else {
          dice.push(die);
          if (ex) {
            let last = first.v;
            let guard = 0;
            while (cpMatch(exCp, last) && guard++ < LIMITS.maxPerDieRepeats) {
              const r = rollWithRerolls();
              last = r.v;
              const nd = { v: ex.type === 'penetrate' ? r.v - 1 : r.v, ex: 1 };
              if (r.prev.length) nd.rr = r.prev;
              dice.push(nd);
            }
          }
        }
      }
      // Криты
      for (const d of dice) {
        const raw = d.cp ? d.cp[0] : d.v;
        if (sides !== 'F') {
          const cs = mods.cs.length ? mods.cs.some((cp) => cpMatch(cp, raw)) : raw === maxV;
          const cf = mods.cf.length ? mods.cf.some((cp) => cpMatch(cp, raw)) : raw === minV;
          if (cs) d.cs = 1;
          if (cf) d.cf = 1;
        }
      }
      // Сортировка
      if (mods.sort) {
        dice.sort((a, b) => (mods.sort === 'd' ? b.v - a.v : a.v - b.v));
      }
      node.dice = dice;
      node.maxV = maxV;
      applyKeepDrop(dice, mods.keep);
      for (const d of dice) this.allDice.push(d);
    }
    return this.diceValue(node);
  }

  diceValue(node) {
    const mods = node.mods;
    const kept = node.dice.filter((d) => !d.dr);
    if (mods.success || mods.failure) {
      let v = 0;
      for (const d of kept) {
        delete d.ok;
        delete d.bad;
        if (mods.success && cpMatch(mods.success, d.v)) {
          v++;
          d.ok = 1;
        }
        if (mods.failure && cpMatch(mods.failure, d.v)) {
          v--;
          d.bad = 1;
        }
      }
      node.total = v;
      return { v, t: 'success' };
    }
    if (mods.match) {
      const counts = new Map();
      for (const d of kept) {
        if (mods.match.cp && !cpMatch(mods.match.cp, d.v)) continue;
        counts.set(d.v, (counts.get(d.v) || 0) + 1);
      }
      let groups = 0;
      let gi = 0;
      for (const [val, c] of counts) {
        if (c >= mods.match.min) {
          groups++;
          for (const d of kept) if (d.v === val) d.mt = gi + 1;
          gi++;
        }
      }
      if (mods.match.count) {
        node.total = groups;
        return { v: groups, t: 'sum' };
      }
    }
    let v = 0;
    for (const d of kept) v += d.v;
    node.total = v;
    return { v, t: 'sum' };
  }

  collectDice(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (node.k === 'dice') {
      out.push(node);
      return out;
    }
    if (node.k === 'group') {
      for (const it of node.items) this.collectDice(it, out);
      return out;
    }
    for (const key of ['a', 'b']) if (node[key]) this.collectDice(node[key], out);
    return out;
  }

  evalGroup(node) {
    const mods = node.mods;
    if (node.items.length === 1) {
      const item = node.items[0];
      this.eval(item);
      if (mods.keep) {
        // keep/drop по всем кубикам внутри группы
        const diceNodes = this.collectDice(item, []);
        const all = [];
        for (const dn of diceNodes) for (const d of dn.dice || []) all.push(d);
        applyKeepDrop(all, mods.keep, true);
      }
      const r = this.eval(item); // пересчёт без переброса
      if (mods.success || mods.failure) {
        let v = 0;
        if (mods.success && cpMatch(mods.success, r.v)) v++;
        if (mods.failure && cpMatch(mods.failure, r.v)) v--;
        node.itemTotals = [{ v: r.v, ok: v > 0 ? 1 : 0, bad: v < 0 ? 1 : 0 }];
        node.total = v;
        return { v, t: 'success' };
      }
      node.itemTotals = [{ v: r.v }];
      node.total = r.v;
      return { v: r.v, t: r.t };
    }
    // Несколько подгрупп: модификаторы применяются к суммам подгрупп
    const totals = node.items.map((it) => {
      const r = this.eval(it);
      return { v: r.v, t: r.t };
    });
    const types = new Set(totals.map((t) => t.t));
    if (types.size > 1) throw new RollError('Все части группового броска должны быть одного типа');
    applyKeepDrop(totals, mods.keep);
    const kept = totals.filter((t) => !t.dr);
    let v = 0;
    let t = totals[0].t;
    if (mods.success || mods.failure) {
      for (const it of kept) {
        if (mods.success && cpMatch(mods.success, it.v)) {
          v++;
          it.ok = 1;
        }
        if (mods.failure && cpMatch(mods.failure, it.v)) {
          v--;
          it.bad = 1;
        }
      }
      t = 'success';
    } else {
      for (const it of kept) v += it.v;
    }
    node.itemTotals = totals;
    node.total = v;
    return { v, t };
  }

  evalTable(node) {
    if (!node.picks) {
      const count = Math.max(0, Math.round(this.num(node.count)));
      if (count > 100) throw new RollError('Слишком много бросков по таблице');
      const items = this.tables ? this.tables(node.name) : null;
      if (!items) throw new RollError(`Таблица «${node.name}» не найдена`);
      const usable = items.filter((it) => (Number(it.weight) || 0) > 0);
      if (!usable.length) throw new RollError(`Таблица «${node.name}» пуста`);
      const totalW = usable.reduce((s, it) => s + Math.max(1, Math.round(Number(it.weight) || 0)), 0);
      const picks = [];
      for (let i = 0; i < count; i++) {
        let r = this.rng(totalW);
        let chosen = usable[usable.length - 1];
        for (const it of usable) {
          r -= Math.max(1, Math.round(Number(it.weight) || 0));
          if (r <= 0) {
            chosen = it;
            break;
          }
        }
        picks.push({ name: String(chosen.name ?? ''), avatar: chosen.avatar || '' });
      }
      node.picks = picks;
      this.tableResults.push(...picks);
    }
    const picks = node.picks;
    const allNum = picks.length > 0 && picks.every((p) => p.name.trim() !== '' && Number.isFinite(Number(p.name)));
    const v = allNum ? picks.reduce((a, p) => a + Number(p.name), 0) : 0;
    node.total = v;
    return { v, t: allNum ? 'sum' : 'table' };
  }
}

function applyKeepDrop(list, keep, mark) {
  if (!keep) return;
  const n = Math.max(0, keep.n);
  const idx = list.map((d, i) => i).filter((i) => !list[i].dr || !mark);
  idx.sort((a, b) => list[a].v - list[b].v || a - b); // по возрастанию
  let dropIdx = [];
  if (keep.type === 'kh') dropIdx = idx.slice(0, Math.max(0, idx.length - n));
  else if (keep.type === 'kl') dropIdx = idx.slice(Math.min(n, idx.length));
  else if (keep.type === 'dh') dropIdx = idx.slice(Math.max(0, idx.length - n));
  else if (keep.type === 'dl') dropIdx = idx.slice(0, Math.min(n, idx.length));
  for (const i of dropIdx) list[i].dr = 1;
}

// ---------------------------------------------------------------------------
// Форматирование (подсказка «Rolling ... = ...»)
// ---------------------------------------------------------------------------

function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return String(v);
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
}

/**
 * Превратить вычисленное дерево в список частей для отображения.
 * Части: {t:'text', s}, {t:'dice', sides, dice:[...]}, {t:'label', s}, {t:'group', items:[...]}
 */
function formatNode(node, out) {
  if (node.pre) for (const l of node.pre) out.push({ t: 'label', s: l });
  switch (node.k) {
    case 'num':
      out.push({ t: 'text', s: fmtNum(node.v) });
      break;
    case 'paren':
      out.push({ t: 'text', s: '(' });
      formatNode(node.a, out);
      out.push({ t: 'text', s: ')' });
      break;
    case 'neg':
      out.push({ t: 'text', s: '-' });
      formatNode(node.a, out);
      break;
    case 'fn':
      out.push({ t: 'text', s: node.name + '(' });
      formatNode(node.a, out);
      out.push({ t: 'text', s: ')' });
      break;
    case 'bin':
      formatNode(node.a, out);
      out.push({ t: 'text', s: node.op });
      formatNode(node.b, out);
      break;
    case 'dice':
      out.push({ t: 'dice', sides: node.s, dice: node.dice || [], total: node.total });
      break;
    case 'group': {
      const items = node.items.map((it, i) => {
        const sub = [];
        formatNode(it, sub);
        const tot = node.itemTotals && node.itemTotals[i];
        return { parts: sub, v: tot ? tot.v : undefined, dr: tot && tot.dr ? 1 : 0, ok: tot && tot.ok ? 1 : 0, bad: tot && tot.bad ? 1 : 0 };
      });
      out.push({ t: 'group', items, total: node.total });
      break;
    }
    case 'table':
      out.push({ t: 'table', name: node.name, picks: node.picks || [] });
      break;
  }
  if (node.labels) for (const l of node.labels) out.push({ t: 'label', s: l });
  return out;
}

function collectRollsForCRP(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.k === 'dice') {
    out.push({ dice: node.n, sides: node.s === 'F' ? 'F' : node.s, results: (node.dice || []).map((d) => d.v) });
    return out;
  }
  if (node.k === 'group') {
    for (const it of node.items) collectRollsForCRP(it, out);
    return out;
  }
  if (node.k === 'table') return out;
  if (node.a) collectRollsForCRP(node.a, out);
  if (node.b) collectRollsForCRP(node.b, out);
  if (node.count && node.count.k) collectRollsForCRP(node.count, out);
  return out;
}

/**
 * Бросить выражение целиком.
 * @returns {{expression, total, type, parts, crit, fumble, dice, rolls, comment, tableText}}
 */
export function rollExpression(expr, ctx = {}) {
  const { ast, comment, expression } = parseRoll(expr, { allowTrailing: !!ctx.allowTrailing });
  const ev = new Evaluator(ctx);
  const r = ev.eval(ast);
  let total = r.v;
  if (typeof total === 'number' && !Number.isFinite(total)) total = 0;
  const kept = ev.allDice.filter((d) => !d.dr);
  const crit = kept.some((d) => d.cs);
  const fumble = kept.some((d) => d.cf);
  const parts = formatNode(ast, []);
  const result = {
    expression,
    total: typeof total === 'number' ? Math.round(total * 1e9) / 1e9 : total,
    type: r.t,
    parts,
    crit,
    fumble,
    dice: ev.allDice.map((d) => d.v),
    rolls: collectRollsForCRP(ast, []),
  };
  if (comment) result.comment = comment;
  if (ev.tableResults.length && r.t === 'table') {
    result.tableText = ev.tableResults.map((p) => p.name).join(', ');
    result.tableItems = ev.tableResults;
  }
  return result;
}

/** Текстовое представление подсказки (без HTML). */
export function partsToText(parts) {
  let s = '';
  for (const p of parts) {
    if (p.t === 'text') s += p.s;
    else if (p.t === 'label') s += `[${p.s}]`;
    else if (p.t === 'dice') s += '(' + p.dice.map((d) => (d.dr ? `~${d.v}` : d.v)).join('+') + ')';
    else if (p.t === 'group') s += '{' + p.items.map((it) => partsToText(it.parts)).join(', ') + '}';
    else if (p.t === 'table') s += p.picks.map((x) => x.name).join(', ');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Inline-броски [[...]]
// ---------------------------------------------------------------------------

/**
 * Найти inline-броски с учётом вложенности и меток [label].
 * Возвращает дерево узлов {start, end, innerStart, innerEnd, children}.
 */
export function findInlineRolls(text) {
  const roots = [];
  const stack = []; // {type: 'inline'|'label', node?}
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '[' && text[i + 1] === '[') {
      const node = { start: i, innerStart: i + 2, children: [] };
      stack.push({ type: 'inline', node });
      i += 2;
      continue;
    }
    if (c === '[' && stack.length) {
      stack.push({ type: 'label' });
      i++;
      continue;
    }
    if (c === ']' && stack.length) {
      const top = stack[stack.length - 1];
      if (top.type === 'label') {
        stack.pop();
        i++;
        continue;
      }
      if (text[i + 1] === ']') {
        stack.pop();
        const node = top.node;
        node.innerEnd = i;
        node.end = i + 2;
        // родитель
        let parent = null;
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].type === 'inline') {
            parent = stack[k].node;
            break;
          }
        }
        if (parent) parent.children.push(node);
        else roots.push(node);
        i += 2;
        continue;
      }
    }
    i++;
  }
  return roots;
}

const TRACKER_RE = /&\{tracker(?::([+-]))?\}/i;

/**
 * Обработать все inline-броски в тексте.
 * @param {string} text
 * @param {object} ctx — {rng, tables}
 * @returns {{text: string, rolls: object[]}} текст с плейсхолдерами $[[n]]
 */
export function processInlineRolls(text, ctx = {}) {
  const rolls = [];
  const roots = findInlineRolls(text);
  if (!roots.length) return { text, rolls };

  const evalNode = (node) => {
    // собрать содержимое, заменив вложенные броски их результатами
    let content = '';
    let pos = node.innerStart;
    for (const ch of node.children) {
      content += text.slice(pos, ch.start);
      const r = evalNode(ch);
      content += r.type === 'table' && r.tableText != null ? r.tableText : fmtNum(r.total);
      pos = ch.end;
    }
    content += text.slice(pos, node.innerEnd);
    let tracker = null;
    const tm = TRACKER_RE.exec(content);
    if (tm) {
      tracker = tm[1] || '=';
      content = content.replace(TRACKER_RE, ' ');
    }
    // пустой inline-бросок [[ ]] (например, из пустого атрибута) Roll20 считает нулём
    if (!content.replace(/\[[^\]]*\]/g, '').trim()) content = '0' + content;
    const r = rollExpression(content, { ...ctx, allowTrailing: true });
    if (tracker) r.tracker = tracker;
    r.index = rolls.length;
    rolls.push(r);
    return r;
  };

  let out = '';
  let pos = 0;
  for (const root of roots) {
    out += text.slice(pos, root.start);
    const r = evalNode(root);
    out += `$[[${r.index}]]`;
    pos = root.end;
  }
  out += text.slice(pos);
  return { text: out, rolls };
}

/** Есть ли в результате броска криты/провалы (для подсветки inline-броска). */
export function critClass(roll) {
  if (!roll) return '';
  if (roll.crit && roll.fumble) return 'importantroll';
  if (roll.crit) return 'fullcrit';
  if (roll.fumble) return 'fullfail';
  return '';
}

export { fmtNum as formatNumber };
