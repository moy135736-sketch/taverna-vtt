// Подготовка файлов к загрузке: сжатие (если включено в главном меню) с ходом работы в уведомлении
import { compressEnabled, compressFiles, compressFile, sizeChange } from './compress.js';
import { progressToast, toast } from '../ui/components.jsx';

/** Вернуть файлы для загрузки: сжатые или как есть. Долгое сжатие можно прервать кнопкой в уведомлении. */
export async function prepareUploads(files, user) {
  const list = [...files];
  if (!list.length || !compressEnabled(user)) return list;
  const ctl = new AbortController();
  let pt = null;
  let last = 'Сжимаем файлы…';
  // короткое сжатие (картинка) проходит без лишнего уведомления
  const t0 = Date.now();
  const timer = setTimeout(() => {
    pt = progressToast(last, { label: 'Загрузить без сжатия', onClick: () => ctl.abort() });
  }, 700);
  try {
    const r = await compressFiles(list, {
      signal: ctl.signal,
      onStatus: ({ file, index, total, progress }) => {
        last = `Сжимаем «${file.name}»${total > 1 ? ` (${index + 1} из ${total})` : ''}: ${Math.round(progress * 100)}%`;
        pt?.update(last);
      },
    });
    if (r.changed) toast(`Сжато ${r.changed === 1 ? '' : r.changed + ' файл(ов) '}перед загрузкой: ${sizeChange(r.before, r.after)}`, 'ok', 5000);
    // долго ждали, а выигрыша нет — скажем, что ушёл оригинал
    else if (!ctl.signal.aborted && Date.now() - t0 > 2000) toast('Сжатый файл вышел не легче оригинала — загружаем оригинал', 'info', 5000);
    return r.files;
  } finally {
    clearTimeout(timer);
    pt?.done();
  }
}

// для проверок из консоли и e2e-тестов: window.__media.compressFile(file)
if (typeof window !== 'undefined') window.__media = { compressFile, compressFiles };
