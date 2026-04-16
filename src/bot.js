const { Telegraf, Markup } = require('telegraf');
const { config, validateConfig } = require('./config');
const { getStore, initStorage, updateStore } = require('./storage');
const { getPaymentSettings, seedPaymentSettings, updatePaymentSetting } = require('./settings');

const USER_STEPS = {
  IDLE: 'idle',
  AWAITING_CONTACT: 'awaiting_contact',
  AWAITING_FULL_NAME: 'awaiting_full_name',
  AWAITING_ARTICLE: 'awaiting_article',
  AWAITING_RECEIPT: 'awaiting_receipt',
};

const APPLICATION_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  REJECTED: 'rejected',
  AWAITING_RECEIPT: 'awaiting_receipt',
  PENDING_RECEIPT_REVIEW: 'pending_receipt_review',
  AWAITING_CERTIFICATE: 'awaiting_certificate',
  CERTIFICATE_SENT: 'certificate_sent',
};

const ADMIN_STATE = {
  SUBMISSION_REJECT_REASON: 'submission_reject_reason',
  RECEIPT_REJECT_REASON: 'receipt_reject_reason',
  AWAITING_CERTIFICATE_PDF: 'awaiting_certificate_pdf',
  SETTINGS_EDIT: 'settings_edit',
};

const ADMIN_BUTTONS = {
  PANEL: 'Admin panel',
  PENDING: 'Pending arizalar',
  SETTINGS: 'Sozlamalar',
  CERTIFICATES: 'Sertifikat kutayotganlar',
  CANCEL: 'Bekor qilish',
};

const USER_BUTTONS = {
  START: 'Ariza yuborish',
  STATUS: 'Holatim',
};

const FINAL_STATUSES = new Set([
  APPLICATION_STATUS.REJECTED,
  APPLICATION_STATUS.CERTIFICATE_SENT,
]);

function isAdmin(ctx) {
  return ctx.from?.id === config.adminId;
}

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(value, maxLength = 500) {
  if (!value) {
    return '';
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function buildDisplayName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || `User ${from.id}`;
}

function ensureUserRecord(store, from) {
  const userId = String(from.id);

  if (!store.users[userId]) {
    store.users[userId] = {
      id: userId,
      telegramId: from.id,
      username: from.username || '',
      telegramName: buildDisplayName(from),
      phone: '',
      fullName: '',
      step: USER_STEPS.IDLE,
      activeApplicationId: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  } else {
    store.users[userId].username = from.username || store.users[userId].username || '';
    store.users[userId].telegramName = buildDisplayName(from);
    store.users[userId].updatedAt = nowIso();
  }

  return store.users[userId];
}

function getUserRecord(userId) {
  return getStore().users[String(userId)] || null;
}

function getApplication(applicationId) {
  return getStore().applications[applicationId] || null;
}

function getActiveApplicationForUser(user) {
  if (!user?.activeApplicationId) {
    return null;
  }

  return getApplication(user.activeApplicationId);
}

function nextApplicationId(store) {
  store.meta.lastSequence += 1;
  return `APP${String(store.meta.lastSequence).padStart(4, '0')}`;
}

function createDraftApplication(store, from) {
  const user = ensureUserRecord(store, from);
  const existing = getActiveApplicationForUser(user);

  if (existing && !FINAL_STATUSES.has(existing.status)) {
    return existing;
  }

  const id = nextApplicationId(store);
  const application = {
    id,
    userId: String(from.id),
    telegramUser: {
      id: from.id,
      username: from.username || '',
      telegramName: buildDisplayName(from),
    },
    phone: '',
    fullName: '',
    article: null,
    receipt: null,
    certificate: null,
    status: APPLICATION_STATUS.DRAFT,
    pendingAdmin: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  store.applications[id] = application;
  user.activeApplicationId = id;
  user.updatedAt = nowIso();
  return application;
}

function getAdminState() {
  return getStore().adminStates[String(config.adminId)] || null;
}

async function setAdminState(state) {
  await updateStore((store) => {
    if (state) {
      store.adminStates[String(config.adminId)] = state;
    } else {
      delete store.adminStates[String(config.adminId)];
    }
  });
}

function adminMenuKeyboard() {
  return Markup.keyboard([
    [ADMIN_BUTTONS.PENDING, ADMIN_BUTTONS.CERTIFICATES],
    [ADMIN_BUTTONS.SETTINGS, ADMIN_BUTTONS.CANCEL],
  ]).resize();
}

function adminBackKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Orqaga', 'menu:admin')],
  ]);
}

function paymentSettingsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Karta', 'set:paymentCard'),
      Markup.button.callback('Karta egasi', 'set:paymentOwner'),
    ],
    [
      Markup.button.callback('Narx', 'set:paymentAmount'),
      Markup.button.callback('Yangilash', 'set:refresh'),
    ],
    [Markup.button.callback('Panelga qaytish', 'menu:admin')],
  ]);
}

function getAdminStateLabel(adminState) {
  if (!adminState) {
    return 'bo\'sh';
  }

  if (adminState.mode === ADMIN_STATE.SUBMISSION_REJECT_REASON) {
    return `${adminState.applicationId} uchun rad etish sababi kutilmoqda`;
  }

  if (adminState.mode === ADMIN_STATE.RECEIPT_REJECT_REASON) {
    return `${adminState.applicationId} uchun chek rad sababi kutilmoqda`;
  }

  if (adminState.mode === ADMIN_STATE.AWAITING_CERTIFICATE_PDF) {
    return `${adminState.applicationId} uchun PDF sertifikat kutilmoqda`;
  }

  if (adminState.mode === ADMIN_STATE.SETTINGS_EDIT) {
    const label = {
      paymentCard: 'karta raqami',
      paymentOwner: 'karta egasi',
      paymentAmount: 'narx',
    }[adminState.field] || 'sozlama';

    return `${label} uchun yangi qiymat kutilmoqda`;
  }

  return adminState.mode;
}

