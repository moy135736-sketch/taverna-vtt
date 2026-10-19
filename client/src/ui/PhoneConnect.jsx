// «Подключить телефон»: адрес компьютера в сети и QR-код — стол открывается в браузере телефона
import { useState, useEffect, useMemo } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { api } from '../api.js';
import { Modal, Button, Spinner, toast } from './components.jsx';

const isLocalName = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/** QR-код ссылки (тёмные клетки на светлом поле — так его читает любая камера) */
export function QrCode({ text, size = 176, label }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${svg.n} ${svg.n}`} width={size} height={size} role="img" aria-label={label || 'QR-код: ' + text} shape-rendering="crispEdges">
      <rect width={svg.n} height={svg.n} fill="#fff" />
      <path d={svg.d} fill="#17130f" />
    </svg>
  );
}

/** Адрес, по которому стол откроется с телефона: публичный адрес сервера или адрес компьютера в сети */
function phoneBase(info, ip) {
  if (info.publicUrl) return info.publicUrl;
  if (!isLocalName(location.hostname)) return location.origin;
  if (!ip) return null;
  return `http://${ip}${info.port === 80 ? '' : ':' + info.port}`;
}

/** joinCode — код стола: ссылка из QR сразу посадит игрока за этот стол */
export function PhoneConnect({ onClose, joinCode = '' }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [ip, setIp] = useState('');
  useEffect(() => {
    api
      .get('/api/lan')
      .then((d) => {
        setInfo(d);
        setIp(d.addresses?.[0]?.address || '');
      })
      .catch((e) => setErr(e.message));
  }, []);
  const base = info ? phoneBase(info, ip) : null;
  const site = base ? base + (joinCode ? `/join/${joinCode}` : '/') : '';
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Адрес скопирован', 'ok'));

  return (
    <Modal title="Подключить телефон" onClose={onClose} width={560} class="phone-connect">
      {!info && !err && <Spinner label="Узнаём адрес компьютера в сети…" />}
      {err && <p class="err">{err}</p>}
      {info && !base && (
        <p class="dlg-text">
          Не нашлось адреса этого компьютера в локальной сети. Подключите компьютер к Wi-Fi или кабелем к роутеру и откройте это окно снова. Если стол открыт для интернета, укажите его адрес в настройках сервера (PUBLIC_URL).
        </p>
      )}
      {base && (
        <>
          {!info.publicUrl && <p class="pc-lead">Телефон должен быть в той же сети Wi-Fi, что и этот компьютер.</p>}
          {info.addresses?.length > 1 && !info.publicUrl && isLocalName(location.hostname) && (
            <label class="pc-net">
              <span>Сеть</span>
              <select class="input input-sm" value={ip} onChange={(e) => setIp(e.currentTarget.value)} aria-label="Сеть, в которой телефон">
                {info.addresses.map((a) => (
                  <option value={a.address}>
                    {a.address} — {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <section class="pc-way" aria-labelledby="pc-web">
            <QrCode text={site} label={'QR-код: ' + site} />
            <div class="pc-text">
              <h3 id="pc-web">В браузере телефона</h3>
              <p>{joinCode ? 'Наведите камеру телефона на код — откроется этот стол: войдите или зарегистрируйтесь, и вы за столом.' : 'Наведите камеру телефона на код или наберите адрес в браузере:'}</p>
              <div class="pc-addr">
                <code>{base.replace(/^https?:\/\//, '')}</code>
                <Button size="sm" kind="ghost" icon="copy" onClick={() => copy(site)}>
                  Копировать
                </Button>
              </div>
              {info.https && !info.publicUrl && <p class="small muted">Голосовой чат в браузере работает по https:// — браузер предупредит о сертификате, это нормально для домашнего сервера.</p>}
            </div>
          </section>
          {!info.publicUrl && <p class="small muted pc-foot">Не открывается? Проверьте, что Windows разрешила Таверне доступ к сети, и что телефон не в гостевой сети Wi-Fi.</p>}
        </>
      )}
    </Modal>
  );
}
