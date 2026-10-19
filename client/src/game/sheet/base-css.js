// Базовые стили, которые Roll20 даёт листам «из коробки». Лист может их переопределять.

// Заменители иконочных шрифтов Roll20 (Pictos, dicefont) — собраны scripts/build-icon-fonts.py
// из Font Awesome Free (SIL OFL 1.1), лежат в client/public/fonts/r20/
const R20_FONT_FILES = [
  ['Pictos', 'pictos'],
  ['Pictos Custom', 'pictos-custom'],
  ['Pictos Three', 'pictos-three'],
  ['dicefontd4', 'dicefont-d4'],
  ['dicefontd6', 'dicefont-d6'],
  ['dicefontd8', 'dicefont-d8'],
  ['dicefontd10', 'dicefont-d10'],
  ['dicefontd12', 'dicefont-d12'],
  ['dicefontd20', 'dicefont-d20'],
];
export const R20_FONTS_CSS = R20_FONT_FILES.map(([family, file]) => `@font-face { font-family: '${family}'; src: url('/fonts/r20/${file}.woff2') format('woff2'); font-display: block; }`).join('\n');

// Как в Roll20: внизу — стили Bootstrap 2 с низкой точностью селекторов (просто input, select…),
// поэтому правила листа (Roll20 приписывает к ним .charsheet) их перебивают. Особый случай — ширина
// числовых полей: в Roll20 это «.ui-dialog .charsheet input[type=number]», её перебивают только точные правила.
// Размеры сверены со снимками листов из репозитория Roll20 (preview.png): поле ввода 210×28 без внешних
// отступов, числовое — 3.5em, у выпадающего списка — 9px снизу, флажки без отступов по бокам.
export const SHEET_BASE_CSS = `
@import url('https://fonts.googleapis.com/css?family=Patrick+Hand|Contrail+One|Shadows+Into+Light|Candal&display=swap');
${R20_FONTS_CSS}
html, body { margin: 0; padding: 0; background: #fff; }
/* В Roll20 корневой шрифт — 10px, листы с размерами в rem рассчитаны на это (1.2rem = 12px) */
html { font-size: 10px; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 13px; line-height: 18px; color: #333; overflow-x: hidden; }
.ui-dialog { position: static; display: block; }
.ui-dialog-content, .tab-content, .tab-pane { display: block; }
.charsheet { position: relative; padding: 8px 10px 30px; min-height: 100%; box-sizing: border-box; }
p { margin: 0 0 9px; }
h1, h2, h3, h4, h5, h6 { margin: 0; font-family: inherit; font-weight: bold; color: inherit; text-rendering: optimizelegibility; }
h1 { font-size: 30px; line-height: 36px; } h2 { font-size: 24px; line-height: 36px; } h3 { font-size: 18px; line-height: 27px; }
h4, h5, h6 { line-height: 18px; } h4 { font-size: 14px; } h5 { font-size: 12px; } h6 { font-size: 11px; color: #999; text-transform: uppercase; }
ul, ol { padding: 0; margin: 0 0 9px 25px; }
ul ul, ul ol, ol ol, ol ul { margin-bottom: 0; }
li { line-height: 18px; }
hr { margin: 18px 0; border: 0; border-top: 1px solid #eee; border-bottom: 1px solid #fff; }
a { color: #08c; text-decoration: none; } a:hover { color: #005580; text-decoration: underline; }
table { max-width: 100%; border-collapse: collapse; border-spacing: 0; }
fieldset { padding: 0; margin: 0; border: 0; }
label, input, button, select, textarea { font-size: 13px; font-weight: normal; line-height: 18px; }
input, button, select, textarea { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
label { display: inline-block; font-weight: bold; margin-bottom: 5px; color: #333; }
input, textarea, select { box-sizing: border-box; display: inline-block; width: 210px; height: auto; padding: 4px; margin: 0 0 9px; color: #555; background-color: #fff; border: 1px solid #ccc; border-radius: 3px; vertical-align: middle; }
input { margin: 0; }
input, textarea { box-shadow: inset 0 1px 1px rgba(0,0,0,.075); transition: border linear .2s, box-shadow linear .2s; }
input:focus, textarea:focus { border-color: rgba(82,168,236,.8); outline: 0; box-shadow: inset 0 1px 1px rgba(0,0,0,.075), 0 0 8px rgba(82,168,236,.6); }
input[type=checkbox], input[type=radio], input[type=image] { width: auto; height: auto; padding: 0; margin: 3px 0; line-height: normal; cursor: pointer; background-color: transparent; border-radius: 0; box-shadow: none; }
input[type=button], input[type=reset], input[type=submit], input[type=range], input[type=color] { width: auto; height: auto; }
select { width: 220px; height: 28px; line-height: 28px; padding: 0 4px; }
select[multiple], select[size] { height: auto; }
textarea { height: auto; resize: vertical; }
input[type=hidden] { display: none; }
input[disabled], select[disabled], textarea[disabled], input[readonly], select[readonly], textarea[readonly] { cursor: not-allowed; background-color: #f5f5f5; border-color: #ddd; }
.ui-dialog .charsheet input[type=number] { width: 3.5em; }
button { cursor: pointer; margin: 0; }
.btn, button[type=roll], button[type=action] {
  display: inline-block; padding: 4px 10px; margin: 0; font-size: 13px; line-height: 18px; color: #333; text-align: center; vertical-align: middle; cursor: pointer;
  background: linear-gradient(#fff, #e6e6e6); border: 1px solid #ccc; border-bottom-color: #b3b3b3; border-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.05);
}
.btn:hover, button[type=roll]:hover, button[type=action]:hover { background: #e6e6e6; }
button[type=roll]::before { font-family: dicefontd20; content: "t "; }
.charsheet button[type=compendium] { display: none; }
.charsheet .sheet-row, .charsheet .row { width: 100%; }
.charsheet .sheet-col { display: inline-block; vertical-align: top; }
.charsheet .sheet-3colrow .sheet-col { width: 31.5%; margin-right: 2%; }
.charsheet .sheet-2colrow .sheet-col { width: 48.5%; margin-right: 2%; }
.charsheet .sheet-3colrow .sheet-col:last-child, .charsheet .sheet-2colrow .sheet-col:last-child { margin-right: 0; }
.charsheet .sheet-3colrow, .charsheet .sheet-2colrow { width: 100%; }
/* Повторяющиеся секции */
.charsheet fieldset[class*="repeating_"] { display: none !important; }
.charsheet .repcontainer { position: relative; }
.charsheet .repitem { position: relative; }
.charsheet .itemcontrol { display: none; position: absolute; top: 0; right: 0; z-index: 20; gap: 2px; }
.charsheet .repcontainer.editmode .itemcontrol { display: flex; }
.charsheet .repcontainer.editmode .repitem { outline: 1px dashed rgba(0,0,0,.25); margin-bottom: 2px; }
.charsheet .repcontrol { display: block; overflow: hidden; margin: 4px 0; clear: both; }
.charsheet .repcontrol .btn { font-size: 12px; padding: 1px 8px; }
.charsheet .repcontrol_edit { float: right; }
.charsheet .repcontrol_add { float: left; }
.charsheet .itemcontrol .btn { width: 22px; height: 22px; padding: 0; line-height: 20px; font-size: 13px; }
.charsheet .repcontrol_del { color: #fff !important; background: #c9302c !important; border-color: #ac2925 !important; }
.charsheet .repcontrol_move { cursor: grab; text-decoration: none; }
.charsheet .repitem.r20-dragging { opacity: .5; }
.charsheet .r20-drop-before { box-shadow: 0 -3px 0 #3a7bd5; }
.pictos { font-family: 'Pictos'; }
`;
