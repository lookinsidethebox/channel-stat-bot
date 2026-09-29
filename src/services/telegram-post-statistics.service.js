const { Api } = require('teleproto');

const POST_LIMIT = 5;

function counter(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('POST_STATISTICS_INVALID_COUNTER');
  return value;
}

// Read counters without incrementing views or marking messages as read.
async function fetchLatestPostStatistics(client, inputChannel, { channelId, before }) {
  const cutoff = Date.parse(before) / 1000;
  if (!Number.isFinite(cutoff)) throw new Error('POST_STATISTICS_INVALID_DATE');
  const peer = new Api.InputPeerChannel({ channelId: inputChannel.channelId, accessHash: inputChannel.accessHash });
  const groups = new Map();
  let offsetId = 0;
  while (true) {
    const result = await client.invoke(new Api.messages.GetHistory({
      peer, offsetId, offsetDate: Math.ceil(cutoff), addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: 0,
    }));
    if (!Array.isArray(result.messages)) throw new Error('POST_STATISTICS_INVALID_RESPONSE');
    if (!result.messages.length) break;
    for (const message of result.messages) {
      if (message.className !== 'Message' || !message.post) continue;
      if (String(message.peerId?.channelId) !== String(inputChannel.channelId)
        || !Number.isSafeInteger(message.id) || message.id <= 0 || !Number.isFinite(message.date)) {
        throw new Error('POST_STATISTICS_INVALID_RESPONSE');
      }
      if (message.date >= cutoff) continue;
      const key = message.groupedId ? `album:${message.groupedId}` : `message:${message.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(message);
    }
    // One extra group means all requested posts, including the last album, are complete.
    if (groups.size > POST_LIMIT || result.messages.length < 100) break;
    const nextOffset = Math.min(...result.messages.map(message => message.id));
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= 0 || (offsetId && nextOffset >= offsetId)) {
      throw new Error('POST_STATISTICS_INVALID_PAGINATION');
    }
    offsetId = nextOffset;
  }
  const posts = [...groups.values()]
    .sort((a, b) => Math.max(...b.map(m => m.id)) - Math.max(...a.map(m => m.id)))
    .slice(0, POST_LIMIT).map(group => {
      group.sort((a, b) => a.id - b.id);
      const first = group[0];
      const reactions = first.reactions?.results || [];
      if (!Array.isArray(reactions)) throw new Error('POST_STATISTICS_INVALID_REACTIONS');
      const reactionCount = reactions.reduce((total, reaction) => {
        const count = counter(reaction.count);
        if (count === null) throw new Error('POST_STATISTICS_INVALID_REACTIONS');
        return total + count;
      }, 0);
      return { messageId: first.id, postedAt: new Date(first.date * 1000).toISOString(),
        preview: Array.from(group.find(message => message.message)?.message || '').slice(0, 100).join('') || null,
        views: counter(first.views), reactions: counter(reactionCount), forwards: counter(first.forwards) };
    });
  return { channelId, fetchedAt: new Date().toISOString(), posts };
}

module.exports = { fetchLatestPostStatistics };
