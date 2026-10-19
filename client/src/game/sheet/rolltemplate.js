// Шаблоны бросков Roll20: {{key}}, {{#key}}, {{^key}}, {{#rollWasCrit() key}}, {{#^rollTotal() key 5}}, {{#allprops() ...}}, {{computed::key}}

export const DEFAULT_TEMPLATE = `<table>
<caption>{{name}}</caption>
{{#allprops() name}}
<tr><td>{{key}}</td><td>{{value}}</td></tr>
{{/allprops() name}}
</table>`;

const cache = new Map();

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

export function compileTemplate(src) {
  if (cache.has(src)) return cache.get(src);
  const root = { t: 'root', children: [] };
  const stack = [root];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m;
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(src))) {
    if (m.index > last) top().children.push({ t: 'text', s: src.slice(last, m.index) });
    last = re.lastIndex;
    const raw = m[1];
    const body = raw.trim();
    if (body.startsWith('#') || (body.startsWith('^') && !body.startsWith('^{'))) {
      let neg = false,
        rest;
      if (body.startsWith('#^')) {
        neg = true;
        rest = body.slice(2);
      } else if (body.startsWith('#')) rest = body.slice(1);
      else {
        neg = true;
        rest = body.slice(1);
      }
      const node = { t: 'sec', neg, key: norm(rest), children: [] };
      const hm = /^([A-Za-z]+)\(\)\s*([\s\S]*)$/.exec(rest.trim());
      if (hm) {
        node.helper = hm[1].toLowerCase();
        node.args = hm[2].trim() ? hm[2].trim().split(/\s+/) : [];
      } else node.prop = rest;
      // ключ закрывающего тега
      node.closeKey = body.startsWith('#^') ? '^' + norm(rest) : norm(rest);
      top().children.push(node);
      stack.push(node);
    } else if (body.startsWith('/')) {
      const rest = body.slice(1);
      const key = rest.startsWith('^') ? '^' + norm(rest.slice(1)) : norm(rest);
      // ищем ближайший открытый блок с этим ключом
      let idx = -1;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].closeKey === key || stack[i].key === norm(rest.replace(/^\^/, ''))) {
          idx = i;
          break;
        }
      }
      if (idx > 0) stack.length = idx;
    } else {
      top().children.push({ t: 'var', name: raw });
    }
  }
  if (last < src.length) top().children.push({ t: 'text', s: src.slice(last) });
  cache.set(src, root);
  return root;
}

/**
 * Отрисовать шаблон.
 * ctx: {
 *   props: Map(key -> rawValue),
 *   order: [key...],
 *   value(key) -> html  (отформатированное значение)
 *   rollOf(key) -> {total, crit, fumble} | null  (первый inline-бросок свойства)
 *   computed: {key: value}
 *   computedHtml(key) -> html
 * }
 */
export function renderTemplate(src, ctx) {
  const ast = compileTemplate(src);
  let out = '';
  const walk = (nodes, scope) => {
    for (const n of nodes) {
      if (n.t === 'text') out += n.s;
      else if (n.t === 'var') out += renderVar(n.name, ctx, scope);
      else if (n.t === 'sec') {
        if (n.helper === 'allprops') {
          const exclude = new Set(n.args);
          if (!n.neg) {
            for (const k of ctx.order) {
              if (exclude.has(k)) continue;
              walk(n.children, { key: k });
            }
          }
          continue;
        }
        let ok = evalCond(n, ctx, scope);
        // хелпер для отсутствующего свойства (или не-числа) в Roll20 не выводит ни прямую, ни обратную ветку
        if (ok === null) continue;
        if (n.neg) ok = !ok;
        if (ok) walk(n.children, scope);
      }
    }
  };
  walk(ast.children, null);
  return out;
}

function renderVar(name, ctx, scope) {
  const n = name.trim();
  if (scope) {
    if (n === 'key') return ctx.keyHtml ? ctx.keyHtml(scope.key) : escape(scope.key);
    if (n === 'value') return ctx.value(scope.key);
  }
  if (n.startsWith('computed::')) {
    const k = n.slice(10);
    return ctx.computedHtml ? ctx.computedHtml(k) : escape(String(ctx.computed?.[k] ?? ''));
  }
  if (!ctx.props.has(name) && !ctx.props.has(n)) return '';
  return ctx.value(ctx.props.has(name) ? name : n);
}

function propTruthy(ctx, key) {
  const k = ctx.props.has(key) ? key : key.trim();
  if (!ctx.props.has(k)) return false;
  const v = ctx.props.get(k);
  return String(v ?? '').trim() !== '';
}

function numberOf(ctx, ref) {
  if (ref === undefined) return NaN;
  if (ref.startsWith('computed::')) {
    const v = ctx.computed?.[ref.slice(10)];
    if (v !== undefined) return Number(v);
    return numberOf(ctx, ref.slice(10));
  }
  if (ctx.props.has(ref)) {
    const r = ctx.rollOf(ref);
    if (r) return Number(r.total);
    const n = parseFloat(String(ctx.props.get(ref)).replace(/<[^>]*>/g, ''));
    return n;
  }
  return parseFloat(ref);
}

function hasRef(ctx, ref) {
  if (ref === undefined) return false;
  if (ref.startsWith('computed::')) return ctx.computed?.[ref.slice(10)] !== undefined || ctx.props.has(ref.slice(10));
  return ctx.props.has(ref);
}

function evalCond(n, ctx, scope) {
  if (!n.helper) return propTruthy(ctx, n.prop);
  const a = n.args;
  const key = a[0];
  const num = (ref) => {
    const v = numberOf(ctx, ref);
    return Number.isFinite(v) ? v : null;
  };
  switch (n.helper) {
    case 'rollwascrit':
    case 'rollwasfumble': {
      if (!hasRef(ctx, key)) return null;
      const r = key.startsWith('computed::') ? ctx.rollOf(key.slice(10)) : ctx.rollOf(key);
      if (!r) return null;
      return !!(n.helper === 'rollwascrit' ? r.crit : r.fumble);
    }
    case 'rolltotal':
    case 'rollgreater':
    case 'rollless':
    case 'rollbetween': {
      if (!hasRef(ctx, key)) return null;
      const v = num(key);
      const x = num(a[1]);
      if (v === null || x === null) return null;
      if (n.helper === 'rolltotal') return v === x;
      if (n.helper === 'rollgreater') return v > x;
      if (n.helper === 'rollless') return v < x;
      const y = num(a[2]);
      if (y === null) return null;
      return v >= x && v <= y;
    }
    default:
      return false;
  }
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
