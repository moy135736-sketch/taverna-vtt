// Ссылка-приглашение: со «своего» localhost друзьям не попасть — подставляем адрес компьютера в сети
import { api } from '../api.js';
import { toast } from './components.jsx';

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** Адрес, по которому стол откроют другие: публичный адрес сервера или адрес компьютера в сети */
export async function shareOrigin() {
  if (!LOCAL.test(location.hostname)) return location.origin;
  try {
    const d = await api.get('/api/lan');
    if (d.publicUrl) return d.publicUrl;
    const a = d.addresses?.[0]?.address;
    if (a) return `http://${a}${d.port === 80 ? '' : ':' + d.port}`;
  } catch {
    /* останется localhost */
  }
  return location.origin;
}

/** Скопировать ссылку-приглашение за стол с кодом code */
export async function copyInvite(code, okText = 'Ссылка-приглашение скопирована — отправьте её игрокам') {
  if (!code) return;
  const origin = await shareOrigin();
  const url = `${origin}/join/${code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(origin === location.origin ? okText : `${okText}: ${url}`, 'ok', 6000);
  } catch {
    toast(`Ссылка-приглашение: ${url}`, 'info', 12000);
  }
}
