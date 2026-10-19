// Сертификаты Let's Encrypt по протоколу ACME (RFC 8555) без сторонних библиотек.
// Проверка владения доменом — http-01: сервер на порту 80 отдаёт ключ по адресу
// /.well-known/acme-challenge/<token>. Ключи — ECDSA P-256, подпись запросов — ES256.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { csr, newKey, certExpiry, selfSigned } from './x509.js';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const h = { 'User-Agent': 'taverna-vtt (acme)', ...headers };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = mod.request(u, { method, headers: h, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (/json/.test(res.headers['content-type'] || '')) {
          try {
            json = JSON.parse(text);
          } catch {
            /* не JSON */
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('нет ответа от ' + u.host)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export class AcmeError extends Error {
  constructor(message, problem) {
    super(message);
    this.problem = problem;
  }
}

function problemText(p) {
  if (!p) return '';
  const sub = (p.subproblems || []).map((s) => s.detail).filter(Boolean);
  return [p.detail || p.type, ...sub].join('; ');
}

export class AcmeClient {
  /** accountKey — KeyObject (ECDSA P-256) */
  constructor({ directory = LETS_ENCRYPT, accountKey, email = '' }) {
    this.directoryUrl = directory;
    this.accountKey = accountKey;
    this.email = email;
    this.kid = null;
    this.nonceValue = null;
  }

  jwk() {
    const { crv, kty, x, y } = this.accountKey.export({ format: 'jwk' });
    return { crv, kty, x, y };
  }

  thumbprint() {
    const { crv, kty, x, y } = this.jwk();
    // RFC 7638: обязательные поля в алфавитном порядке
    return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
  }

  async directory() {
    if (!this.dir) {
      const r = await request(this.directoryUrl);
      if (r.status !== 200 || !r.json?.newOrder) throw new AcmeError(`каталог ACME недоступен (${r.status})`);
      this.dir = r.json;
    }
    return this.dir;
  }

  async nonce() {
    if (this.nonceValue) {
      const n = this.nonceValue;
      this.nonceValue = null;
      return n;
    }
    const r = await request((await this.directory()).newNonce, { method: 'HEAD' });
    const n = r.headers['replay-nonce'];
    if (!n) throw new AcmeError('сервер ACME не выдал nonce');
    return n;
  }

  /** Подписанный POST; payload === null — POST-as-GET */
  async post(url, payload, { jwk = false, retries = 3 } = {}) {
    const head = { alg: 'ES256', nonce: await this.nonce(), url };
    if (jwk) head.jwk = this.jwk();
    else head.kid = this.kid;
    const p = b64u(JSON.stringify(head));
    const pl = payload === null ? '' : b64u(JSON.stringify(payload));
    const sig = crypto.sign('sha256', Buffer.from(`${p}.${pl}`), { key: this.accountKey, dsaEncoding: 'ieee-p1363' });
    const r = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json' },
      body: JSON.stringify({ protected: p, payload: pl, signature: b64u(sig) }),
    });
    if (r.headers['replay-nonce']) this.nonceValue = r.headers['replay-nonce'];
    if (r.status >= 400) {
      const type = r.json?.type || '';
      if (retries > 0 && type.endsWith(':badNonce')) return this.post(url, payload, { jwk, retries: retries - 1 });
      if (retries > 0 && (r.status === 503 || r.status === 429) && Number(r.headers['retry-after']) <= 20) {
        await sleep(Number(r.headers['retry-after']) * 1000);
        return this.post(url, payload, { jwk, retries: retries - 1 });
      }
      throw new AcmeError(problemText(r.json) || `ошибка ${r.status}`, r.json);
    }
    return r;
  }

  async account() {
    if (this.kid) return this.kid;
    const dir = await this.directory();
    const payload = { termsOfServiceAgreed: true };
    if (this.email) payload.contact = ['mailto:' + this.email];
    const r = await this.post(dir.newAccount, payload, { jwk: true });
    this.kid = r.headers.location;
    if (!this.kid) throw new AcmeError('сервер ACME не вернул адрес учётной записи');
    return this.kid;
  }

  async poll(url, isDone, what, timeoutMs = 180000) {
    const start = Date.now();
    for (;;) {
      const r = await this.post(url, null);
      if (isDone(r.json)) return r.json;
      if (Date.now() - start > timeoutMs) throw new AcmeError(`${what}: нет результата за ${Math.round(timeoutMs / 1000)} с`);
      const ra = Number(r.headers['retry-after']);
      await sleep((ra > 0 && ra <= 30 ? ra : 2) * 1000);
    }
  }

  /**
   * Получить сертификат. challenges — Map, куда кладётся token → keyAuthorization на время проверки
   * (её читает http-сервер на порту 80). Возвращает { key, cert } в PEM.
   */
  async obtain(domains, challenges, log = () => {}) {
    const dir = await this.directory();
    await this.account();
    const created = await this.post(dir.newOrder, { identifiers: domains.map((value) => ({ type: 'dns', value })) });
    const orderUrl = created.headers.location;
    let order = created.json;
    for (const authzUrl of order.authorizations) {
      const authz = (await this.post(authzUrl, null)).json;
      if (authz.status === 'valid') continue;
      const ch = authz.challenges.find((c) => c.type === 'http-01');
      if (!ch) throw new AcmeError('сервер ACME не предлагает проверку http-01');
      challenges.set(ch.token, `${ch.token}.${this.thumbprint()}`);
      try {
        log(`проверка домена ${authz.identifier?.value}…`);
        await this.post(ch.url, {});
        const res = await this.poll(authzUrl, (j) => j.status !== 'pending' && j.status !== 'processing', 'проверка домена');
        if (res.status !== 'valid') {
          const failed = res.challenges?.find((c) => c.type === 'http-01');
          throw new AcmeError(`домен ${res.identifier?.value} не подтверждён: ${problemText(failed?.error) || res.status}`, failed?.error);
        }
      } finally {
        challenges.delete(ch.token);
      }
    }
    const key = newKey();
    order = (await this.post(order.finalize, { csr: b64u(csr(domains, key)) })).json;
    if (order.status !== 'valid') order = await this.poll(orderUrl, (j) => j.status === 'valid' || j.status === 'invalid', 'выпуск сертификата');
    if (order.status !== 'valid') throw new AcmeError('сертификат не выпущен: ' + (problemText(order.error) || order.status), order.error);
    const certRes = await this.post(order.certificate, null);
    if (!/BEGIN CERTIFICATE/.test(certRes.text)) throw new AcmeError('сервер ACME вернул не сертификат');
    return { key: key.export({ type: 'pkcs8', format: 'pem' }), cert: certRes.text };
  }
}

