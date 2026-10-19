// Минимальная работа с X.509 без сторонних библиотек: самоподписанный сертификат (для https в локальной
// сети) и запрос на сертификат (CSR) для Let's Encrypt. Ключи — ECDSA P-256 из node:crypto.
import crypto from 'node:crypto';
import net from 'node:net';

// ---- DER ----
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, content) => tlv(0xa0 | n, content);
const octets = (buf) => tlv(0x04, buf);
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const enc = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      enc.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d) {
  // UTCTime до 2050 года, дальше — GeneralizedTime (RFC 5280)
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  if (d.getUTCFullYear() < 2050) return tlv(0x17, Buffer.from(iso.slice(2) + 'Z', 'ascii'));
  return tlv(0x18, Buffer.from(iso + 'Z', 'ascii'));
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  extensionRequest: '1.2.840.113549.1.9.14',
};

const name = (cn, org) => seq(...(org ? [set(seq(oid(OID.organization), utf8(org)))] : []), set(seq(oid(OID.commonName), utf8(cn))));
const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (net.isIPv6(ip)) {
    // развернуть «::»
    const [head, tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    return Buffer.concat(groups.map((g) => Buffer.from(g.padStart(4, '0'), 'hex')));
  }
  return null;
}

function altNames(dnsNames = [], ips = []) {
  const items = [];
  for (const d of dnsNames) items.push(tlv(0x82, Buffer.from(d, 'ascii')));
  for (const ip of ips) {
    const b = ipBytes(ip);
    if (b) items.push(tlv(0x87, b));
  }
  return seq(...items);
}

const toPem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END ${label}-----\n`;
export const fromPem = (pem) => Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

export function newKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

/** Самоподписанный сертификат для https в локальной сети: { key, cert } в PEM */
export function selfSigned({ commonName = 'Taverna', dnsNames = ['localhost'], ips = ['127.0.0.1'], days = 397, key = newKey() } = {}) {
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const sigAlg = seq(oid(OID.ecdsaSha256));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(15)])),
    sigAlg,
    name(commonName, 'Taverna VTT'),
    seq(time(new Date(now - 3600000)), time(new Date(now + days * 86400000))),
    name(commonName, 'Taverna VTT'),
    pub,
    explicit(
      3,
      seq(
        ext(OID.basicConstraints, seq(), true),
        ext(OID.keyUsage, Buffer.from([0x03, 0x02, 0x07, 0x80]), true), // digitalSignature
        ext(OID.extKeyUsage, seq(oid(OID.serverAuth))),
        ext(OID.subjectAltName, altNames(dnsNames, ips)),
      ),
    ),
  );
  const sig = crypto.sign('sha256', tbs, key);
  const cert = seq(tbs, sigAlg, bits(sig));
  return { key: key.export({ type: 'pkcs8', format: 'pem' }), cert: toPem('CERTIFICATE', cert) };
}

/** Запрос на сертификат (PKCS#10, DER) для доменов; первый — в CN */
export function csr(domains, key) {
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const info = seq(
    integer(Buffer.from([0])),
    seq(set(seq(oid(OID.commonName), utf8(domains[0])))),
    pub,
    // [0] IMPLICIT SET OF Attribute: extensionRequest с subjectAltName
    tlv(0xa0, seq(oid(OID.extensionRequest), set(seq(ext(OID.subjectAltName, altNames(domains)))))),
  );
  const sig = crypto.sign('sha256', info, key);
  return seq(info, seq(oid(OID.ecdsaSha256)), bits(sig));
}

/** Срок действия сертификата (Date) или null */
export function certExpiry(pem) {
  try {
    return new Date(new crypto.X509Certificate(pem).validTo);
  } catch {
    return null;
  }
}

/** Адреса, на которые выписан сертификат: { dns: [], ips: [] } */
export function certNames(pem) {
  try {
    const san = new crypto.X509Certificate(pem).subjectAltName || '';
    const dns = [];
    const ips = [];
    for (const part of san.split(/,\s*/)) {
      const [k, v] = part.split(':');
      if (k === 'DNS') dns.push(v);
      else if (k === 'IP Address') ips.push(part.slice(part.indexOf(':') + 1));
    }
    return { dns, ips };
  } catch {
    return { dns: [], ips: [] };
  }
}
