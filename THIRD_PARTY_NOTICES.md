# Сторонние компоненты

Таверна использует следующие компоненты. Их лицензии сохраняются; полные тексты — в папках пакетов
(`node_modules/<пакет>/LICENSE`) и в указанных ниже файлах.

## Входят в поставку

| Компонент | Где используется | Лицензия |
|---|---|---|
| [Листы персонажей Roll20](https://github.com/Roll20/roll20-character-sheets) (папка `sheets/`) | листы персонажей | MIT, © 2014–2018 Roll20 и авторы листов — `sheets/LICENSE-roll20-character-sheets.txt` |
| [Font Awesome Free 6](https://fontawesome.com) (иконки в `client/public/fonts/r20/`) | заменители шрифтов Pictos и dicefont | шрифты — SIL OFL 1.1, иконки — CC BY 4.0, © Fonticons, Inc. — `client/public/fonts/r20/LICENSE-FontAwesome.txt` |
| [Alegreya, Alegreya Sans](https://github.com/huertatipografica/Alegreya) (@fontsource) | шрифты интерфейса и листа D&D 2024 (`client/public/fonts/sheet/`) | SIL OFL 1.1, © Huerta Tipográfica — `client/public/fonts/sheet/OFL-*.txt` |
| [Tektur](https://github.com/hyvyys/Tektur), [IBM Plex Sans и IBM Plex Mono](https://github.com/IBM/plex), [Cormorant Unicase](https://github.com/CatharsisFonts/Cormorant) (@fontsource) | шрифты оформлений стола «Киберпанк» и «Фэнтези» | SIL OFL 1.1, © The Tektur Project Authors, © IBM Corp., © The Cormorant Project Authors — тексты в `dist/licenses.txt` |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) | сжатие загружаемых видео, анимаций и звука в WebM прямо в браузере | MPL-2.0, используется без изменений; исходный код — https://github.com/Vanilagy/mediabunny (версия 1.61.1) |
| [System Reference Document 5.2](https://www.dndbeyond.com/srd) | правила для листа D&D 2024 (`sheets/DnD2024/`): названия характеристик, навыков, состояний, свойства мастерства оружия | CC BY 4.0, © Wizards of the Coast LLC. «This work includes material from the System Reference Document 5.2 (“SRD 5.2”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.» |
| [System Reference Document 5.2.1](https://www.dndbeyond.com/srd) в Markdown из репозитория [downfallx/dnd-5e-srd-markdown](https://github.com/downfallx/dnd-5e-srd-markdown) | встроенный бестиарий мастера (`client/public/srd/monsters.json`): 330 монстров и зверей. Собран скриптом `scripts/make-srd-bestiary.mjs`: статблоки переведены в JSON, тексты свойств и действий — на английском без изменений, добавлены русские названия | CC BY 4.0, © Wizards of the Coast LLC. «This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.» Изменения: статблоки из Markdown переведены в структурированные данные. |
| [QR Code Generator](https://github.com/kazuhikoarase/qrcode-generator) (qrcode-generator) | QR-коды в окне «Подключить телефон» | MIT, © 2009 Kazuhiko Arase. «QR Code» — товарный знак DENSO WAVE INCORPORATED |
| [Underscore.js](https://underscorejs.org) | API sheet workers (`_`) | MIT |
| [Preact](https://preactjs.com) | интерфейс | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | очистка HTML в чате | Apache-2.0 или MPL-2.0 |
| [three.js](https://threejs.org) | объёмные кубики | MIT, © 2010–2024 three.js authors |
| [cannon-es](https://github.com/pmndrs/cannon-es) | физика объёмных кубиков | MIT, © 2015 cannon.js authors |
| [Socket.IO](https://socket.io) (сервер и клиент) | связь в реальном времени | MIT |
| [Express](https://expressjs.com), compression, multer | веб-сервер | MIT |
| [SQLite](https://sqlite.org) (через встроенный в Node.js модуль `node:sqlite`) | база данных | public domain |
| [Node.js](https://nodejs.org) — внутри программы одним файлом (`Taverna.exe`, `taverna-linux-*`) | среда выполнения | MIT и лицензии входящих в Node.js компонентов — `licenses/Node.js-LICENSE.txt` рядом с программой |

Заменители иконочных шрифтов собраны скриптом `scripts/build-icon-fonts.py` из Font Awesome Free
и переименованы (Taverna Pictos и т. д.), как требует OFL для изменённых шрифтов.
Оригинальные шрифты Roll20 (Pictos, dicefont) не распространяются.

## Скачиваются при развёртывании

| Компонент | Где используется | Лицензия |
|---|---|---|
| [Caddy](https://caddyserver.com) (образ `caddy`) | HTTPS и обратный прокси | Apache-2.0 |
| [coturn](https://github.com/coturn/coturn) (образ `coturn/coturn`, профиль `voice`, необязательно) | TURN-ретранслятор голосового чата | BSD-3-Clause |
| [Node.js](https://nodejs.org) (образ `node`) | среда выполнения | MIT |

## Только для разработки и сборки

Vite, @preact/preset-vite, esbuild, playwright-core — MIT / Apache-2.0; postject (вшивание кода в Node.js) — MIT;
resedit (иконка и сведения о программе для Windows) — MIT. Тестовый центр сертификации Pebble (для тестов) — MPL-2.0.

Roll20 — товарный знак Roll20, LLC. Названия игровых систем (Dungeons & Dragons, Cyberpunk RED,
Warhammer) принадлежат их правообладателям; Таверна с ними не связана.