function buildPaymentSettingsText() {
  const payment = getPaymentSettings();

  return [
    'To\'lov sozlamalari',
    '',
    `Karta: ${payment.paymentCard || '-'}`,
    `Karta egasi: ${payment.paymentOwner || '-'}`,
    `Narx: ${payment.paymentAmount || '-'}`,
  ].join('\n');
}

function buildUserStatusText(user) {
  const application = getActiveApplicationForUser(user);

  if (!application) {
    return 'Faol ariza yo\'q. Yangi ariza yuborish uchun /start bosing.';
  }

  const label = {
    [APPLICATION_STATUS.DRAFT]: 'Ariza to\'ldirilmoqda',
    [APPLICATION_STATUS.PENDING_REVIEW]: 'Maqola tekshirilmoqda',
    [APPLICATION_STATUS.AWAITING_RECEIPT]: 'To\'lov kutilmoqda',
    [APPLICATION_STATUS.PENDING_RECEIPT_REVIEW]: 'Chek tekshirilmoqda',
    [APPLICATION_STATUS.AWAITING_CERTIFICATE]: 'Sertifikat kutilmoqda',
    [APPLICATION_STATUS.CERTIFICATE_SENT]: 'Sertifikat yuborilgan',
    [APPLICATION_STATUS.REJECTED]: 'Ariza rad etilgan',
  }[application.status] || application.status;

  return [
    `ID: ${application.id}`,
    `Holat: ${label}`,
    `F.I.O.: ${application.fullName || '-'}`,
  ].join('\n');
}

async function showAdminPanel(ctx, extraText = '') {
  const lines = ['Admin panel tayyor.'];

  if (extraText) {
    lines.push('', extraText);
  }

  lines.push('', `Joriy holat: ${getAdminStateLabel(getAdminState())}`);
  await ctx.reply(lines.join('\n'), adminMenuKeyboard());
}

function contactKeyboard() {
  return Markup.keyboard([
    [Markup.button.contactRequest('Kontakt yuborish')],
  ])
    .resize()
    .oneTime();
}

function userMenuKeyboard() {
  return Markup.keyboard([
    [USER_BUTTONS.START, USER_BUTTONS.STATUS],
  ]).resize();
}

function submissionKeyboard(applicationId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Qabul qilish', `sub:ok:${applicationId}`),
      Markup.button.callback('Rad etish', `sub:no:${applicationId}`),
    ],
  ]);
}

function receiptKeyboard(applicationId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Chek qabul', `rec:ok:${applicationId}`),
      Markup.button.callback('Chek rad', `rec:no:${applicationId}`),
    ],
  ]);
}

function certificateKeyboard(applicationId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Sertifikat yuborish', `cert:ask:${applicationId}`)],
  ]);
}

function buildPaymentMessage() {
  const payment = getPaymentSettings();
  const lines = [
    'Arizangiz qabul qilindi.',
    '',
    'To\'lov ma\'lumotlari:',
  ];

  if (payment.paymentCard) {
    lines.push(`Karta: ${payment.paymentCard}`);
  }

  if (payment.paymentOwner) {
    lines.push(`Karta egasi: ${payment.paymentOwner}`);
  }

  if (payment.paymentAmount) {
    lines.push(`Narx: ${payment.paymentAmount}`);
  }

  if (payment.paymentNote) {
    lines.push(`Izoh: ${payment.paymentNote}`);
  }

  if (!payment.paymentCard && !payment.paymentOwner && !payment.paymentAmount && !payment.paymentNote) {
    lines.push('To\'lov ma\'lumotlari hali konfiguratsiyada to\'ldirilmagan.');
  }

  lines.push('');
  lines.push('To\'lov qilganingizdan keyin chekni shu botga yuboring.');

  return lines.join('\n');
}

function describeStoredMessage(payload) {
  if (!payload) {
    return 'Yuborilmagan';
  }

  if (payload.kind === 'text') {
    return truncate(payload.preview || payload.text || '', 140);
  }

  if (payload.kind === 'document') {
    return payload.fileName || 'Document';
  }

  if (payload.kind === 'photo') {
    return payload.caption ? `Rasm: ${truncate(payload.caption, 120)}` : 'Rasm';
  }

  return payload.kind;
}

function trimCaption(text, maxLength = 950) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function buildSubmissionSummary(application, reminder = false) {
  const title = reminder ? 'Eslatma: maqola ko\'rigi kutilmoqda' : 'Yangi maqola arizasi';
  const details = [
    title,
    `ID: ${application.id}`,
    `F.I.O.: ${application.fullName}`,
    `Telefon: ${application.phone}`,
    `Telegram: ${application.telegramUser.telegramName}`,
    `Username: ${application.telegramUser.username || '-'}`,
    `User ID: ${application.userId}`,
    `Maqola: ${describeStoredMessage(application.article)}`,
    `Yuborilgan vaqt: ${application.article?.createdAt || application.createdAt}`,
  ];

  if (application.article?.caption) {
    details.push('', `User izohi: ${application.article.caption}`);
  }

  return trimCaption(details.join('\n'));
}