/**
 * Сертификаты сервера: при запуске — сохранённый Let's Encrypt или временный самоподписанный,
 * затем получение и продление (за 30 дней до конца). context() всегда отдаёт действующий.
 */
export class CertManager {
  constructor({ dir, domains, email = '', directory = LETS_ENCRYPT, log = console.log }) {
    this.dir = dir;
    this.domains = domains;
    this.email = email;
    this.directory = directory;
    this.log = log;
    this.challenges = new Map();
    this.status = { state: 'starting', message: '', expires: null, updated: Date.now() };
    fs.mkdirSync(dir, { recursive: true });
    const base = domains[0].replace(/[^\w.-]/g, '_');
    this.keyFile = path.join(dir, base + '.key');
    this.certFile = path.join(dir, base + '.crt');
    this.load();
  }

  load() {
    try {
      const key = fs.readFileSync(this.keyFile, 'utf8');
      const cert = fs.readFileSync(this.certFile, 'utf8');
      const exp = certExpiry(cert);
      if (exp && exp > new Date()) {
        this.ctx = tls.createSecureContext({ key, cert });
        this.expires = exp;
        this.setStatus('ok', 'сертификат Let’s Encrypt', exp);
        return;
      }
    } catch {
      /* ещё нет сертификата */
    }
    // до получения настоящего — временный самоподписанный, чтобы сервер уже отвечал
    this.ctx = tls.createSecureContext(selfSigned({ dnsNames: this.domains, ips: [] }));
    this.expires = null;
  }

  context() {
    return this.ctx;
  }

  setStatus(state, message, expires = this.expires) {
    this.status = { state, message, expires: expires ? expires.toISOString() : null, updated: Date.now(), domains: this.domains };
    try {
      fs.writeFileSync(path.join(this.dir, 'status.json'), JSON.stringify(this.status, null, 2));
    } catch {
      /* не страшно */
    }
  }

  accountKey() {
    const f = path.join(this.dir, 'acme-account.key');
    try {
      return crypto.createPrivateKey(fs.readFileSync(f, 'utf8'));
    } catch {
      const k = newKey();
      fs.writeFileSync(f, k.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      return k;
    }
  }

  needsRenewal() {
    return !this.expires || this.expires.getTime() - Date.now() < 30 * 86400000;
  }

  async renew() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.setStatus('pending', 'получаю сертификат Let’s Encrypt…');
      try {
        const client = new AcmeClient({ directory: this.directory, accountKey: this.accountKey(), email: this.email });
        const { key, cert } = await client.obtain(this.domains, this.challenges, (m) => this.log('[https] ' + m));
        fs.writeFileSync(this.keyFile, key, { mode: 0o600 });
        fs.writeFileSync(this.certFile, cert);
        this.ctx = tls.createSecureContext({ key, cert });
        this.expires = certExpiry(cert);
        this.setStatus('ok', 'сертификат Let’s Encrypt', this.expires);
        this.log(`[https] сертификат для ${this.domains.join(', ')} получен, действует до ${this.expires.toISOString().slice(0, 10)}`);
        return true;
      } catch (e) {
        this.setStatus('error', e.message);
        this.log(`[https] не удалось получить сертификат: ${e.message}`);
        this.log('[https] проверьте, что домен указывает на IP этого сервера и порт 80 открыт; следующая попытка через час');
        return false;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  /** Получить сертификат сейчас (если нужно) и проверять дважды в сутки; после ошибки — через час */
  start() {
    const tick = async () => {
      let ok = true;
      if (this.needsRenewal()) ok = await this.renew();
      clearTimeout(this.timer);
      this.timer = setTimeout(tick, ok ? 12 * 3600000 : 3600000);
      this.timer.unref?.();
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** Обработчик запросов порта 80: ответ на проверку ACME, остальное — на https:// */
  httpHandler(httpsPort = 443) {
    return (req, res) => {
      const m = /^\/\.well-known\/acme-challenge\/([\w-]+)$/.exec(req.url.split('?')[0]);
      if (m) {
        const v = this.challenges.get(m[1]);
        res.writeHead(v ? 200 : 404, { 'Content-Type': 'text/plain' });
        return res.end(v || 'not found');
      }
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, app: 'taverna', https: this.status }));
      }
      const host = String(req.headers.host || '')
        .replace(/:\d+$/, '')
        .toLowerCase();
      const target = `https://${this.domains.includes(host) ? host : this.domains[0]}${httpsPort === 443 ? '' : ':' + httpsPort}${req.url}`;
      res.writeHead(301, { Location: target, 'Content-Type': 'text/plain' });
      res.end('https');
    };
  }
}
