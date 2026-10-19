import { createContext } from 'preact';
import { useState, useEffect, useContext, useReducer } from 'preact/hooks';

export const AppCtx = createContext(null);

export function useApp() {
  return useContext(AppCtx);
}

/** Перерисовывать компонент при событиях хранилища */
export function useStoreEvents(store, events, filter) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const offs = events.map((ev) =>
      store.on(ev, (...args) => {
        if (!filter || filter(ev, ...args)) force();
      }),
    );
    return () => offs.forEach((o) => o());
  }, [store, events.join('|')]);
}

export function useEmitter(emitter, ev, fn, deps = []) {
  useEffect(() => emitter.on(ev, fn), [emitter, ev, ...deps]);
}

// Все компоненты с одним ключом видят одно значение (например, панель макросов и её редактор)
const lsCache = new Map();
const lsListeners = new Map();

function lsRead(key, initial) {
  if (lsCache.has(key)) return lsCache.get(key);
  let val = initial;
  try {
    const s = localStorage.getItem(key);
    if (s !== null) val = JSON.parse(s);
  } catch {
    /* хранилище недоступно */
  }
  lsCache.set(key, val);
  return val;
}

export function useLocalStorage(key, initial) {
  const [v, setV] = useState(() => lsRead(key, initial));
  useEffect(() => {
    let set = lsListeners.get(key);
    if (!set) lsListeners.set(key, (set = new Set()));
    set.add(setV);
    setV(lsRead(key, initial));
    return () => set.delete(setV);
  }, [key]);
  const set = (nv) => {
    const prev = lsRead(key, initial);
    const val = typeof nv === 'function' ? nv(prev) : nv;
    lsCache.set(key, val);
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* хранилище недоступно */
    }
    for (const fn of lsListeners.get(key) || []) fn(val);
  };
  return [v, set];
}
