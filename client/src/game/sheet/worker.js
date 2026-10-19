// Песочница для sheet workers (скриптов листа Roll20).
// Код листа выполняется в Web Worker с изолированным (opaque) origin — у него нет доступа
// ни к странице, ни к cookie, ни к API сервера. Общение — только через postMessage.
import underscoreSrc from 'underscore/underscore-umd-min.js?raw';

// Этот код выполняется ВНУТРИ воркера
function bootstrap() {
  'use strict';
  var G = self;
  var handlers = Object.create(null);
  var activeCharacterId = null;
  var activeRow = null;
  var seq = 0;
  var pending = new Map();
  var translations = {};
  var lang = 'en';
  var post = function (m) {
    G.postMessage(m);
  };

  function clean(v) {
    try {
      return JSON.parse(JSON.stringify(v === undefined ? null : v));
    } catch (e) {
      return null;
    }
  }

  function report(e, where) {
    post({ type: 'error', message: String((e && e.message) || e), stack: String((e && e.stack) || ''), where: where || '' });
  }
  // ошибки в async-обработчиках листа (CRP) — тоже в отчёт, а не «необработанной ошибкой» на странице
  G.addEventListener('unhandledrejection', function (ev) {
    report(ev.reason, 'async');
    ev.preventDefault();
  });
  G.addEventListener('error', function (ev) {
    report(ev.error || ev.message, 'async');
    ev.preventDefault();
  });

  function withCtx(charId, row, fn, args, where) {
    var pc = activeCharacterId,
      pr = activeRow;
    activeCharacterId = charId;
    activeRow = row;
    try {
      return fn.apply(null, args || []);
    } catch (e) {
      report(e, where);
    } finally {
      activeCharacterId = pc;
      activeRow = pr;
    }
  }

  // как shared/ids.js: время — 63 символа без "_", случайная часть — без "_" и заглавных,
  // чтобы id строк не совпадали без учёта регистра и росли в порядке создания
  var TIMECH = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  var ROWCH = '-0123456789abcdefghijklmnopqrstuvwxyz';
  var lastT = 0,
    lastR = [];
  function generateUUID() {
    var now = Date.now(),
      dup = now === lastT,
      base = ROWCH.length;
    lastT = now;
    var ts = new Array(8);
    for (var i = 7; i >= 0; i--) {
      ts[i] = TIMECH.charAt(now % 63);
      now = Math.floor(now / 63);
    }
    var id = ts.join('');
    if (!dup) for (i = 0; i < 12; i++) lastR[i] = Math.floor(Math.random() * base);
    else {
      for (i = 11; i >= 0 && lastR[i] === base - 1; i--) lastR[i] = 0;
      if (i >= 0) lastR[i]++;
    }
    for (i = 0; i < 12; i++) id += ROWCH.charAt(lastR[i]);
    return id;
  }

  G.on = function (events, fn) {
    if (typeof fn !== 'function') return;
    String(events || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .forEach(function (ev) {
        (handlers[ev] = handlers[ev] || []).push(fn);
      });
  };
  G.getAttrs = function (names, cb) {
    var id = ++seq;
    pending.set(id, { cb: cb, charId: activeCharacterId, row: activeRow });
    post({ type: 'getAttrs', id: id, charId: activeCharacterId, row: activeRow, names: Array.isArray(names) ? names.map(String) : [] });
  };
  G.setAttrs = function (values, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    var id = 0;
    if (typeof cb === 'function') {
      id = ++seq;
      pending.set(id, { cb: cb, charId: activeCharacterId, row: activeRow });
    }
    post({ type: 'setAttrs', id: id, charId: activeCharacterId, row: activeRow, values: clean(values || {}), silent: !!(options && options.silent) });
  };
  G.getSectionIDs = function (section, cb) {
    var id = ++seq;
    pending.set(id, { cb: cb, charId: activeCharacterId, row: activeRow });
    post({ type: 'getSectionIDs', id: id, charId: activeCharacterId, section: String(section || '') });
  };
  G.generateRowID = function () {
    return generateUUID();
  };
  G.removeRepeatingRow = function (rowName) {
    post({ type: 'removeRow', charId: activeCharacterId, row: String(rowName || '') });
  };
  // log(...) доступен скриптам листов в Roll20 так же, как console.log (лист может объявить свой)
  G.log = function () {
    try {
      console.log.apply(console, arguments);
    } catch (e) {}
  };
  G.getTranslationByKey = function (key) {
    if (Object.prototype.hasOwnProperty.call(translations, key)) return translations[key];
    return false;
  };
  G.getTranslationLanguage = function () {
    return lang;
  };
  G.setDefaultToken = function (values) {
    post({ type: 'setDefaultToken', charId: activeCharacterId, values: clean(values || {}) });
  };
  G.startRoll = function (text, cb) {
    var id = ++seq;
    var resolveP;
    var p = new Promise(function (r) {
      resolveP = r;
    });
    pending.set(id, {
      cb: function (res) {
        if (typeof cb === 'function') cb(res);
        resolveP(res);
      },
      charId: activeCharacterId,
      row: activeRow,
      async: true,
    });
    post({ type: 'startRoll', id: id, charId: activeCharacterId, row: activeRow, text: String(text || '') });
    return p;
  };
  G.finishRoll = function (rollId, computed) {
    post({ type: 'finishRoll', rollId: rollId, computed: clean(computed || {}) });
  };
  G.getActiveCharacterId = function () {
    return activeCharacterId;
  };
  G.setActiveCharacterId = function (id) {
    activeCharacterId = id;
  };
  // jQuery листов Roll20 ($20): on/addClass/removeClass/toggleClass.
  // Обработчики живут здесь; DOM — в песочнице листа, события приходят сообщениями.
  var jqHandlers = [];
  G.$20 = function (selector) {
    var sel = String(selector || '');
    var api = {
      on: function (events, fn) {
        if (typeof events === 'function') return api;
        if (typeof fn !== 'function') return api;
        var list = String(events || '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        var expanded = [];
        list.forEach(function (ev) {
          if (ev === 'hover') expanded.push('mouseenter', 'mouseleave');
          else expanded.push(ev);
        });
        var id = jqHandlers.length;
        jqHandlers.push(fn);
        post({ type: 'jq:on', id: id, selector: sel, events: expanded });
        return api;
      },
      off: function () {
        return api;
      },
      addClass: function (c) {
        post({ type: 'jq:class', charId: activeCharacterId, selector: sel, op: 'add', cls: String(c || '') });
        return api;
      },
      removeClass: function (c) {
        post({ type: 'jq:class', charId: activeCharacterId, selector: sel, op: 'remove', cls: String(c || '') });
        return api;
      },
      toggleClass: function (c, state) {
        var op = state === true ? 'add' : state === false ? 'remove' : 'toggle';
        post({ type: 'jq:class', charId: activeCharacterId, selector: sel, op: op, cls: String(c || '') });
        return api;
      },
    };
    return api;
  };

  // Компендиум и Charactermancer Roll20 недоступны — заглушки
  var noop = function () {};
  G.getCompendiumPage = function (pages, cb) {
    if (typeof cb === 'function')
      setTimeout(function () {
        cb(Array.isArray(pages) ? [] : { name: '', data: {} });
      }, 0);
  };
  G.getCompendiumQuery = function (q, cb) {
    if (typeof cb === 'function')
      setTimeout(function () {
        cb([]);
      }, 0);
  };
  G.changeCompendiumPage = noop;
  G.startCharactermancer = function () {
    post({ type: 'notice', text: 'Charactermancer Roll20 здесь недоступен — заполните лист вручную.' });
  };
  G.setCharmancerText = noop;
  G.setCharmancerOptions = noop;
  G.disableCharmancerOptions = noop;
  G.changeCharmancerPage = noop;
  G.getCharmancerData = function () {
    return {};
  };
  G.deleteCharmancerData = noop;
  G.finishCharactermancer = noop;
  G.showChoices = noop;
  G.hideChoices = noop;
  G.addRepeatingSection = noop;
  G.clearRepeatingSections = noop;
  G.clearRepeatingSectionById = noop;
  G.getRepeatingSections = function (a, cb) {
    if (typeof cb === 'function') cb({});
  };

  // Запрещаем сетевой доступ коду листа
  ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker'].forEach(function (k) {
    try {
      Object.defineProperty(G, k, { value: undefined, configurable: false, writable: false });
    } catch (e) {
      try {
        G[k] = undefined;
      } catch (e2) {}
    }
  });

  function dispatch(m) {
    var total = 0;
    for (var i = 0; i < m.events.length; i++) {
      var list = handlers[m.events[i]];
      if (!list) continue;
      for (var j = 0; j < list.length; j++) {
        total++;
        var info = clean(m.info) || {};
        info.triggerName = info.triggerName || m.events[i];
        withCtx(m.charId, m.row || null, list[j], [info], m.events[i]);
      }
    }
    return total;
  }

  G.onmessage = function (e) {
    var m = e.data;
    if (!m || !m.type) return;
    if (m.type === 'init') {
      translations = m.translations || {};
      lang = m.lang || 'en';
      try {
        (0, eval)(m.underscore);
      } catch (err) {
        report(err, 'underscore');
      }
      try {
        (0, eval)(m.code + '\n//# sourceURL=sheetworkers.js');
      } catch (err) {
        report(err, 'load');
      }
      try {
        Object.defineProperty(G, 'importScripts', { value: undefined, configurable: false, writable: false });
      } catch (err) {}
      post({ type: 'ready', events: Object.keys(handlers) });
    } else if (m.type === 'event') {
      var n = dispatch(m);
      post({ type: 'dispatched', n: n, token: m.token });
    } else if (m.type === 'jq:event') {
      var h = jqHandlers[m.id];
      if (typeof h === 'function') withCtx(m.charId, null, h, [clean(m.info) || {}], '$20 ' + (m.info && m.info.type));
    } else if (m.type === 'response') {
      var p = pending.get(m.id);
      pending.delete(m.id);
      if (!p || typeof p.cb !== 'function') return;
      if (p.async) {
        // продолжение после «await startRoll()» выполняется микрозадачей, уже после ответа:
        // контекст персонажа держим до конца этой макрозадачи, иначе setAttrs после await не знает, чей лист
        var pc = activeCharacterId,
          pr = activeRow;
        activeCharacterId = p.charId;
        activeRow = p.row;
        try {
          p.cb(m.data);
        } catch (err) {
          report(err, 'callback');
        }
        setTimeout(function () {
          if (activeCharacterId === p.charId && activeRow === p.row) {
            activeCharacterId = pc;
            activeRow = pr;
          }
        }, 0);
      } else withCtx(p.charId, p.row, p.cb, [m.data], 'callback');
    } else if (m.type === 'ping') {
      post({ type: 'pong' });
    }
  };
}

