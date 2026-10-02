// Interface language of the Mini App / web chat. The assistant itself answers in the language the customer writes in;
// this only translates the app around it (greeting, buttons, catalogue).

export type Lang = 'uz' | 'ru';

const STORAGE_KEY = 'ui_lang';
const RUSSIAN_SPEAKING = ['ru', 'be', 'uk', 'kk', 'ky', 'tg'];

function telegramLanguage(): string | null {
  const code = (window as any).Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  if (typeof code === 'string' && code) return code.toLowerCase();
  // telegram-web-app.js loads asynchronously; Telegram also passes the same data in the page address
  try {
    const data = new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData');
    const user = data ? new URLSearchParams(data).get('user') : null;
    const parsed = user ? JSON.parse(user) : null;
    if (typeof parsed?.language_code === 'string') return parsed.language_code.toLowerCase();
  } catch { /* not opened from Telegram */ }
  return null;
}

// The customer's own choice, else Telegram's language, else the browser's; Uzbek by default
export function detectLang(): Lang {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (fromUrl === 'ru' || fromUrl === 'uz') return fromUrl;
  } catch { /* ignore */ }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ru' || saved === 'uz') return saved;
  } catch { /* storage blocked in some webviews */ }
  const code = telegramLanguage() ?? (typeof navigator !== 'undefined' ? navigator.language?.toLowerCase() : '') ?? '';
  return RUSSIAN_SPEAKING.some(prefix => code.startsWith(prefix)) ? 'ru' : 'uz';
}

export function saveLang(lang: Lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
}

