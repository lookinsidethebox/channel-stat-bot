const { SOURCE_NAMES, membershipKey } = require('./source-statistics.service');

const sourceLabels = {
  ...Object.fromEntries(Object.entries(SOURCE_NAMES).map(([name, type]) => [type, name])),
  invite_link: 'Пригласительная ссылка',
  join_request: 'Заявка на вступление',
};

const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Podgorica', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function formatDateTime(value) {
  return value && Number.isFinite(Date.parse(value))
    ? dateTimeFormat.format(new Date(value)).replace(', ', ' ')
    : 'нет данных';
}

function formatMemberName(member) {
  const name = member.name || 'Без имени';
  const username = member.username ? ` (@${member.username})` : '';
  return `${name}${username}`;
}

function formatMemberSource(member) {
  const source = sourceLabels[member.source?.type] || 'Неизвестно';
  const campaign = member.source?.type === 'ads'
    ? ` (${member.adsCampaign?.title || 'кампания неизвестна'})`
    : member.source?.type === 'url' && member.urlCampaign?.title ? ` (${member.urlCampaign.title})` : '';
  return `${source}${campaign}`;
}

function formatJoinNotification(member, history = [], chat = {}) {
  const headline = member.returned
    ? '🎉 На канале пользователь-возвращенец!'
    : '🎉 На канале новый пользователь!';
  const introduction = `${headline}\nИмя: ${formatMemberName(member)}\nИсточник: ${formatMemberSource(member)}`;
  if (!member.returned) return introduction;
  const periods = history.map(previous => [
    `Добавился: ${formatDateTime(previous.addedAt)}`,
    `Источник: ${formatMemberSource(previous)}`,
    `Пришел из-за поста: ${formatPost(previous.postAtAddition, chat)}`,
    `Удалился: ${formatDateTime(previous.removedAt)}`,
    `Удалился из-за поста: ${formatPost(previous.postAtRemoval, chat)}`,
    `Сколько дней провел на канале: ${formatDays(previous)}`,
  ].join('\n'));
  return `${introduction}\n\nИнформация о прошлых добавлениях:\n\n${periods.join('\n\n') || 'нет данных'}`;
}

function postLink(chat, messageId) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  // Message links use MTProto channel IDs, not Bot API dialog IDs.
  const channelId = -Number(chat.id) - 1000000000000;
  return Number.isSafeInteger(channelId) && channelId > 0
    ? `https://t.me/c/${channelId}/${messageId}`
    : null;
}

function formatPost(post, chat) {
  if (!post) return 'нет данных';
  const preview = Array.from(post.preview || 'Пост без текста').slice(0, 100).join('');
  const link = postLink(chat, post.messageId);
  return `${preview}${link ? ` ${link}` : ''}`;
}

