// HTTP-клиент для REST API сервера

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body, opts = {}) {
  const headers = { 'X-Taverna': '1' };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', ...opts });
  } catch {
    throw new ApiError('Нет связи с сервером', 0);
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `Ошибка сервера (${res.status})`, res.status);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url, body) => request('DELETE', url, body),
};

/** Загрузка файлов с прогрессом */
export function uploadFiles(files, { gameId, folder, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    if (gameId) fd.append('gameId', gameId);
    if (folder) fd.append('folder', folder);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/assets');
    xhr.setRequestHeader('X-Taverna', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data?.error || `Ошибка загрузки (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Нет связи с сервером', 0));
    xhr.send(fd);
  });
}
