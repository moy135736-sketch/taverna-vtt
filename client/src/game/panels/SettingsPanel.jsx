import { useState, useEffect } from 'preact/hooks';
import { exportChatLog } from '../chat/exportLog.js';
import { diceSetting, setDiceMode } from '../diceAnim.js';
import { teapot, setTeapot, onTeapot, TEAPOT_ON, TEAPOT_OFF, TEAPOT_HINT } from '../../ui/teapot.js';
import { useApp, useStoreEvents } from '../hooks.js';
import { Toggle, Button, IconButton, Field, confirmDialog, toast, showModal } from '../../ui/components.jsx';
import { PhoneConnect } from '../../ui/PhoneConnect.jsx';
import { copyInvite } from '../../ui/invite.js';
import { markerDefs, markerLook, describeEffect } from '../effects.js';
import { MOVE_STYLES } from '@shared/defaults.js';
import { MarkerLookView } from '../windows/MarkerEditor.jsx';
import { THEMES, detectTheme, userTheme, setUserTheme, themeMotion, setThemeMotion } from '../../themes/themes.js';
import { compressEnabled } from '../../media/compress.js';
import { DiceStyle } from './DiceStyle.jsx';

const LANGS = { ru: 'Русский', en: 'English', uk: 'Українська', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', pl: 'Polski', pt: 'Português', ja: '日本語', ko: '한국어', zh: '中文' };

export function SettingsPanel() {
  const app = useApp();
  const { store, net, sheets } = app;
  useStoreEvents(store, ['game', 'members', 'ui:viewAsPlayer']);
  const s = store.settings;
  const gm = store.isGM;
  const set = (patch) => net.request('settings', patch).then((r) => r?.error && toast(r.error, 'error'));
  const [dice, setDice] = useState(diceSetting());
  const [ownTheme, setOwnTheme] = useState(userTheme());
  const [motion, setMotion] = useState(themeMotion());
  const [pot, setPot] = useState(teapot);
  useEffect(
    () =>
      onTeapot((v) => {
        setPot(v);
        setMotion(themeMotion());
      }),
    [],
  );
  const togglePot = (v) => {
    setTeapot(v);
    setPot(v);
    setMotion(themeMotion());
    toast(v ? TEAPOT_ON : TEAPOT_OFF, 'ok', 7000);
  };
  const tpl = sheets.template;
  const userOptions = Array.isArray(tpl?.meta?.useroptions) ? tpl.meta.useroptions : [];
  // ссылка-приглашение: со «своего» localhost друзьям не попасть — подставляется адрес компьютера в сети
  const invite = () => copyInvite(store.game.inviteCode, 'Ссылка скопирована');

  return (
    <div class="panel settings-panel">
      <div class="panel-scroll">
        {gm && (
          <>
            <h3 class="j-h">Приглашение</h3>
            <p class="small muted">
              Код стола: <b class="code-pill">{store.game.inviteCode}</b>{' '}
              <button type="button" class="link-btn" onClick={() => navigator.clipboard?.writeText(store.game.inviteCode).then(() => toast('Код скопирован', 'ok'))}>
                копировать
              </button>
            </p>
            <p class="small muted">
              Или ссылкой — игрок откроет её, войдёт и сразу окажется за столом:{' '}
              <button type="button" class="link-btn" onClick={invite}>
                копировать ссылку
              </button>
            </p>
            <Button size="sm" icon="phone" onClick={() => showModal((close) => <PhoneConnect onClose={close} joinCode={store.game.inviteCode} />)}>
              С телефона…
            </Button>

            <h3 class="j-h">Мастер</h3>
            <div class="set-list">
              <Field label="Туман и свет" inline hint="Как видят стол игроки: все вместе или каждый сам — у каждого обзор только его токенов.">
                <select
                  class="input input-sm"
                  value={store.ui.gmViewAsPlayer === true ? '*' : store.ui.gmViewAsPlayer || ''}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    store.ui.gmViewAsPlayer = v === '*' ? true : v || false;
                    store.emit('ui:viewAsPlayer');
                  }}
                >
                  <option value="">Как мастер — видно всё</option>
                  <option value="*">Глазами всех игроков</option>
                  {[...store.members.values()]
                    .filter((m) => m.role !== 'gm')
                    .map((m) => (
                      <option value={m.id}>Глазами: {m.displayName}</option>
                    ))}
                </select>
              </Field>
              <PlayerPages />
            </div>

            <h3 class="j-h">Игроки могут</h3>
            <div class="set-list">
              <Toggle checked={s.playersCanDraw} onChange={(v) => set({ playersCanDraw: v })} label="Рисовать на карте" />
              <Toggle checked={s.playersCanCreateCharacters} onChange={(v) => set({ playersCanCreateCharacters: v })} label="Создавать персонажей" />
              <Toggle checked={s.playersCanUseFx} onChange={(v) => set({ playersCanUseFx: v })} label="Запускать спецэффекты" />
              <Toggle checked={s.shareRuler} onChange={(v) => set({ shareRuler: v })} label="Показывать линейку всем" />
            </div>

            <h3 class="j-h">Бары токенов</h3>
            <Field label="Положение" inline>
              <select class="input input-sm" value={s.barPosition} onChange={(e) => set({ barPosition: e.currentTarget.value })}>
                <option value="above">Над токеном</option>
                <option value="top">Сверху на токене</option>
                <option value="bottom">Снизу на токене</option>
                <option value="below">Под токеном</option>
              </select>
            </Field>
            <Field label="Размер" inline>
              <select class="input input-sm" value={s.barStyle} onChange={(e) => set({ barStyle: e.currentTarget.value })}>
                <option value="standard">Обычные</option>
                <option value="compact">Тонкие</option>
              </select>
            </Field>
            <Field label="Числа на барах" inline>
              <select class="input input-sm" value={s.showBarText} onChange={(e) => set({ showBarText: e.currentTarget.value })}>
                <option value="never">Не показывать</option>
                <option value="hover">При наведении</option>
                <option value="always">Всегда</option>
              </select>
            </Field>
            <Field label="Полоса хитов" inline hint="Щелчок по числу броска в чате снимает или добавляет хиты выделенным токенам — на этой полосе.">
              <select class="input input-sm" value={s.hpBar || 'auto'} onChange={(e) => set({ hpBar: e.currentTarget.value })}>
                <option value="auto">Определять самой</option>
                <option value="1">Первая</option>
                <option value="2">Вторая</option>
                <option value="3">Третья</option>
              </select>
            </Field>
            <div class="set-list">
              <Toggle checked={!!s.hpNegative} onChange={(v) => set({ hpNegative: v })} label="Хиты могут уходить ниже нуля" />
            </div>

            <h3 class="j-h">Перемещение токенов</h3>
            <Field label="Как видно другим" inline hint="У каждого токена можно выбрать своё — в его настройках или в меню «Перемещение».">
              <select class="input input-sm" value={s.moveStyle || 'instant'} onChange={(e) => set({ moveStyle: e.currentTarget.value })}>
                {Object.entries(MOVE_STYLES).map(([k, n]) => (
                  <option value={k}>{n}</option>
                ))}
              </select>
            </Field>

            <CustomMarkers />

            <h3 class="j-h">Оформление стола</h3>
            <Field label="Оформление" inline hint="По листу: D&D и другое фэнтези — «Фэнтези», Cyberpunk RED, Lancer и прочая фантастика — «Киберпанк», остальное — «Таверна». Игрок может выбрать себе своё в разделе «Для меня».">
              <select class="input input-sm" value={s.theme || 'auto'} onChange={(e) => set({ theme: e.currentTarget.value })} aria-label="Оформление стола">
                <option value="auto">По листу — сейчас «{THEMES[detectTheme(store.game)].name}»</option>
                {Object.entries(THEMES).map(([k, t]) => (
                  <option value={k}>{t.name}</option>
                ))}
              </select>
            </Field>

            <h3 class="j-h">Лист персонажа</h3>
            <p class="small muted">{tpl ? tpl.name : 'Лист не выбран — его можно назначить в настройках стола в лобби.'}</p>
            <Field label="Язык листа" hint="Переводы берутся из репозитория Roll20; если перевода нет, лист будет на английском.">
              <select class="input input-sm" value={s.sheetLanguage || 'ru'} onChange={(e) => set({ sheetLanguage: e.currentTarget.value })}>
                {Object.entries(LANGS).map(([code, name]) => (
                  <option value={code}>{name}</option>
                ))}
              </select>
            </Field>
            {userOptions.length > 0 && (
              <>
                <p class="small muted">Настройки листа по умолчанию — применяются к новым персонажам.</p>
                {userOptions.map((o) => (
                  <SheetOption o={o} value={s.sheetOptions?.[o.attribute]} onChange={(v) => set({ sheetOptions: { ...(s.sheetOptions || {}), [o.attribute]: v } })} tpl={tpl} />
                ))}
              </>
            )}

            <h3 class="j-h">Чат</h3>
            <div class="set-list">
              <Toggle checked={s.chatAvatars !== false} onChange={(v) => set({ chatAvatars: v })} label="Аватары в чате" />
              <Button size="sm" icon="scroll" title="Статистика бросков и награды за последний вечер — в чат для всех. То же командой /итоги, за всю кампанию — /итоги всё" onClick={() => app.runMacro('/итоги')}>
                Подвести итоги вечера
              </Button>
              <Button
                size="sm"
                kind="danger"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Очистить архив чата?', text: 'Все сообщения будут удалены у всех участников.', okText: 'Очистить', danger: true })) net.request('chat:clear', {});
                }}
              >
                Очистить чат
              </Button>
            </div>
          </>
        )}
        <h3 class="j-h">Мои кубики</h3>
        <DiceStyle />

        <h3 class="j-h">Для меня</h3>
        <div class="set-list">
          <Toggle checked={pot} onChange={togglePot} label="Режим чайника — бережёт видеокарту" />
        </div>
        <p class="small muted">{TEAPOT_HINT} Тот же переключатель — в главном меню.</p>
        <Field
          label="Кубики при броске"
          inline
          hint={pot && dice === '3d' ? 'Сейчас включён режим чайника — кубики плоские.' : 'Только на этом устройстве. Если включено уменьшение движения в системе, кубики будут плоскими.'}
        >
          <select
            class="input input-sm"
            value={dice}
            onChange={(e) => {
              setDiceMode(e.currentTarget.value);
              setDice(e.currentTarget.value);
            }}
          >
            <option value="3d">Катятся по столу</option>
            <option value="2d">Плоские в углу</option>
            <option value="off">Не показывать</option>
          </select>
        </Field>
        <Field label="Оформление" inline hint="Только на этом устройстве.">
          <select
            class="input input-sm"
            value={ownTheme}
            aria-label="Оформление для меня"
            onChange={(e) => {
              setUserTheme(e.currentTarget.value);
              setOwnTheme(e.currentTarget.value);
              store.emit('ui:theme');
            }}
          >
            <option value="">Как у стола</option>
            {Object.entries(THEMES).map(([k, t]) => (
              <option value={k}>{t.name}</option>
            ))}
          </select>
        </Field>
        <p class="small muted">
          {compressEnabled(app.user) ? 'Загружаемые файлы сжимаются: картинки — в WebP, видео, анимации и музыка — в WebM.' : 'Файлы загружаются без сжатия.'} Переключается в главном меню — кнопкой «Сжатие файлов».
        </p>
        <div class="set-list">
          <Toggle
            checked={motion}
            disabled={pot}
            onChange={(v) => {
              setThemeMotion(v);
              setMotion(v);
              store.emit('ui:theme');
            }}
            label={pot ? 'Анимация оформления (выключена режимом чайника)' : 'Анимация оформления'}
          />
        </div>

        <h3 class="j-h">Журнал</h3>
        <p class="small muted">Все сообщения, которые вы видите в чате, одним файлом — удобно хранить летопись кампании.</p>
        <Button
          size="sm"
          icon="download"
          onClick={async () => {
            try {
              toast('Собираем журнал чата…');
              const n = await exportChatLog(app);
              toast(`Журнал сохранён: ${n} сообщ.`, 'ok');
            } catch (e) {
              toast('Не удалось сохранить журнал: ' + e.message, 'error');
            }
          }}
        >
          Скачать журнал чата
        </Button>

        <h3 class="j-h">Подсказки</h3>
        <ul class="hints small muted">
          <li>Колесо мыши — масштаб, пробел или средняя кнопка — двигать карту.</li>
          <li>Долгое нажатие на карте — пинг{gm ? ' (с Shift — переместить всех игроков к точке)' : ''}.</li>
          <li>Alt при перемещении — без привязки к сетке, Shift — пропорции и поворот по 15°.</li>
          <li>Токен с анимацией перемещения тянется полупрозрачным призраком; пробел во время перетаскивания — поворот пути, токен пройдёт по нему.</li>
          <li>Ctrl+Z / Ctrl+Y — отмена и повтор, Ctrl+C / Ctrl+V — копировать токены, Delete — удалить.</li>
          <li>Двойной щелчок по токену открывает лист персонажа или настройки токена.</li>
          <li>В чате: /r 2d20kh1+5, /w Имя текст, /em действие, /gr — бросок для мастера, /итоги — итоги вечера.</li>
          <li>Выделите токены и щёлкните по числу броска в чате — урон, половина, двойной урон или лечение; в уведомлении есть «Отменить».</li>
          <li>Под броском заклинания, для которого за столом есть эффект, — кнопка «Наложить»; то же макросом: /effect Благословение.</li>
          <li>Реакция на сообщение — смайлик в углу сообщения; ☺ у поля ввода — реакция над своим токеном.</li>
          <li>Компьютер греется или шумит — включите «Режим чайника» (здесь, в «Для меня», или в главном меню): всё работает, но без тяжёлой анимации.</li>
          {gm && <li>Ловушка: правый щелчок по карте — «Поставить ловушку здесь», или «Сделать ловушкой» у фигуры. Срабатывает, когда ход сделан: токен отпустили на ней или провели через неё.</li>}
          {gm && <li>Бестиарий — в журнале: монстры SRD 5.2.1 сразу на карту, со статблоком и кнопками атак; свои — по ссылке с GitHub или из файла.</li>}
          {gm && <li>Кинотрюки — кнопка с хлопушкой на панели инструментов: титры, голос рассказчика, затемнение, тряска, вспышка, камера.</li>}
        </ul>
      </div>
    </div>
  );
}