function buildSubmissionTextMessage(application, reminder = false) {
  const summary = buildSubmissionSummary(application, reminder);

  if (application.article?.kind === 'text' && application.article.text) {
    return `${summary}\n\nMaqola matni:\n${truncate(application.article.text, 2500)}`;
  }

  return summary;
}

function buildReceiptSummary(application, reminder = false) {
  const title = reminder ? 'Eslatma: chek tekshiruvi kutilmoqda' : 'Yangi chek qabul qilindi';
  const details = [
    title,
    `ID: ${application.id}`,
    `F.I.O.: ${application.fullName}`,
    `Telefon: ${application.phone}`,
    `Telegram: ${application.telegramUser.telegramName}`,
    `Username: ${application.telegramUser.username || '-'}`,
    `User ID: ${application.userId}`,
    `Chek: ${describeStoredMessage(application.receipt)}`,
    `Yuborilgan vaqt: ${application.receipt?.createdAt || application.updatedAt}`,
  ];

  if (application.receipt?.caption) {
    details.push('', `User izohi: ${application.receipt.caption}`);
  }

  return trimCaption(details.join('\n'));
}

function buildPendingList() {
  const applications = Object.values(getStore().applications);
  const pending = applications.filter((application) => [
    APPLICATION_STATUS.PENDING_REVIEW,
    APPLICATION_STATUS.PENDING_RECEIPT_REVIEW,
    APPLICATION_STATUS.AWAITING_CERTIFICATE,
  ].includes(application.status));

  if (pending.length === 0) {
    return 'Pending arizalar yo\'q.';
  }

  return pending
    .map((application) => {
      const label = {
        [APPLICATION_STATUS.PENDING_REVIEW]: 'maqola ko\'rigi',
        [APPLICATION_STATUS.PENDING_RECEIPT_REVIEW]: 'chek ko\'rigi',
        [APPLICATION_STATUS.AWAITING_CERTIFICATE]: 'sertifikat kutilmoqda',
      }[application.status];

      return `${application.id} | ${application.fullName} | ${label} | ${application.phone}`;
    })
    .join('\n');
}

async function showPendingApplications(ctx) {
  const pending = Object.values(getStore().applications).filter((application) => [
    APPLICATION_STATUS.PENDING_REVIEW,
    APPLICATION_STATUS.PENDING_RECEIPT_REVIEW,
  ].includes(application.status));

  if (pending.length === 0) {
    await ctx.reply('Pending arizalar yo\'q.', adminMenuKeyboard());
    return;
  }

  await ctx.reply(`Pending arizalar soni: ${pending.length}`, adminMenuKeyboard());

  for (const application of pending) {
    if (application.status === APPLICATION_STATUS.PENDING_REVIEW) {
      await ctx.reply(buildSubmissionTextMessage(application, true), submissionKeyboard(application.id));
      continue;
    }

    await ctx.reply(buildReceiptSummary(application, true), receiptKeyboard(application.id));
  }
}

async function showAwaitingCertificateApplications(ctx) {
  const pending = Object.values(getStore().applications).filter(
    (application) => application.status === APPLICATION_STATUS.AWAITING_CERTIFICATE,
  );

  if (pending.length === 0) {
    await ctx.reply('Sertifikat kutayotgan arizalar yo\'q.', adminMenuKeyboard());
    return;
  }

  await ctx.reply(`Sertifikat kutayotganlar: ${pending.length}`, adminMenuKeyboard());

  for (const application of pending) {
    await ctx.reply(
      [
        'Sertifikat yuborish navbati',
        `ID: ${application.id}`,
        `F.I.O.: ${application.fullName}`,
        `Telefon: ${application.phone}`,
        `Telegram: ${application.telegramUser.telegramName}`,
      ].join('\n'),
      certificateKeyboard(application.id),
    );
  }
}

function buildMessagePayload(ctx) {
  const message = ctx.message;

  if (message.text) {
    return {
      kind: 'text',
      chatId: ctx.chat.id,
      messageId: message.message_id,
      text: message.text,
      preview: truncate(message.text, 600),
      createdAt: nowIso(),
    };
  }

  if (message.document) {
    return {
      kind: 'document',
      chatId: ctx.chat.id,
      messageId: message.message_id,
      fileId: message.document.file_id,
      fileName: message.document.file_name || '',
      mimeType: message.document.mime_type || '',
      caption: message.caption || '',
      preview: truncate(message.caption || message.document.file_name || 'Document', 600),
      createdAt: nowIso(),
    };
  }

  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      chatId: ctx.chat.id,
      messageId: message.message_id,
      fileId: photo.file_id,
      caption: message.caption || '',
      preview: truncate(message.caption || 'Photo', 600),
      createdAt: nowIso(),
    };
  }

  return null;
}

function minutesSince(isoDate) {
  const timestamp = new Date(isoDate).getTime();
  return Math.floor((Date.now() - timestamp) / 60000);
}

async function clearButtons(ctx) {
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (error) {
    // Ignore stale edit failures.
  }
}

async function notifyAdminSubmission(bot, application, reminder = false) {
  if (!reminder && ['photo', 'document'].includes(application.article?.kind)) {
    await bot.telegram.copyMessage(config.adminId, application.article.chatId, application.article.messageId, {
      caption: buildSubmissionSummary(application, false),
      ...submissionKeyboard(application.id),
    });
    return;
  }

  await bot.telegram.sendMessage(config.adminId, buildSubmissionTextMessage(application, reminder), submissionKeyboard(application.id));
}