function workerUrl() {
  const src = `(${bootstrap.toString()})();`;
  // data: URL даёт воркеру непрозрачный origin (полная изоляция)
  try {
    return { url: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src), kind: 'data' };
  } catch {
    return { url: URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), kind: 'blob' };
  }
}

export class SheetWorkerHost {
  constructor(engine) {
    this.engine = engine;
    this.worker = null;
    this.readyPromise = null;
    this.events = new Set();
    this.rate = [];
    this.paused = false;
    this.errors = 0;
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    const tpl = this.engine.template;
    if (!tpl || !tpl.workerCode.trim()) {
      this.readyPromise = Promise.resolve(false);
      return this.readyPromise;
    }
    this.readyPromise = new Promise((resolve) => {
      let w;
      const { url, kind } = workerUrl();
      try {
        w = new Worker(url);
      } catch (e) {
        try {
          w = new Worker(URL.createObjectURL(new Blob([`(${bootstrap.toString()})();`], { type: 'text/javascript' })));
        } catch (e2) {
          console.error('[sheetworker] не удалось запустить воркер', e2);
          resolve(false);
          return;
        }
      }
      this.kind = kind;
      this.worker = w;
      const timer = setTimeout(() => resolve(true), 15000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          this.events = new Set(m.events || []);
          resolve(true);
          return;
        }
        this.onMessage(m);
      };
      w.onerror = (e) => {
        console.error('[sheetworker]', e.message || e);
      };
      w.postMessage({ type: 'init', code: tpl.workerCode, underscore: underscoreSrc, translations: tpl.translation, lang: tpl.lang });
    });
    return this.readyPromise;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
  }

  respond(id, data) {
    this.worker?.postMessage({ type: 'response', id, data });
  }

  hasHandler(name) {
    return this.events.has(name);
  }

  /** Событие DOM для обработчика $20(...).on() */
  jqEvent(id, charId, info) {
    if (!this.worker || this.paused) return;
    this.worker.postMessage({ type: 'jq:event', id, charId, info });
  }

  /** Отправить события листа. events — массив имён (в нижнем регистре) */
  async dispatch(charId, events, info, row = null) {
    const ok = await this.start();
    if (!ok || !this.worker) return;
    const list = events.filter((e) => this.events.has(e));
    if (!list.length) return;
    // защита от бесконечных циклов в скриптах листа
    const now = performance.now();
    this.rate = this.rate.filter((t) => now - t < 3000);
    this.rate.push(now);
    if (this.rate.length > 3000) {
      if (!this.paused) {
        this.paused = true;
        console.warn('[sheetworker] слишком много событий — похоже на бесконечный цикл в листе, пауза 5 с');
        this.engine.hooks.notice?.('Скрипты листа зациклились — приостановлены на 5 секунд');
        setTimeout(() => {
          this.paused = false;
          this.rate = [];
        }, 5000);
      }
      return;
    }
    if (this.paused) return;
    this.worker.postMessage({ type: 'event', charId, events: list, info, row });
  }

  async onMessage(m) {
    const eng = this.engine;
    try {
      switch (m.type) {
        case 'getAttrs': {
          if (!m.charId) return this.respond(m.id, {});
          await eng.ensure(m.charId);
          this.respond(m.id, eng.getAttrsFor(m.charId, m.names, m.row));
          break;
        }
        case 'setAttrs': {
          if (!m.charId) {
            if (m.id) this.respond(m.id, null);
            break;
          }
          await eng.ensure(m.charId);
          eng.setAttrs(m.charId, m.values || {}, { source: 'sheetworker', silent: m.silent, rowCtx: m.row });
          if (m.id) this.respond(m.id, null);
          break;
        }
        case 'getSectionIDs': {
          if (!m.charId) return this.respond(m.id, []);
          await eng.ensure(m.charId);
          this.respond(m.id, eng.sectionIds(m.charId, m.section, { creationOrder: true }));
          break;
        }
        case 'removeRow':
          if (m.charId) {
            await eng.ensure(m.charId);
            eng.removeRepeatingRow(m.charId, m.row, 'sheetworker');
          }
          break;
        case 'setDefaultToken':
          if (m.charId) eng.setDefaultToken(m.charId, m.values);
          break;
        case 'startRoll': {
          const res = await eng.startRoll(m.charId, m.text, m.row);
          if (res) this.respond(m.id, res);
          break;
        }
        case 'finishRoll':
          eng.finishRoll(m.rollId, m.computed);
          break;
        case 'jq:on':
          eng.jqHandlers.push({ id: m.id, selector: String(m.selector || ''), events: new Set(m.events || []) });
          break;
        case 'jq:class':
          eng.emit('jq:class', m.charId || null, String(m.selector || ''), m.op, String(m.cls || ''));
          break;
        case 'notice':
          eng.hooks.notice?.(m.text);
          break;
        case 'error':
          this.errors++;
          console.warn(`[sheetworker] ошибка в скрипте листа (${m.where}): ${m.message}\n${m.stack}`);
          break;
      }
    } catch (e) {
      console.error('[sheetworker host]', e);
      if (m.id && m.type !== 'startRoll') this.respond(m.id, m.type === 'getSectionIDs' ? [] : {});
    }
  }
}
