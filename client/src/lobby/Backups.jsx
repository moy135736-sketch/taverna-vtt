// Администрирование → резервные копии: полная копия одним файлом, восстановление, автоматические копии базы
import { useState, useEffect, useRef } from 'preact/hooks';
import { api, ApiError } from '../api.js';
import { Button, toast, showError, confirmDialog } from '../ui/components.jsx';
import { Icon } from '../ui/icons.jsx';

export function fmtBytes(n) {
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' КБ';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' МБ';
  return (n / 1024 ** 3).toFixed(2) + ' ГБ';
}

const when = (t) => new Date(t).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 8 * 1048576;

/** Загрузить файл копии на сервер кусками; возвращает идентификатор загрузки */
async function uploadBackup(file, onProgress) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('');
  let offset = 0;
  let fails = 0;
  do {
    const end = Math.min(file.size, offset + CHUNK);
    let res;
    let data = null;
    try {
      res = await fetch('/api/admin/restore/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Taverna': '1', 'Content-Type': 'application/octet-stream', 'X-Upload-Id': id, 'X-Offset': String(offset), 'X-Total': String(file.size) },
        body: file.slice(offset, end),
      });
      data = await res.json().catch(() => null);
    } catch {
      res = null;
    }
    if (!res || (res.status >= 500 && res.status !== 507)) {
      // связь моргнула — повторяем тот же кусок
      if (++fails > 4) throw new ApiError('Связь с сервером прервалась при загрузке файла', 0);
      await sleep(1000 * fails);
      continue;
    }
    if (res.status === 409 && typeof data?.size === 'number') {
      offset = data.size;
      continue;
    }
    if (!res.ok) throw new ApiError(data?.error || `Ошибка загрузки (${res.status})`, res.status);
    fails = 0;
    offset = data.size;
    onProgress(file.size ? offset / file.size : 1);
  } while (offset < file.size);
  return id;
}

/** Ждать окончания восстановления на сервере; onState — для индикатора */
async function waitJob(id, onState) {
  let last = null;
  for (;;) {
    await sleep(700);
    let j;
    try {
      j = (await api.get('/api/admin/restore/status')).job;
    } catch (e) {
      // после подмены базы прежний вход может исчезнуть — значит, данные уже на месте
      if (e.status === 401 || e.status === 403) {
        if (last?.phase === 'swap') return { state: 'done', relogin: true };
        throw e;
      }
      continue; // 503 — сервер занят подменой данных
    }
    if (j.id !== id) continue;
    last = j;
    onState(j);
    if (j.state === 'done' || j.state === 'error') return j;
  }
}

const PHASE = { check: 'Проверяю копию…', extract: 'Распаковываю', swap: 'Подменяю данные, игроки ненадолго отключены…', done: 'Готово' };