function formatDays(member) {
  const elapsed = Date.parse(member.removedAt) - Date.parse(member.addedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'нет данных';
  const days = Math.floor(elapsed / 86400000);
  return days === 0 ? 'меньше 1' : String(days);
}

function formatLeaveNotification(member, chat) {
  const lines = ['👎 Подписчик покинул канал! Да и хуй с ним.', '', `Имя: ${formatMemberName(member)}`];
  if (!member.addedAt) return lines.join('\n');

  lines.push(
    `Источник: ${formatMemberSource(member)}`,
    `С какого поста подписался: ${formatPost(member.postAtAddition, chat)}`,
    `Сколько дней провел на канале: ${formatDays(member)}`,
  );
  return lines.join('\n');
}

function formatImmediateJoinNotification(member, history, chat) {
  if (!member.returned) return `🎉 На канале новый пользователь – ${formatMemberName(member)}`;
  const previous = formatJoinNotification(member, history, chat);
  return previous.replace(/^🎉 На канале пользователь-возвращенец!\nИмя: [^\n]+\nИсточник: [^\n]+/u,
    `🎉 На канале пользователь-возвращенец – ${formatMemberName(member)}`);
}

function formatSourceNotification(member, unknown = false) {
  const source = member.source?.type === 'ads' && member.adsCampaign?.status === 'pending'
    ? 'Ads' : formatMemberSource(member);
  const message = `Обновилась информация о том, откуда пришел пользователь ${formatMemberName(member)}: ${source}`;
  return unknown ? `${message}\nИсточник не удалось определить. Ответь на это сообщение: URL, Ads, Search, PM или Chat Folder.` : message;
}

function splitNotification(text) {
  const messages = [];
  let current = '';
  // Prefer whole history entries. Fall back to lines, then Unicode code points.
  for (const paragraph of text.split('\n\n')) {
    if (current && current.length + 2 + paragraph.length <= 4096) {
      current += `\n\n${paragraph}`;
      continue;
    }
    if (current) messages.push(current);
    current = '';
    for (const line of paragraph.split('\n')) {
      if (current && current.length + 1 + line.length <= 4096) {
        current += `\n${line}`;
        continue;
      }
      if (current) messages.push(current);
      current = '';
      for (const character of line) {
        if (current.length + character.length > 4096) {
          messages.push(current);
          current = '';
        }
        current += character;
      }
    }
  }
  if (current) messages.push(current);
  return messages;
}

function createMemberNotifier({ memberStore, sendMessage, channelId, logger = console,
  now = () => Date.now(), attributionTimeoutMs = 30 * 60 * 1000 }) {
  let queue = Promise.resolve();
  const delivered = new Map();
  const deliveredSources = new Map();
  const deliveredCampaigns = new Map();

  function sendPending() {
    const operation = queue.then(async () => {
      for (const member of await memberStore.getPendingJoinNotifications()) {
        const key = membershipKey(member.userId, member.addedAt);
        try {
          let { messages, sentCount = 0 } = member.joinNotification;
          let messageIds = member.joinNotification.messageIds || [];
          if (!messages) {
            const history = member.returned ? await memberStore.getMemberHistory(member.userId, member.addedAt) : [];
            const message = formatImmediateJoinNotification(member, history, { id: channelId });
            messages = splitNotification(message);
            if (!await memberStore.prepareJoinNotification(member.userId, member.addedAt, messages)) continue;
          }
          const acknowledged = delivered.get(key);
          if (acknowledged?.sentCount > sentCount) {
            messageIds = acknowledged.messageIds;
            await memberStore.markJoinNotificationPartSent(member.userId, member.addedAt, acknowledged.sentCount, messageIds);
            sentCount = acknowledged.sentCount;
          }
          for (let index = sentCount; index < messages.length; index++) {
            const sent = await sendMessage(messages[index]);
            if (Number.isSafeInteger(sent?.message_id)) messageIds[index] = sent.message_id;
            delivered.set(key, { sentCount: index + 1, messageIds: [...messageIds] });
            await memberStore.markJoinNotificationPartSent(member.userId, member.addedAt, index + 1, messageIds);
          }
          await memberStore.markJoinNotified(member.userId, member.addedAt);
          delivered.delete(key);
        } catch {
          // Retry persistence without sending again if only the state write failed.
          logger.error('Failed to send or save a membership notification.');
        }
      }
      for (const member of await memberStore.getPendingSourceNotifications()) {
        if (member.joinNotification?.status !== 'sent') continue;
        const unknown = member.source?.type === 'unknown';
        if (unknown && (member.sourceNotification.status === 'unknown_sent'
          || now() - Date.parse(member.addedAt) < attributionTimeoutMs)) continue;
        const key = membershipKey(member.userId, member.addedAt);
        const status = unknown ? 'unknown_sent' : 'sent';
        try {
          const acknowledged = deliveredSources.get(key);
          let messageId = acknowledged?.status === status ? acknowledged.messageId : null;
          if (acknowledged?.status !== status) {
            const sent = await sendMessage(formatSourceNotification(member, unknown));
            messageId = sent?.message_id ?? null;
            deliveredSources.set(key, { status, messageId });
          }
          await memberStore.markSourceNotified(member.userId, member.addedAt, status, messageId,
            status === 'sent' ? member.adsCampaign?.title || null : null);
          deliveredSources.delete(key);
        } catch {
          logger.error('Failed to send or save a membership source notification.');
        }
      }
      for (const member of await memberStore.getPendingCampaignNotifications()) {
        const key = membershipKey(member.userId, member.addedAt);
        const title = member.adsCampaign.title;
        try {
          if (deliveredCampaigns.get(key) !== title) {
            await sendMessage(`Обновилась информация о том, откуда пришел пользователь ${formatMemberName(member)}: Ads (${title})`);
            deliveredCampaigns.set(key, title);
          }
          await memberStore.markCampaignNotified(member.userId, member.addedAt, title);
          deliveredCampaigns.delete(key);
        } catch {
          logger.error('Failed to send or save an Ads campaign notification.');
        }
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { sendPending };
}

module.exports = { createMemberNotifier, formatJoinNotification, formatLeaveNotification };