async function notifyAdminReceipt(bot, application, reminder = false) {
  if (!reminder && ['photo', 'document'].includes(application.receipt?.kind)) {
    await bot.telegram.copyMessage(config.adminId, application.receipt.chatId, application.receipt.messageId, {
      caption: buildReceiptSummary(application, false),
      ...receiptKeyboard(application.id),
    });
    return;
  }

  await bot.telegram.sendMessage(config.adminId, buildReceiptSummary(application, reminder), receiptKeyboard(application.id));
}

async function handleStart(ctx) {
  if (isAdmin(ctx)) {
    await showAdminPanel(ctx);
    return;
  }

  const user = await updateStore((store) => {
    const record = ensureUserRecord(store, ctx.from);
    const active = record.activeApplicationId ? store.applications[record.activeApplicationId] : null;

    if (active && FINAL_STATUSES.has(active.status)) {
      record.activeApplicationId = '';
    }

    if (!record.activeApplicationId) {
      record.step = USER_STEPS.AWAITING_CONTACT;
    }

    record.updatedAt = nowIso();
    return record;
  });

  const activeApplication = getActiveApplicationForUser(user);

  if (activeApplication && !FINAL_STATUSES.has(activeApplication.status)) {
    if (activeApplication.status === APPLICATION_STATUS.DRAFT) {
      if (user.step === USER_STEPS.AWAITING_FULL_NAME) {
        await ctx.reply('Kontakt qabul qilingan. Endi ism familiya sharifingizni yuboring.', userMenuKeyboard());
        return;
      }

      if (user.step === USER_STEPS.AWAITING_ARTICLE) {
        await ctx.reply('Maqolangizni yuboring.\nMatn, rasm yoki fayl ko\'rinishida yuborishingiz mumkin.', userMenuKeyboard());
        return;
      }

      await ctx.reply('Arizangiz tugallanmagan. Davom etish uchun kontakt yuboring.', contactKeyboard());
      return;
    }

    const resumeText = {
      [APPLICATION_STATUS.PENDING_REVIEW]: 'Maqolangiz qabul qilingan. Tekshiruv natijasini kuting.',
      [APPLICATION_STATUS.AWAITING_RECEIPT]: 'To\'lov ma\'lumotlari yuborilgan. Chekni shu botga yuboring.',
      [APPLICATION_STATUS.PENDING_RECEIPT_REVIEW]: 'Chekingiz tekshirilyapti. Iltimos kuting.',
      [APPLICATION_STATUS.AWAITING_CERTIFICATE]: 'To\'lov tasdiqlangan. Sertifikat tayyor bo\'lishini kuting.',
    }[activeApplication.status] || 'Joriy arizangiz mavjud.';

    await ctx.reply(resumeText, userMenuKeyboard());
    return;
  }

  await ctx.reply(
    'Assalomu alaykum.\nBu bot maqolani qabul qilish, tekshirish, to\'lovni tasdiqlash va sertifikat yuborish uchun ishlaydi.\n\nDavom etish uchun kontaktingizni yuboring.',
    contactKeyboard(),
  );
}

async function handleContact(ctx) {
  if (isAdmin(ctx)) {
    return;
  }

  const currentUser = getUserRecord(ctx.from.id);
  const currentApplication = currentUser ? getActiveApplicationForUser(currentUser) : null;

  if (
    currentApplication
    && currentApplication.status !== APPLICATION_STATUS.DRAFT
    && !FINAL_STATUSES.has(currentApplication.status)
  ) {
    await ctx.reply('Sizda allaqachon aktiv ariza bor. /start bosib joriy holatni ko\'ring.');
    return;
  }

  if (currentApplication?.status === APPLICATION_STATUS.DRAFT && currentUser?.step === USER_STEPS.AWAITING_ARTICLE) {
    await ctx.reply('Kontakt allaqachon qabul qilingan. Endi maqolangizni yuboring.');
    return;
  }

  const contact = ctx.message.contact;
  if (contact.user_id && contact.user_id !== ctx.from.id) {
    await ctx.reply('Faqat o\'zingizning kontaktingizni yuboring.');
    return;
  }

  await updateStore((store) => {
    const user = ensureUserRecord(store, ctx.from);
    const application = createDraftApplication(store, ctx.from);

    user.phone = contact.phone_number || '';
    user.step = USER_STEPS.AWAITING_FULL_NAME;
    user.activeApplicationId = application.id;
    user.updatedAt = nowIso();

    application.phone = contact.phone_number || '';
    application.updatedAt = nowIso();
  });

  await ctx.reply('Kontakt qabul qilindi.\nEndi ism familiya sharifingizni kiriting.', Markup.removeKeyboard());
}

async function handleFullName(ctx) {
  const fullName = ctx.message.text.trim();

  if (fullName.length < 5) {
    await ctx.reply('Iltimos, to\'liq ism familiya kiriting.');
    return;
  }

  await updateStore((store) => {
    const record = ensureUserRecord(store, ctx.from);
    const application = createDraftApplication(store, ctx.from);

    record.fullName = fullName;
    record.step = USER_STEPS.AWAITING_ARTICLE;
    record.activeApplicationId = application.id;
    record.updatedAt = nowIso();

    application.fullName = fullName;
    application.updatedAt = nowIso();
  });

  await ctx.reply('Maqolangizni yuboring.\nMatn, rasm yoki fayl ko\'rinishida yuborishingiz mumkin.', userMenuKeyboard());
}

