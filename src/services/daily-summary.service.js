const TIME_ZONE = 'Europe/Podgorica';
const localParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function partsAt(date) {
  return Object.fromEntries(localParts.formatToParts(date).filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localTimeAt(date, hour) {
  const wallTime = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  let instant = wallTime;
  for (let pass = 0; pass < 3; pass++) {
    const p = partsAt(new Date(instant));
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
    instant = wallTime - offset;
  }
  return new Date(instant).toISOString();
}

function localDate(now) {
  const p = partsAt(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const scheduledAt = date => localTimeAt(date, 11);

function calendarWindow(date) {
  // Telegram statistics days are UTC; Podgorica only controls delivery time.
  return { date, periodStart: `${date}T00:00:00.000Z`, periodEnd: `${shiftDate(date, 1)}T00:00:00.000Z`,
    previousPeriodStart: `${shiftDate(date, -1)}T00:00:00.000Z`, sendAt: scheduledAt(shiftDate(date, 1)) };
}

function reportWindow(now) {
  const today = localDate(now);
  return { ...calendarWindow(shiftDate(now.toISOString().slice(0, 10), -1)),
    nextAt: scheduledAt(Date.parse(scheduledAt(today)) > now.getTime() ? today : shiftDate(today, 1)) };
}

function dueReportWindow(now) {
  const window = reportWindow(now);
  return Date.parse(window.sendAt) <= now.getTime() ? window
    : { ...calendarWindow(shiftDate(window.date, -1)), nextAt: window.nextAt };
}

const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function formatCounter(value, previous, isNew) {
  if (value == null) return 'нет данных';
  const baseline = previous ?? (isNew ? 0 : null);
  if (baseline === null) return `<b>${value}</b> (нет данных за вчера)`;
  const delta = value - baseline;
  return `<b>${value} (${delta > 0 ? '+' : ''}${delta})</b>`;
}

function formatDailySummary({ date, membership, subscriberCount, posts, periodStart, channelId, previousPosts = [] }) {
  const displayDate = date.split('-').reverse().join('.');
  const lines = [`<b>📈 Статистика за ${escapeHtml(displayDate)}</b>`, '',
    `Пользователей добавилось на канал: <b>${membership.joined}</b>`,
    `Пользователей отписалось: <b>${membership.left}</b>`,
    `Общее число подписчиков: <b>${subscriberCount ?? 'нет данных'}</b>`, '',
    '<b>Информация по пяти последним постам</b>'];
  for (const post of posts) {
    const previous = previousPosts.find(entry => entry.messageId === post.messageId);
    const isNew = Date.parse(post.postedAt) >= Date.parse(periodStart);
    const link = `https://t.me/c/${-Number(channelId) - 1000000000000}/${post.messageId}`;
    lines.push('', `<b>Пост:</b> ${escapeHtml(post.preview || 'Пост без текста')} ${link}`,
      `Количество просмотров: ${formatCounter(post.views, previous?.views, isNew)}`,
      `Количество реакций: ${post.reactionPeriod === 'current' && post.reactions != null
        ? `<b>${post.reactions}</b> (сейчас; нет данных за сутки)`
        : formatCounter(post.reactions, previous?.reactions, isNew)}`,
      `Количество репостов: ${formatCounter(post.forwards, previous?.forwards, isNew)}`);
  }
  if (!posts.length) lines.push('', 'На канале пока нет постов.');
  return lines.join('\n');
}

module.exports = { TIME_ZONE, reportWindow, dueReportWindow, calendarWindow, scheduledAt, shiftDate, formatDailySummary };