function SheetOption({ o, value, onChange, tpl }) {
  const label = (o.displaytranslationkey && tpl?.t(o.displaytranslationkey)) || o.displayname || o.attribute;
  const v = value ?? o.value ?? (o.type === 'checkbox' ? (o.checked === 'true' || o.checked === true ? o.value : '') : o.default ?? '');
  if (o.type === 'checkbox') return <Toggle checked={!!v && v !== '0'} onChange={(c) => onChange(c ? o.value ?? '1' : '0')} label={label} />;
  if (o.type === 'select') {
    const opts = (o.options || []).map((x, i) => {
      const [lab, val] = String(x).split('|');
      const tl = o.optiontranslationkeys?.[i] && tpl?.t(o.optiontranslationkeys[i]);
      return { label: tl || lab, value: val ?? lab };
    });
    return (
      <Field label={label} inline>
        <select class="input input-sm" value={v} onChange={(e) => onChange(e.currentTarget.value)}>
          {opts.map((x) => (
            <option value={x.value}>{x.label}</option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <Field label={label} inline>
      <input class="input input-sm" value={v} onChange={(e) => onChange(e.currentTarget.value)} />
    </Field>
  );
}

/** Свои маркеры-эффекты: значок, срок, концентрация, изменения листа и токена, действие каждый ход (как DAE в Foundry) */
function CustomMarkers() {
  const app = useApp();
  const { store, net } = app;
  const list = (store.settings.markers || []).filter((m) => m && m.id);
  const defs = markerDefs(store);
  const s = store.settings;
  return (
    <>
      <h3 class="j-h">Маркеры и эффекты</h3>
      <p class="small muted">
        Маркер может менять лист персонажа, полосы и сам токен (свет, размер, невидимость), длиться раунды или до следующего хода, держаться на концентрации и действовать каждый ход. Ставится через «+» у выделенного токена, кнопкой «Наложить» под броском заклинания в
        чате или макросом /effect Название.
      </p>
      {list.length > 0 && (
        <ul class="custom-markers">
          {list.map((m) => {
            const desc = describeEffect(m);
            return (
              <li>
                <MarkerLookView look={markerLook(m, defs)} size={24} />
                <span class="grow">
                  {m.name}
                  {desc && <span class="small muted"> — {desc}</span>}
                </span>
                <IconButton icon="pencil" size={15} title={'Изменить «' + m.name + '»'} onClick={() => app.editMarker(m.id)} />
              </li>
            );
          })}
        </ul>
      )}
      <div class="row row-wrap" style={{ gap: '6px' }}>
        <Button size="sm" icon="plus" onClick={() => app.editMarker(null)}>
          Свой маркер
        </Button>
        <Button size="sm" icon="sparkles" onClick={() => app.openEffectLibrary()}>
          Готовые эффекты…
        </Button>
      </div>
      <div class="set-list" style={{ marginTop: '8px' }}>
        <Toggle
          checked={s.playersApplyEffects !== false}
          onChange={(v) => net.request('settings', { playersApplyEffects: v }).then((r) => r?.error && toast(r.error, 'error'))}
          label="Игроки накладывают эффекты на чужие токены (через мастера)"
        />
      </div>
    </>
  );
}

function PlayerPages() {
  const { store, net } = useApp();
  const players = [...store.members.values()].filter((m) => m.role !== 'gm');
  if (!players.length) return null;
  const pages = [...store.col.page.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
  const pp = store.state.playerPages || {};
  const setFor = (uid, pid) => {
    const next = { ...pp };
    if (!pid) delete next[uid];
    else next[uid] = pid;
    net.request('state', { playerPages: next });
  };
  return (
    <div class="player-pages">
      <p class="small muted" style={{ margin: '6px 0 4px' }}>
        Сцена для отдельных игроков:
      </p>
      {players.map((m) => (
        <label class="row small" style={{ marginBottom: '4px' }}>
          <span class="grow">{m.displayName}</span>
          <select class="input input-sm" style={{ width: '160px' }} value={pp[m.id] || ''} onChange={(e) => setFor(m.id, e.currentTarget.value)}>
            <option value="">Вместе со всеми</option>
            {pages.map((p) => (
              <option value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