async function handleArticleSubmission(ctx, bot) {
  const payload = buildMessagePayload(ctx);

  if (!payload) {
    await ctx.reply('Maqolani matn, rasm yoki fayl ko\'rinishida yuboring.');
    return;
  }

  let application;

  await updateStore((store) => {
    const user = ensureUserRecord(store, ctx.from);
    application = createDraftApplication(store, ctx.from);

    if (!application.phone || !application.fullName) {
      application.phone = user.phone;
      application.fullName = user.fullName;
    }

    application.article = payload;
    application.status = APPLICATION_STATUS.PENDING_REVIEW;
    application.pendingAdmin = {
      kind: 'submission',
      since: nowIso(),
      lastReminderAt: null,
    };
    application.updatedAt = nowIso();

    user.step = USER_STEPS.IDLE;
    user.updatedAt = nowIso();
  });

  await ctx.reply('Maqolangiz qabul qilindi.\n10-15 daqiqa kutib turing, tekshirib sizga javob beramiz.', userMenuKeyboard());
  await notifyAdminSubmission(bot, application, false);
}

async function handleReceiptSubmission(ctx, bot) {
  const payload = buildMessagePayload(ctx);

  if (!payload || !['document', 'photo'].includes(payload.kind)) {
    await ctx.reply('Chekni rasm yoki PDF/fayl ko\'rinishida yuboring.');
    return;
  }

  let application = null;
  await updateStore((store) => {
    const record = ensureUserRecord(store, ctx.from);
    const target = store.applications[record.activeApplicationId];

    if (!target || target.status !== APPLICATION_STATUS.AWAITING_RECEIPT) {
      return;
    }

    target.receipt = payload;
    target.status = APPLICATION_STATUS.PENDING_RECEIPT_REVIEW;
    target.pendingAdmin = {
      kind: 'receipt',
      since: nowIso(),
      lastReminderAt: null,
    };
    target.updatedAt = nowIso();

    record.step = USER_STEPS.IDLE;
    record.updatedAt = nowIso();
    application = target;
  });

  if (!application) {
    await ctx.reply('Faol to\'lov arizasi topilmadi. /start dan qayta boshlang.');
    return;
  }

  await ctx.reply('Chek qabul qilindi.\nAdmin tekshiradi, natijani sizga yuboramiz.', userMenuKeyboard());
  await notifyAdminReceipt(bot, application, false);
}

async function processUserText(ctx, bot) {
  const user = getUserRecord(ctx.from.id);

  if (ctx.message.text === USER_BUTTONS.START) {
    await handleStart(ctx);
    return;
  }

  if (!user) {
    await ctx.reply('Jarayonni boshlash uchun /start bosing.');
    return;
  }

  if (ctx.message.text === USER_BUTTONS.STATUS) {
    await ctx.reply(buildUserStatusText(user), userMenuKeyboard());
    return;
  }

  if (user.step === USER_STEPS.AWAITING_FULL_NAME) {
    await handleFullName(ctx);
    return;
  }

  if (user.step === USER_STEPS.AWAITING_ARTICLE) {
    await handleArticleSubmission(ctx, bot);
    return;
  }

  if (user.step === USER_STEPS.AWAITING_RECEIPT) {
    await ctx.reply('Hozir sizdan chek kutilmoqda. Chekni rasm yoki PDF qilib yuboring.');
    return;
  }

  await ctx.reply('Davom etish uchun /start buyrug\'ini bosing.');
}

async function processUserAttachment(ctx, bot) {
  const user = getUserRecord(ctx.from.id);

  if (!user) {
    await ctx.reply('Jarayonni boshlash uchun /start bosing.');
    return;
  }

  if (user.step === USER_STEPS.AWAITING_ARTICLE) {
    await handleArticleSubmission(ctx, bot);
    return;
  }

  if (user.step === USER_STEPS.AWAITING_RECEIPT) {
    await handleReceiptSubmission(ctx, bot);
    return;
  }

  await ctx.reply('Hozir bu fayl kutilmayapti. Jarayon uchun /start bosing.');
}

async function acceptSubmission(ctx, applicationId, bot) {
  const application = getApplication(applicationId);

  if (!application || application.status !== APPLICATION_STATUS.PENDING_REVIEW) {
    await ctx.answerCbQuery('Bu ariza allaqachon ko\'rib chiqilgan.');
    await clearButtons(ctx);
    return;
  }

  await updateStore((store) => {
    const target = store.applications[applicationId];
    const user = store.users[target.userId];

    target.status = APPLICATION_STATUS.AWAITING_RECEIPT;
    target.pendingAdmin = null;
    target.reviewDecision = {
      decision: 'accepted',
      at: nowIso(),
    };
    target.updatedAt = nowIso();

    if (user) {
      user.step = USER_STEPS.AWAITING_RECEIPT;
      user.updatedAt = nowIso();
    }
  });

  await bot.telegram.sendMessage(Number(application.userId), buildPaymentMessage(), userMenuKeyboard());
  await ctx.answerCbQuery('Ariza qabul qilindi.');
  await clearButtons(ctx);
  await ctx.reply(`${application.id} uchun to'lov ma'lumotlari userga yuborildi.`);
}

async function requestSubmissionRejectReason(ctx, applicationId) {
  const application = getApplication(applicationId);
  const activeState = getAdminState();

  if (!application || application.status !== APPLICATION_STATUS.PENDING_REVIEW) {
    await ctx.answerCbQuery('Bu ariza endi pending emas.');
    await clearButtons(ctx);
    return;
  }

  if (activeState) {
    await ctx.answerCbQuery('Avval joriy admin amalini tugating yoki bekor qiling.');
    return;
  }

  await setAdminState({
    mode: ADMIN_STATE.SUBMISSION_REJECT_REASON,
    applicationId,
  });

  await ctx.answerCbQuery('Rad etish sababi kutilmoqda.');
  await clearButtons(ctx);
  await ctx.reply(`${application.id} uchun rad etish sababini matn qilib yuboring. Bekor qilish: /canceladmin`);
}

