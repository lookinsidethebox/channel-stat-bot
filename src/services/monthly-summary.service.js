const { localDate, localTimeAt, escapeHtml } = require('./daily-summary.service');
const { SOURCE_NAMES } = require('./source-statistics.service');

function monthWindow(now, offset = 0) {
  const today = localDate(now);
  const [year, month] = today.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 + offset, 1));
  const end = new Date(Date.UTC(year, month + offset, 1));
  const date = start.toISOString().slice(0, 7);
  return { date, periodStart: start.toISOString(), periodEnd: end.toISOString(),
    sendAt: localTimeAt(end.toISOString().slice(0, 10), 8) };
}

const labels = { ...Object.fromEntries(Object.entries(SOURCE_NAMES).map(([name, type]) => [type, name])),
  invite_link: 'Пригласительная ссылка', join_request: 'Заявка на вступление', unknown: 'Неизвестно' };
const categories = [
  ['views', 'просмотров'], ['reactions', 'реакций'], ['forwards', 'репостов'], ['comments', 'комментариев'],
];

function bestPost(posts, field) {
  return posts.filter(post => Number.isSafeInteger(post[field]))
    .sort((a, b) => b[field] - a[field] || a.messageId - b.messageId)[0];
}

function formatMonthlySummary({ date, membership, posts, channelId }) {
  const [year, month] = date.split('-');
  const lines = [`<b>📈 Статистика за ${month}.${year}</b>`, '',
    `Пользователей добавилось на канал: <b>${membership.joined}</b>`,
    `Пользователей отписалось: <b>${membership.left}</b>`, '', '<b>Откуда приходили пользователи:</b>'];
  const sources = Object.entries(membership.sources).filter(([, count]) => count > 0)
    .sort(([a], [b]) => (labels[a] || a).localeCompare(labels[b] || b, 'ru'));
  for (const [source, count] of sources) lines.push(`${escapeHtml(labels[source] || source)}: <b>${count}</b>`);
  if (!sources.length) lines.push('Новых пользователей не было.');
  for (const [title, campaigns] of [['URL', membership.urlCampaigns], ['Ads', membership.adsCampaigns]]) {
    const entries = campaigns.filter(campaign => campaign.count > 0)
      .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    if (!entries.length) continue;
    lines.push('', `<b>Кампании ${title}:</b>`);
    for (const { title: name, count } of entries) lines.push(`${escapeHtml(name)}: <b>${count}</b>`);
  }
  for (const [field, caption] of categories) {
    lines.push('', `<b>Лучший пост по количеству ${caption}:</b>`);
    const post = bestPost(posts, field);
    if (!post) { lines.push('Нет данных о постах за этот месяц.'); continue; }
    const link = `https://t.me/c/${-Number(channelId) - 1000000000000}/${post.messageId}`;
    const dateText = localDate(new Date(post.postedAt)).split('-').reverse().join('.');
    lines.push(`<b>Пост:</b> ${escapeHtml(post.preview || 'Пост без текста')} ${link}`,
      `Количество просмотров: <b>${post.views ?? 'нет данных'}</b>`,
      `Количество реакций: <b>${post.reactions ?? 'нет данных'}</b>`,
      `Количество репостов: <b>${post.forwards ?? 'нет данных'}</b>`,
      `Количество комментариев: <b>${post.comments ?? 'нет данных'}</b>`,
      `Дата публикации: <b>${dateText}</b>`);
  }
  return lines.join('\n');
}

async function buildMonthlyReport({ channelId, reader, memberStore, beforeReport = async () => {}, window }) {
  const snapshot = await reader.fetchMonthlyPosts(window);
  if (snapshot.channelId !== channelId) throw new Error('MONTHLY_SUMMARY_CHANNEL_MISMATCH');
  await beforeReport();
  const membership = await memberStore.summarizePeriod(window.periodStart, window.periodEnd);
  return { ...window, channelId, membership, posts: snapshot.posts, fetchedAt: snapshot.fetchedAt };
}

function createMonthlyReporter({ channelId, reader, memberStore, summaryStore, beforeReport, now = () => new Date() }) {
  return async offset => {
    const window = monthWindow(now(), offset);
    const state = await summaryStore.getState();
    if (state.channelId !== channelId) throw new Error('MONTHLY_SUMMARY_CHANNEL_MISMATCH');
    const saved = offset === -1 && state.reports[window.date];
    if (saved) return saved.text;
    return formatMonthlySummary(await buildMonthlyReport({ channelId, reader, memberStore, beforeReport, window }));
  };
}

module.exports = { monthWindow, formatMonthlySummary, buildMonthlyReport, createMonthlyReporter };
