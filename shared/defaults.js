// Значения по умолчанию для страниц, токенов и настроек стола (общие для клиента и сервера)

export const PAGE_DEFAULTS = {
  name: 'Новая сцена',
  width: 30, // в клетках
  height: 20,
  cellSize: 70, // пикселей на клетку
  gridType: 'square', // square | hex | hexr | none
  gridColor: '#000000',
  gridOpacity: 0.3,
  gridWidth: 1,
  snap: true,
  scale: 5, // единиц в клетке
  units: 'фт',
  diagonal: 'dnd5e', // dnd5e | pf | euclid | manhattan
  bgColor: '#ffffff',
  fog: { enabled: false, gmOpacity: 0.45 },
  lighting: {
    enabled: false,
    daylight: false, // глобальное освещение
    daylightLevel: 1,
    explorer: false, // режим исследователя (запоминать увиденное)
    restrictMovement: true, // стены мешают движению токенов игроков
    sharedVision: false, // общий обзор отряда: все игроки видят глазами всех токенов игроков
    darkness: 1, // непрозрачность темноты для игроков
  },
  weather: { type: 'none', intensity: 0.5, wind: 0.3, color: '' },
  order: 0,
  archived: false,
};

export const GAME_SETTINGS_DEFAULTS = {
  playersCanDraw: true,
  playersCanCreateCharacters: true,
  playersCanUseFx: true,
  barPosition: 'top', // above | top | bottom | below
  barStyle: 'standard', // standard | compact
  showBarText: 'hover', // never | hover | always
  shareRuler: true,
  sheetLanguage: 'ru',
  sheetOptions: {}, // значения «настроек листа по умолчанию» (useroptions из sheet.json)
  defaultTokenSize: 1,
  chatAvatars: true,
  hpBar: 'auto', // какая полоса токена — хиты (для урона из чата): auto | 1 | 2 | 3 …
  hpNegative: false, // хиты могут уходить ниже нуля
  markers: [], // свои маркеры {id, name, image | icon, rounds?, changes?, note?}
  moveStyle: 'instant', // как по умолчанию видно перемещение токенов (см. MOVE_STYLES)
  theme: 'auto', // оформление стола: auto (по листу) | tavern | cyber | fantasy
  playersApplyEffects: true, // игроки накладывают эффекты стола на чужие токены (через мастера за столом)
};

export const GAME_STATE_DEFAULTS = {
  playerPageId: null,
  playerPages: {}, // userId -> pageId (индивидуальные переходы)
  turnorder: [], // [{id, tokenId?, name?, pr, custom?}]
  round: 1,
  tick: 0, // сколько раундов прошло всего (для длительности эффектов; не сбрасывается вместе с порядком ходов)
  turnSeq: 0, // номер хода (растёт на каждом «следующий ход»): сроки «до следующего хода» и эффекты «каждый ход»
  lastTurn: null, // {seq, ended, started} — чей ход закончился и чей начался
  turnFxDone: 0, // для какого хода мастер уже выполнил эффекты «каждый ход»
  turnVisible: false,
  jukebox: { playing: {} }, // trackId -> {startedAt, volume, loop}
  folders: { char: [], handout: [] },
  cine: { fade: false, bars: false }, // кинотрюки мастера: затемнение и кинополосы у игроков
};

export const BAR_COLORS = ['#3eaa49', '#3b7bd8', '#d63a3a', '#e0a020', '#8e44ad', '#16a085'];

export function newBar(index = 0, extra = {}) {
  return {
    id: 'b' + Math.random().toString(36).slice(2, 9),
    name: index === 2 ? 'HP' : '',
    value: '',
    max: '',
    color: BAR_COLORS[index % BAR_COLORS.length],
    link: '', // имя атрибута персонажа
    visibility: 'all', // all | owners | gm
    editable: 'owners', // owners | gm
    showText: 'inherit', // inherit | never | hover | always
    ...extra,
  };
}

export const TOKEN_DEFAULTS = {
  type: 'image', // image | shape | text | path | wall
  layer: 'objects',
  x: 0,
  y: 0,
  w: 70,
  h: 70,
  rot: 0,
  flipH: false,
  flipV: false,
  z: 0,
  locked: false,
  opacity: 1,
  name: '',
  showName: false,
  showNameToPlayers: true,
  represents: '',
  controlledBy: [],
  bars: [],
  markers: [],
  auras: [],
  tint: '',
  light: { enabled: false, bright: 20, dim: 20, color: '#ffe7b0', angle: 360, dir: 0, intensity: 1 },
  vision: { enabled: false, range: 0, darkvision: 0, angle: 360 },
  effects: {},
  notes: '',
  gmnotes: '',
  attachedTo: '', // id объекта, на котором токен «едет» (сцепка)
  actions: [], // макросы токена: [{id, name, action}]
  barPosition: '', // '' — как в настройках стола; above | top | bottom | below
  barStyle: '', // '' — как в настройках стола; standard | compact
  moveStyle: '', // '' — как в настройках стола; instant | smooth | steps | teleport | fire
};