async function finalizeSubmissionRejection(ctx, adminState, bot) {
  const reason = ctx.message.text.trim();
  const application = getApplication(adminState.applicationId);

  if (!application || application.status !== APPLICATION_STATUS.PENDING_REVIEW) {
    await setAdminState(null);
    await ctx.reply('Bu ariza endi pending emas.');
    return;
  }

  await updateStore((store) => {
    const target = store.applications[adminState.applicationId];
    const user = store.users[target.userId];

    target.status = APPLICATION_STATUS.REJECTED;
    target.pendingAdmin = null;
    target.reviewDecision = {
      decision: 'rejected',
      reason,
      at: nowIso(),
    };
    target.updatedAt = nowIso();

    if (user) {
      if (user.activeApplicationId === target.id) {
        user.activeApplicationId = '';
      }
      user.step = USER_STEPS.IDLE;
      user.updatedAt = nowIso();
    }
  });

  await setAdminState(null);
  await bot.telegram.sendMessage(Number(application.userId), `Afsuski, maqolangiz rad etildi.\nSabab: ${reason}`, userMenuKeyboard());
  await ctx.reply(`${application.id} rad etildi va userga xabar yuborildi.`);
}

async function acceptReceipt(ctx, applicationId, bot) {
  const application = getApplication(applicationId);

  if (!application || application.status !== APPLICATION_STATUS.PENDING_RECEIPT_REVIEW) {
    await ctx.answerCbQuery('Bu chek allaqachon ko\'rib chiqilgan.');
    await clearButtons(ctx);
    return;
  }

  await updateStore((store) => {
    const target = store.applications[applicationId];
    const user = store.users[target.userId];

    target.status = APPLICATION_STATUS.AWAITING_CERTIFICATE;
    target.pendingAdmin = null;
    target.paymentDecision = {
      decision: 'accepted',
      at: nowIso(),
    };
    target.updatedAt = nowIso();

    if (user) {
      user.step = USER_STEPS.IDLE;
      user.updatedAt = nowIso();
    }
  });

  await bot.telegram.sendMessage(Number(application.userId), 'Chekingiz qabul qilindi.\nEndi sertifikat tayyor bo\'lishini kuting.', userMenuKeyboard());
  await ctx.answerCbQuery('Chek qabul qilindi.');
  await clearButtons(ctx);
  await ctx.reply(`${application.id} uchun chek tasdiqlandi. Sertifikat yuborish uchun tugmani bosing.`, certificateKeyboard(applicationId));
}

async function requestReceiptRejectReason(ctx, applicationId) {
  const application = getApplication(applicationId);
  const activeState = getAdminState();

  if (!application || application.status !== APPLICATION_STATUS.PENDING_RECEIPT_REVIEW) {
    await ctx.answerCbQuery('Bu chek endi pending emas.');
    await clearButtons(ctx);
    return;
  }

  if (activeState) {
    await ctx.answerCbQuery('Avval joriy admin amalini tugating yoki bekor qiling.');
    return;
  }

  await setAdminState({
    mode: ADMIN_STATE.RECEIPT_REJECT_REASON,
    applicationId,
  });

  await ctx.answerCbQuery('Rad etish sababi kutilmoqda.');
  await clearButtons(ctx);
  await ctx.reply(`${application.id} uchun chekni rad etish sababini yuboring. Bekor qilish: /canceladmin`);
}

async function finalizeReceiptRejection(ctx, adminState, bot) {
  const reason = ctx.message.text.trim();
  const application = getApplication(adminState.applicationId);

  if (!application || application.status !== APPLICATION_STATUS.PENDING_RECEIPT_REVIEW) {
    await setAdminState(null);
    await ctx.reply('Bu chek endi pending emas.');
    return;
  }

  await updateStore((store) => {
    const target = store.applications[adminState.applicationId];
    const user = store.users[target.userId];

    target.status = APPLICATION_STATUS.AWAITING_RECEIPT;
    target.pendingAdmin = null;
    target.paymentDecision = {
      decision: 'rejected',
      reason,
      at: nowIso(),
    };
    target.updatedAt = nowIso();

    if (user) {
      user.step = USER_STEPS.AWAITING_RECEIPT;
      user.updatedAt = nowIso();
    }
  });

  await setAdminState(null);
  await bot.telegram.sendMessage(Number(application.userId), `Chekingiz rad etildi.\nSabab: ${reason}\nIltimos, yangi chek yuboring.`, userMenuKeyboard());
  await ctx.reply(`${application.id} uchun chek rad etildi va userdan qayta chek so'raldi.`);
}

async function showPaymentSettings(ctx) {
  await ctx.reply(buildPaymentSettingsText(), paymentSettingsKeyboard());
}

async function requestSettingsFieldEdit(ctx, field) {
  const activeState = getAdminState();
  if (activeState && activeState.mode !== ADMIN_STATE.SETTINGS_EDIT) {
    await ctx.answerCbQuery('Avval joriy amalni tugating yoki bekor qiling.');
    return;
  }

  const prompts = {
    paymentCard: 'Yangi karta raqamini yuboring.',
    paymentOwner: 'Yangi karta egasi nomini yuboring.',
    paymentAmount: 'Yangi narxni yuboring.',
  };

  await setAdminState({
    mode: ADMIN_STATE.SETTINGS_EDIT,
    field,
  });

  await ctx.answerCbQuery('Qiymat kutilmoqda.');
  await ctx.reply(`${prompts[field]}\nBekor qilish uchun "Bekor qilish" tugmasini bosing.`, adminMenuKeyboard());
}

