// Приём соединений. Без TLS — обычный http-сервер. С TLS на одном порту работают и https://, и http://:
// по первому байту видно, что пришло (0x16 — начало TLS-рукопожатия). Так программа одним файлом
// даёт друзьям защищённый адрес для голосового чата, не открывая второй порт.
import net from 'node:net';
import tls from 'node:tls';

const HANDSHAKE_TIMEOUT = 30000;

/**
 * server — http.Server (приложение и Socket.IO); opts.tls — { context(): tls.SecureContext, plain?: 'serve' | 'redirect' }.
 * Возвращает слушающий сервер (сам http.Server или «распределитель» net.Server).
 */
export function listen(server, { port, host, tls: tlsOpt = null }) {
  const target = tlsOpt ? net.createServer((sock) => dispatch(server, sock, tlsOpt)) : server;
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    target.once('error', onError);
    target.listen(port, host, () => {
      target.off('error', onError);
      target.on('error', (e) => console.error('[net]', e.message));
      resolve(target);
    });
  });
}

function dispatch(server, sock, opt) {
  sock.on('error', () => sock.destroy());
  sock.setTimeout(HANDSHAKE_TIMEOUT, () => sock.destroy());
  sock.once('data', (buf) => {
    sock.setTimeout(0);
    sock.pause();
    sock.unshift(buf);
    if (buf[0] === 0x16) return secure(server, sock, opt);
    if (opt.plain === 'redirect') return redirectToHttps(sock, buf);
    server.emit('connection', sock);
    sock.resume();
  });
}

function secure(server, sock, opt) {
  let t;
  try {
    t = new tls.TLSSocket(sock, { isServer: true, secureContext: opt.context(), ALPNProtocols: ['http/1.1'] });
  } catch {
    sock.destroy();
    return;
  }
  const timer = setTimeout(() => t.destroy(), HANDSHAKE_TIMEOUT);
  t.on('error', () => t.destroy());
  t.once('close', () => clearTimeout(timer));
  // как https.Server: соединение отдаётся http-серверу после рукопожатия
  t.once('secure', () => {
    clearTimeout(timer);
    server.emit('connection', t);
  });
}

/** Обычный http на порт https — перенаправить на https:// (по заголовку Host из первого пакета) */
function redirectToHttps(sock, buf) {
  const head = buf.toString('latin1');
  const m = /^[A-Z]+ (\S+) HTTP\/1\.[01]\r\n/.exec(head);
  const host = /\r\nhost:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
  if (!m || !host || !/^[\w.\-:[\]]+$/.test(host) || !m[1].startsWith('/')) {
    sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const location = `https://${host}${m[1]}`;
  sock.end(`HTTP/1.1 301 Moved Permanently\r\nLocation: ${location}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