export function Backups() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState(null);
  const fileRef = useRef();
  const load = () =>
    api
      .get('/api/admin/backups')
      .then(setData)
      .catch(showError);
  useEffect(() => {
    load();
  }, []);

  const make = async () => {
    setBusy(true);
    try {
      await api.post('/api/admin/backups', {});
      toast('Копия базы готова', 'ok');
      load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  /** Общая часть: запустить восстановление на сервере и довести до конца */
  const run = async (title, start) => {
    setTask({ title, text: 'Начинаю…', progress: null });
    try {
      const { job } = await start();
      const j = await waitJob(job.id, (s) =>
        setTask({ title, text: s.phase === 'extract' ? `${PHASE.extract}: ${s.done} из ${s.total} файлов` : PHASE[s.phase] || '', progress: s.phase === 'extract' && s.total ? s.done / s.total : null }),
      );
      if (j.state === 'error') throw new ApiError(j.error, 0);
      setTask({ title, text: 'Готово. Сейчас страница обновится…', progress: 1, ok: true });
      const r = j.result;
      toast(r ? `Готово: аккаунтов ${r.users}, столов ${r.games}${r.files !== undefined ? `, файлов ${r.files}` : ''}` : 'Готово', 'ok', 6000);
      setTimeout(() => location.assign('/'), j.relogin ? 1200 : 2000);
    } catch (e) {
      setTask(null);
      showError(e);
      load();
    }
  };

  const pickFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const ok = await confirmDialog({
      title: 'Восстановить из копии?',
      text: `Всё на сервере заменится содержимым файла «${file.name}» (${fmtBytes(file.size)}): аккаунты, столы, персонажи, листы, картинки и музыка. Игроки будут отключены на минуту.\n\nТекущие данные не пропадут: их можно будет вернуть здесь же, в разделе «Как было до восстановления».`,
      okText: 'Восстановить',
      danger: true,
    });
    if (!ok) return;
    const title = 'Восстановление из файла';
    setTask({ title, text: 'Загружаю файл: 0%', progress: 0 });
    let id;
    try {
      id = await uploadBackup(file, (p) => setTask({ title, text: `Загружаю файл: ${Math.floor(p * 100)}%`, progress: p }));
    } catch (err) {
      setTask(null);
      return showError(err);
    }
    run(title, () => api.post('/api/admin/restore/start', { uploadId: id }));
  };

  const restoreBackup = async (b) => {
    const ok = await confirmDialog({
      title: 'Вернуть базу к этой копии?',
      text: `Столы, персонажи, аккаунты и чат вернутся к состоянию на ${when(b.time)}. Картинки и музыка не меняются. Игроки будут отключены на минуту.\n\nТекущая база сохранится — её можно будет вернуть.`,
      okText: 'Вернуть',
      danger: true,
    });
    if (ok) run('Возврат базы', () => api.post(`/api/admin/backups/${encodeURIComponent(b.name)}/restore`, {}));
  };

  const restorePoint = async (p) => {
    const ok = await confirmDialog({
      title: 'Вернуть прежнее состояние?',
      text: `Данные станут такими, какими были ${when(p.time)}${p.reason ? ` (${p.reason})` : ''}${p.uploads ? ', вместе с картинками и музыкой' : ''}. Текущее состояние тоже сохранится.`,
      okText: 'Вернуть',
      danger: true,
    });
    if (ok) run('Возврат к прежнему состоянию', () => api.post(`/api/admin/restore-points/${encodeURIComponent(p.name)}/restore`, {}));
  };

  return (
    <section class="admin-backups">
      <h3 class="sect-h">Резервные копии</h3>
      <p class="muted small">
        Полная копия — один ZIP-файл: аккаунты, столы, персонажи, листы, чат, картинки, музыка и видео. Храните его где удобно; восстановить можно здесь же — на этом или на другом компьютере и сервере.
      </p>
      <div class="backup-actions">
        <a class="btn btn-primary btn-sm" href="/api/admin/backup/full" download onClick={() => toast('Собираю копию — скачивание начнётся через несколько секунд')}>
          <Icon name="download" size={15} />
          <span>Скачать полную копию</span>
        </a>
        <Button size="sm" icon="upload" onClick={() => fileRef.current?.click()} disabled={!!task}>
          Восстановить из файла…
        </Button>
        <input type="file" accept=".zip,application/zip" hidden ref={fileRef} onChange={pickFile} />
      </div>
      {task && (
        <div class={'restore-task' + (task.ok ? ' ok' : '')} role="status" aria-live="polite">
          <div class="restore-title">{task.title}</div>
          <div class="restore-bar" aria-hidden="true">
            <span style={{ width: task.progress === null ? '100%' : `${Math.round(task.progress * 100)}%` }} class={task.progress === null ? 'indeterminate' : ''} />
          </div>
          <div class="small muted">{task.text}</div>
        </div>
      )}

      <div class="backup-sub">
        <h4 class="sub-h">Автоматические копии базы</h4>
        <Button size="sm" onClick={make} disabled={busy || !!task}>
          {busy ? 'Копирую…' : 'Сделать копию сейчас'}
        </Button>
      </div>
      {data && (
        <p class="muted small">
          {data.intervalHours > 0 ? `Раз в ${data.intervalHours} ч, хранятся последние ${data.keep}.` : 'Автоматические копии выключены (BACKUP_INTERVAL_HOURS=0).'} Только база, без картинок и музыки — чтобы вернуть столы и персонажей к прошлому дню.
        </p>
      )}
      {data && !data.backups.length && <p class="muted small">Копий пока нет.</p>}
      {data && data.backups.length > 0 && (
        <ul class="backup-list">
          {data.backups.slice(0, 8).map((b) => (
            <li key={b.name}>
              <a href={'/api/admin/backups/' + encodeURIComponent(b.name)} download={b.name} title="Скачать файл базы">
                {when(b.time)}
              </a>
              <span class="faint small">{fmtBytes(b.size)}</span>
              <button type="button" class="linklike small" onClick={() => restoreBackup(b)} disabled={!!task}>
                вернуть
              </button>
            </li>
          ))}
        </ul>
      )}

      {data?.restorePoints?.length > 0 && (
        <>
          <h4 class="sub-h">Как было до восстановления</h4>
          <p class="muted small">Перед каждым восстановлением Таверна откладывает прежние данные. Если вернули не то — верните их.</p>
          <ul class="backup-list">
            {data.restorePoints.map((p) => (
              <li key={p.name}>
                <span>{when(p.time)}</span>
                <span class="faint small">{p.reason}</span>
                <button type="button" class="linklike small" onClick={() => restorePoint(p)} disabled={!!task}>
                  вернуть
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
