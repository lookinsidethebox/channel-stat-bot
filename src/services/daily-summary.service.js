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

function scheduledAt(date) {
  const wallTime = Date.parse(`${date}T11:00:00.000Z`);
  let instant = wallTime;
  for (let pass = 0; pass < 3; pass++) {
    const p = partsAt(new Date(instant));
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
    instant = wallTime - offset;
  }
  return new Date(instant).toISOString();
}

function reportWindow(now) {
  const p = partsAt(now);
  let date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (Date.parse(scheduledAt(date)) > now.getTime()) date = shiftDate(date, -1);
  return { date, periodStart: scheduledAt(shiftDate(date, -1)), periodEnd: scheduledAt(date),
    nextAt: scheduledAt(shiftDate(date, 1)) };
}

const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function formatCounter(value, previous, isNew) {
  if (value === null) return 'нет данных';
  const baseline = previous ?? (isNew ? 0 : null);
  if (baseline === null) return `${value} (нет данных за вчера)`;
  const delta = value - baseline;
  return `${value} (${delta > 0 ? '+' : ''}${delta})`;
}

function formatDailySummary({ membership, posts, periodStart, channelId }, previousPosts = []) {
  const lines = ['<b>📈 Статистика за сутки</b>', '',
    `Пользователей добавилось на канал: ${membership.joined}`,
    `Пользователей отписалось: ${membership.left}`, '',
    '<b>Информация по трем последним постам</b>'];
  for (const post of posts) {
    const previous = previousPosts.find(entry => entry.messageId === post.messageId);
    const isNew = Date.parse(post.postedAt) >= Date.parse(periodStart);
    const link = `https://t.me/c/${-Number(channelId) - 1000000000000}/${post.messageId}`;
    lines.push('', `Пост: ${escapeHtml(post.preview || 'Пост без текста')} ${link}`,
      `Количество просмотров: ${formatCounter(post.views, previous?.views, isNew)}`,
      `Количество реакций: ${formatCounter(post.reactions, previous?.reactions, isNew)}`,
      `Количество репостов: ${formatCounter(post.forwards, previous?.forwards, isNew)}`);
  }
  if (!posts.length) lines.push('', 'На канале пока нет постов.');
  return lines.join('\n');
}

module.exports = { TIME_ZONE, reportWindow, scheduledAt, shiftDate, formatDailySummary };