// Оформление стола (клиент подбирает «по листу», если выбрано auto)
export const TABLE_THEMES = ['auto', 'tavern', 'cyber', 'fantasy'];

// Как другие видят перемещение токена
export const MOVE_STYLES = {
  instant: 'Сразу (видно, как тянут)',
  smooth: 'Плавно',
  steps: 'По клеткам, шагами',
  teleport: 'Телепорт',
  fire: 'Сгорает и появляется из огня',
};

export const LAYERS = ['map', 'objects', 'foreground', 'gm', 'walls'];
export const LAYER_NAMES = {
  map: 'Карта и фон',
  objects: 'Объекты и токены',
  foreground: 'Передний план',
  gm: 'Слой мастера',
  walls: 'Стены и свет',
};

// Статус-маркеры (по мотивам набора Roll20 + состояния D&D 5e)
export const MARKERS = [
  { id: 'red', name: 'Красный', color: '#e74c3c' },
  { id: 'blue', name: 'Синий', color: '#3498db' },
  { id: 'green', name: 'Зелёный', color: '#2ecc71' },
  { id: 'brown', name: 'Коричневый', color: '#8d5524' },
  { id: 'purple', name: 'Фиолетовый', color: '#9b59b6' },
  { id: 'pink', name: 'Розовый', color: '#ff7eb6' },
  { id: 'yellow', name: 'Жёлтый', color: '#f1c40f' },
  { id: 'dead', name: 'Мёртв', emoji: '✖' },
  { id: 'skull', name: 'Череп', emoji: '💀' },
  { id: 'blinded', name: 'Ослеплён', emoji: '🙈' },
  { id: 'charmed', name: 'Очарован', emoji: '💘' },
  { id: 'deafened', name: 'Оглушён (глух)', emoji: '🔇' },
  { id: 'frightened', name: 'Испуган', emoji: '😱' },
  { id: 'grappled', name: 'Схвачен', emoji: '🤼' },
  { id: 'incapacitated', name: 'Недееспособен', emoji: '💫' },
  { id: 'invisible', name: 'Невидим', emoji: '👻' },
  { id: 'paralyzed', name: 'Парализован', emoji: '⚡' },
  { id: 'petrified', name: 'Окаменел', emoji: '🗿' },
  { id: 'poisoned', name: 'Отравлен', emoji: '🧪' },
  { id: 'prone', name: 'Сбит с ног', emoji: '🛌' },
  { id: 'restrained', name: 'Опутан', emoji: '⛓️' },
  { id: 'stunned', name: 'Ошеломлён', emoji: '🌀' },
  { id: 'unconscious', name: 'Без сознания', emoji: '💤' },
  { id: 'exhaustion', name: 'Истощение', emoji: '😩' },
  { id: 'concentration', name: 'Концентрация', emoji: '🧠' },
  { id: 'bleeding', name: 'Кровотечение', emoji: '🩸' },
  { id: 'burning', name: 'Горит', emoji: '🔥' },
  { id: 'frozen', name: 'Заморожен', emoji: '❄️' },
  { id: 'blessed', name: 'Благословение', emoji: '✨' },
  { id: 'cursed', name: 'Проклятие', emoji: '🕸️' },
  { id: 'shield', name: 'Щит', emoji: '🛡️' },
  { id: 'haste', name: 'Ускорение', emoji: '🏃' },
  { id: 'slow', name: 'Замедление', emoji: '🐌' },
  { id: 'flying', name: 'Летит', emoji: '🪽' },
  { id: 'hidden', name: 'Скрыт', emoji: '🫥' },
  { id: 'target', name: 'Цель', emoji: '🎯' },
  { id: 'star', name: 'Звезда', emoji: '⭐' },
  { id: 'heart', name: 'Сердце', emoji: '❤️' },
  { id: 'flag', name: 'Флаг', emoji: '🚩' },
  { id: 'lock', name: 'Замок', emoji: '🔒' },
  { id: 'timer', name: 'Таймер', emoji: '⏳' },
];

export const DIAGONAL_RULES = {
  dnd5e: 'D&D 5e (1-1-1)',
  pf: 'Pathfinder (1-2-1)',
  euclid: 'Евклидово',
  manhattan: 'Манхэттен',
};

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k]))
      out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}