async function finalizeSettingsEdit(ctx, adminState) {
  const value = ctx.message.text.trim();

  if (!value) {
    await ctx.reply('Bo\'sh qiymat yuborib bo\'lmaydi.');
    return;
  }

  if (adminState.field === 'paymentAmount' && !/^[\d\s.,]+$/.test(value)) {
    await ctx.reply('Narx uchun faqat raqam va oddiy ajratgichlardan foydalaning.');
    return;
  }

  await updatePaymentSetting(adminState.field, value);
  await setAdminState(null);
  await ctx.reply('To\'lov sozlamasi yangilandi.', adminMenuKeyboard());
  await showPaymentSettings(ctx);
}

async function prepareCertificateUpload(ctx, applicationId) {
  const application = getApplication(applicationId);
  const activeState = getAdminState();

  if (!application || application.status !== APPLICATION_STATUS.AWAITING_CERTIFICATE) {
    await ctx.answerCbQuery('Bu ariza hozir sertifikat kutish holatida emas.');
    await clearButtons(ctx);
    return;
  }

  if (activeState) {
    await ctx.answerCbQuery('Avval joriy admin amalini tugating yoki bekor qiling.');
    return;
  }

  await setAdminState({
    mode: ADMIN_STATE.AWAITING_CERTIFICATE_PDF,
    applicationId,
  });

  await ctx.answerCbQuery('PDF kutilmoqda.');
  await clearButtons(ctx);
  await ctx.reply(`${application.id} uchun PDF sertifikatni yuboring.`);
}

function isPdfDocument(message) {
  if (!message.document) {
    return false;
  }

  const name = (message.document.file_name || '').toLowerCase();
  const mimeType = (message.document.mime_type || '').toLowerCase();

  return mimeType === 'application/pdf' || name.endsWith('.pdf');
}

async function handleAdminDocument(ctx, adminState, bot) {
  if (adminState?.mode !== ADMIN_STATE.AWAITING_CERTIFICATE_PDF) {
    await ctx.reply('Bu fayl uchun aktiv admin jarayoni yo\'q. /pending bilan ID ni ko\'ring.');
    return;
  }

  if (!isPdfDocument(ctx.message)) {
    await ctx.reply('Iltimos, aynan PDF fayl yuboring.');
    return;
  }

  const application = getApplication(adminState.applicationId);

  if (!application || application.status !== APPLICATION_STATUS.AWAITING_CERTIFICATE) {
    await setAdminState(null);
    await ctx.reply('Bu ariza hozir sertifikat kutish holatida emas.');
    return;
  }

  await bot.telegram.sendDocument(Number(application.userId), ctx.message.document.file_id, {
    caption: `${application.fullName} uchun sertifikat tayyor bo'ldi.`,
  });
  await bot.telegram.sendMessage(Number(application.userId), 'Jarayon yakunlandi.', userMenuKeyboard());

  await updateStore((store) => {
    const target = store.applications[adminState.applicationId];
    const user = store.users[target.userId];

    target.status = APPLICATION_STATUS.CERTIFICATE_SENT;
    target.certificate = {
      kind: 'document',
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      fileId: ctx.message.document.file_id,
      fileName: ctx.message.document.file_name || '',
      mimeType: ctx.message.document.mime_type || '',
      createdAt: nowIso(),
    };
    target.updatedAt = nowIso();

    if (user) {
      if (user.activeApplicationId === target.id) {
        user.activeApplicationId = '';
      }
      user.step = USER_STEPS.IDLE;
      user.updatedAt = nowIso();
    }
  });

  await setAdminState(null);
  await ctx.reply(`${application.id} sertifikati userga yuborildi.`);
}

async function handleAdminText(ctx, bot) {
  const adminState = getAdminState();

  if (ctx.message.text === ADMIN_BUTTONS.CANCEL) {
    await setAdminState(null);
    await showAdminPanel(ctx, 'Admin kutish holati bekor qilindi.');
    return true;
  }

  if (ctx.message.text === ADMIN_BUTTONS.PANEL) {
    await showAdminPanel(ctx);
    return true;
  }

  if (ctx.message.text === ADMIN_BUTTONS.PENDING) {
    await showPendingApplications(ctx);
    return true;
  }

  if (ctx.message.text === ADMIN_BUTTONS.CERTIFICATES) {
    await showAwaitingCertificateApplications(ctx);
    return true;
  }

  if (ctx.message.text === ADMIN_BUTTONS.SETTINGS) {
    await showPaymentSettings(ctx);
    return true;
  }

  if (adminState?.mode === ADMIN_STATE.SUBMISSION_REJECT_REASON) {
    await finalizeSubmissionRejection(ctx, adminState, bot);
    return true;
  }

  if (adminState?.mode === ADMIN_STATE.RECEIPT_REJECT_REASON) {
    await finalizeReceiptRejection(ctx, adminState, bot);
    return true;
  }

  if (adminState?.mode === ADMIN_STATE.AWAITING_CERTIFICATE_PDF) {
    await ctx.reply('Hozir PDF sertifikat kutilmoqda. Bekor qilish uchun "Bekor qilish" tugmasini bosing.');
    return true;
  }

  if (adminState?.mode === ADMIN_STATE.SETTINGS_EDIT) {
    await finalizeSettingsEdit(ctx, adminState);
    return true;
  }

  return false;
}