export const STRINGS = {
  uz: {
    subtitle: (name: string) => `${name} · AI yordamchi`,
    catalog: 'Katalog',
    catalogTitle: 'Mahsulotlar katalogi',
    soundOn: "Javoblarni ovoz bilan o'qish",
    soundOff: "Ovozni o'chirish",
    switchLang: 'RU',
    switchLangTitle: 'Русский язык',
    suggestions: [
      'Kafe uchun stakan va qopqoq kerak',
      "Kraft paketlar qanday o'lchamlarda?",
      'Ulgurji narxlar qanday ishlaydi?',
      'Yetkazib berish shartlari',
      "Menejer bilan bog'lanish",
    ],
    products: 'Mahsulotlar',
    all: (n: number) => `Barchasi (${n}) →`,
    placeholder: (name: string) => `${name}ga xabar yozing...`,
    recording: "Ovoz yozilmoqda... To'xtatish uchun qizil tugmani bosing.",
    footer: (shop: string) => `${shop} sun'iy intellekt yordamchisi. Ayrim javoblarda noaniqliklar bo'lishi mumkin.`,
    chatFailed: "Kechirasiz, javob olishda xatolik yuz berdi. Iltimos qaytadan urinib ko'ring.",
    micDenied: "Mikrofondan foydalanishga ruxsat berilmadi yoki xatolik yuz berdi.",
    voiceFailed: "Ovozli xabarni qayta ishlashda xatolik yuz berdi.",
    voiceFallback: '[Ovozli xabar]',
    imageOnly: 'Faqat rasm yuboring (JPG, PNG yoki WEBP).',
    imageFailed: 'Rasmni qayta ishlashda xatolik yuz berdi.',
    imageCaption: 'Shunday mahsulot bormi?',
    sendPhoto: 'Mahsulot rasmini yuborish',
    sendVoice: 'Ovozli xabar yuborish',
    stopVoice: "Yozishni to'xtatish va yuborish",
    notUnderstood: 'Kechirasiz, men tushuna olmadim.',
    productPage: 'Mahsulot sahifasi',
    shareContact: '📱 Raqamimni yuborish',
    leaveRequest: "✅ So'rov qoldirish",
    callManager: "📞 Menejer bilan bog'lanish",
    wantRequest: "So'rov qoldirmoqchiman",
    myContact: (phone: string, name: string) => `Mening telefon raqamim: ${phone}${name ? `, ismim: ${name}` : ''}`,
    productLoadFailed: "Mahsulot ma'lumotlarini yuklab bo'lmadi.",
    askAbout: (name: string) => `${name} haqida ma'lumot bering`,
    // catalogue sheet and tiles
    catalogSubtitle: (n: number | null) => `${n !== null ? `${n} ta mahsulot · ` : ''}narxlar qadoq uchun · bosing, yordamchi batafsil aytib beradi`,
    close: 'Yopish',
    search: 'Qidirish: stakan, kraft paket, 20x30...',
    allCategories: 'Hammasi',
    catalogFailed: "Katalogni yuklab bo'lmadi.",
    retry: 'Qayta urinish',
    myRequests: "So'rovlarim",
    myRequestsTitle: "Mening so'rovlarim",
    myRequestsSubtitle: "Holatini menejerlar sayt CRM'ida yangilab boradi",
    myRequestsEmpty: "Hali so'rov yo'q. Qanday mahsulot kerakligini yozing — narxini hisoblab, so'rovni rasmiylashtiramiz.",
    myRequestsFailed: "So'rovlarni yuklab bo'lmadi.",
    sum: "so'm",
    unit: (unit: string | null) => unit || 'qadoq',
    moreItems: (n: number) => `va yana ${n} ta`,
    requestStatus: {
      NEW: "Qabul qilindi, menejer bog'lanadi", pending: "Qabul qilindi, menejer bog'lanadi",
      CONTACTED: "Menejer bog'landi", IN_PROGRESS: 'Jarayonda', processing: "Jo'natishga tayyorlanmoqda",
      WON: 'Kelishildi ✅', delivered: 'Topshirildi ✅', LOST: 'Yopildi', cancelled: 'Bekor qilindi',
    } as Record<string, string>,
    nothingFound: "Hech narsa topilmadi. Yordamchidan so'rab ko'ring: u o'xshash mahsulotni topib beradi.",
    askTitle: (name: string) => `${name} haqida so'rash`,
    openOnSite: "Saytda ko'rish",
    onSite: 'Saytda',
  },
  ru: {
    subtitle: (name: string) => `${name} · AI-помощник`,
    catalog: 'Каталог',
    catalogTitle: 'Каталог товаров',
    soundOn: 'Читать ответы вслух',
    soundOff: 'Выключить звук',
    switchLang: 'UZ',
    switchLangTitle: "O'zbek tili",
    suggestions: [
      'Нужны стаканы и крышки для кафе',
      'Какие размеры крафт-пакетов есть?',
      'Как работают оптовые цены?',
      'Условия доставки',
      'Связаться с менеджером',
    ],
    products: 'Товары',
    all: (n: number) => `Все (${n}) →`,
    placeholder: () => 'Напишите сообщение...',
    recording: 'Идёт запись... Нажмите красную кнопку, чтобы остановить.',
    footer: (shop: string) => `${shop} — помощник на основе ИИ. В ответах возможны неточности.`,
    chatFailed: 'Извините, не удалось получить ответ. Попробуйте ещё раз.',
    micDenied: 'Нет доступа к микрофону или произошла ошибка.',
    voiceFailed: 'Не удалось обработать голосовое сообщение.',
    voiceFallback: '[Голосовое сообщение]',
    imageOnly: 'Отправьте изображение (JPG, PNG или WEBP).',
    imageFailed: 'Не удалось обработать фото.',
    imageCaption: 'Есть такой товар?',
    sendPhoto: 'Отправить фото товара',
    sendVoice: 'Отправить голосовое сообщение',
    stopVoice: 'Остановить запись и отправить',
    notUnderstood: 'Извините, я не поняла.',
    productPage: 'Страница товара',
    shareContact: '📱 Отправить мой номер',
    leaveRequest: '✅ Оставить заявку',
    callManager: '📞 Связаться с менеджером',
    wantRequest: 'Хочу оставить заявку',
    myContact: (phone: string, name: string) => `Мой номер телефона: ${phone}${name ? `, меня зовут ${name}` : ''}`,
    productLoadFailed: 'Не удалось загрузить данные товара.',
    askAbout: (name: string) => `Расскажите про товар: ${name}`,
    catalogSubtitle: (n: number | null) => `${n !== null ? `${n} товаров · ` : ''}цены за упаковку · нажмите — помощник расскажет подробнее`,
    close: 'Закрыть',
    search: 'Поиск: стакан, крафт-пакет, 20x30...',
    allCategories: 'Все',
    catalogFailed: 'Не удалось загрузить каталог.',
    retry: 'Повторить',
    myRequests: 'Заявки',
    myRequestsTitle: 'Мои заявки',
    myRequestsSubtitle: 'Статус обновляют менеджеры в CRM сайта',
    myRequestsEmpty: 'Заявок пока нет. Напишите, какой товар нужен, — рассчитаем цену и оформим заявку.',
    myRequestsFailed: 'Не удалось загрузить заявки.',
    sum: 'сум',
    unit: (unit: string | null) => ({ qadoq: 'упак.', korobka: 'кор.', dona: 'шт.', rulon: 'рул.', kg: 'кг' } as Record<string, string>)[unit ?? 'qadoq'] ?? unit ?? 'упак.',
    moreItems: (n: number) => `и ещё ${n}`,
    requestStatus: {
      NEW: 'Принята, менеджер свяжется', pending: 'Принята, менеджер свяжется',
      CONTACTED: 'Менеджер связался', IN_PROGRESS: 'В работе', processing: 'Готовится к отправке',
      WON: 'Согласована ✅', delivered: 'Доставлена ✅', LOST: 'Закрыта', cancelled: 'Отменена',
    } as Record<string, string>,
    nothingFound: 'Ничего не найдено. Спросите помощника — он подберёт похожий товар.',
    askTitle: (name: string) => `Спросить про ${name}`,
    openOnSite: 'Открыть на сайте',
    onSite: 'На сайте',
  },
} as const;

export type Strings = (typeof STRINGS)[Lang];