async function handleAction(ctx, bot) {
  const [scope, decision, applicationId] = ctx.callbackQuery.data.split(':');

  if (scope === 'menu' && decision === 'admin') {
    await ctx.answerCbQuery();
    await showAdminPanel(ctx);
    return;
  }

  if (scope === 'set' && decision === 'refresh') {
    await ctx.answerCbQuery();
    await showPaymentSettings(ctx);
    return;
  }

  if (scope === 'set' && ['paymentCard', 'paymentOwner', 'paymentAmount'].includes(decision)) {
    await requestSettingsFieldEdit(ctx, decision);
    return;
  }

  if (scope === 'sub' && decision === 'ok') {
    await acceptSubmission(ctx, applicationId, bot);
    return;
  }

  if (scope === 'sub' && decision === 'no') {
    await requestSubmissionRejectReason(ctx, applicationId);
    return;
  }

  if (scope === 'rec' && decision === 'ok') {
    await acceptReceipt(ctx, applicationId, bot);
    return;
  }

  if (scope === 'rec' && decision === 'no') {
    await requestReceiptRejectReason(ctx, applicationId);
    return;
  }

  if (scope === 'cert' && decision === 'ask') {
    await prepareCertificateUpload(ctx, applicationId);
    return;
  }

  await ctx.answerCbQuery('Noma\'lum amal.');
}

async function sendReminders(bot) {
  const applications = Object.values(getStore().applications);
  const reminderTargets = applications.filter((application) => {
    if (!application.pendingAdmin) {
      return false;
    }

    const waitingLongEnough = minutesSince(application.pendingAdmin.since) >= config.reminderMinutes;
    const remindedLongAgo = !application.pendingAdmin.lastReminderAt
      || minutesSince(application.pendingAdmin.lastReminderAt) >= config.reminderMinutes;

    return waitingLongEnough && remindedLongAgo;
  });

  for (const application of reminderTargets) {
    if (application.pendingAdmin.kind === 'submission') {
      await notifyAdminSubmission(bot, application, true);
    }

    if (application.pendingAdmin.kind === 'receipt') {
      await notifyAdminReceipt(bot, application, true);
    }

    await updateStore((store) => {
      const target = store.applications[application.id];
      if (target?.pendingAdmin) {
        target.pendingAdmin.lastReminderAt = nowIso();
        target.updatedAt = nowIso();
      }
    });
  }
}

const bot = new Telegraf(config.botToken);

bot.start(async (ctx) => {
  await handleStart(ctx);
});

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  await showPendingApplications(ctx);
});

bot.command('canceladmin', async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  await setAdminState(null);
  await showAdminPanel(ctx, 'Adminning kutish holati bekor qilindi.');
});

bot.command('certificate', async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  const [, applicationId] = ctx.message.text.trim().split(/\s+/);

  if (!applicationId) {
    await ctx.reply('Foydalanish: /certificate APP0001');
    return;
  }

  const application = getApplication(applicationId);

  if (!application) {
    await ctx.reply('Bunday ID topilmadi.');
    return;
  }

  if (application.status !== APPLICATION_STATUS.AWAITING_CERTIFICATE) {
    await ctx.reply('Bu ariza sertifikat kutish holatida emas.');
    return;
  }

  await setAdminState({
    mode: ADMIN_STATE.AWAITING_CERTIFICATE_PDF,
    applicationId,
  });

  await ctx.reply(`${applicationId} uchun PDF sertifikat yuboring.`, adminMenuKeyboard());
});

bot.on('contact', async (ctx) => {
  await handleContact(ctx);
});

bot.on('callback_query', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Faqat admin uchun.');
    return;
  }

  await handleAction(ctx, bot);
});

bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) {
    return;
  }

  if (isAdmin(ctx)) {
    const handled = await handleAdminText(ctx, bot);
    if (!handled) {
      await ctx.reply('Admin matn rejimi yo\'q. /pending yoki inline tugmalardan foydalaning.');
    }
    return;
  }

  await processUserText(ctx, bot);
});

bot.on('document', async (ctx) => {
  if (isAdmin(ctx)) {
    await handleAdminDocument(ctx, getAdminState(), bot);
    return;
  }

  await processUserAttachment(ctx, bot);
});

bot.on('photo', async (ctx) => {
  if (isAdmin(ctx)) {
    await ctx.reply('Admin uchun rasm emas, PDF sertifikat kutiladi.');
    return;
  }

  await processUserAttachment(ctx, bot);
});

bot.on('message', async (ctx) => {
  const unsupported = ['voice', 'video', 'sticker', 'audio'];
  if (unsupported.some((type) => ctx.message[type])) {
    if (isAdmin(ctx)) {
      await ctx.reply('Bu format hozir qo\'llab-quvvatlanmaydi.');
      return;
    }

    await ctx.reply('Bu format hozir qo\'llab-quvvatlanmaydi. Matn, rasm yoki fayl yuboring.');
  }
});

bot.catch((error, ctx) => {
  console.error('Bot error:', error);

  if (ctx?.chat?.id) {
    ctx.reply('Xatolik yuz berdi. Keyinroq qayta urinib ko\'ring.').catch(() => null);
  }
});

async function bootstrap() {
  validateConfig();
  await initStorage(config.dataFile);
  await seedPaymentSettings();
  await bot.launch();
  setInterval(() => {
    sendReminders(bot).catch((error) => console.error('Reminder error:', error));
  }, 60 * 1000);
  console.log('Bot ishga tushdi.');
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
