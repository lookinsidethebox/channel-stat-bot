const { REACTION_SNAPSHOT_GRACE_MS } = require('../storage/daily-summary.store');

function applyReactionSnapshots(snapshot, { periodStart, periodEnd }, state) {
  if (snapshot.channelId !== state.channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
  const before = state.reactionSnapshots[periodStart];
  const after = state.reactionSnapshots[periodEnd];
  const previousPosts = snapshot.posts.map(post => {
    const previous = snapshot.previousPosts?.find(entry => entry.messageId === post.messageId);
    const known = before?.posts.find(entry => entry.messageId === post.messageId);
    const isNew = Date.parse(post.postedAt) >= Date.parse(periodStart);
    return { ...previous, messageId: post.messageId, reactions: known?.reactions ?? (isNew ? 0 : null) };
  });
  const posts = snapshot.posts.map(post => {
    const known = after?.posts.find(entry => entry.messageId === post.messageId);
    return { ...post, reactions: known?.reactions ?? post.currentReactions ?? null,
      reactionPeriod: known ? 'day' : 'current' };
  });
  return { ...snapshot, posts, previousPosts };
}

function createReactionStatistics({ reader, summaryStore, now = () => new Date(), logger = console }) {
  let queue = Promise.resolve();
  let timer;
  let stopping = false;
  let retryAt = 0;

  async function capture() {
    const instant = now();
    if (stopping || instant.getTime() < retryAt) return;
    const boundaryAt = `${instant.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const boundary = Date.parse(boundaryAt);
    // A restart later in the day cannot recover yesterday's reactions. Never
    // label a daytime fetch as a midnight snapshot.
    if (instant.getTime() >= boundary + REACTION_SNAPSHOT_GRACE_MS) return;
    try {
      const state = await summaryStore.getState();
      if (state.reactionSnapshots[boundaryAt]) return;
      const snapshot = await reader.fetchPosts({ before: boundaryAt });
      if (snapshot.channelId !== state.channelId) throw new Error('REACTION_SNAPSHOT_CHANNEL_MISMATCH');
      const capturedAt = now().toISOString();
      if (Date.parse(capturedAt) >= boundary + REACTION_SNAPSHOT_GRACE_MS) return;
      await summaryStore.saveReactionSnapshot({ boundaryAt, capturedAt,
        posts: snapshot.posts.map(({ messageId, postedAt, reactions }) => ({ messageId, postedAt, reactions })) });
    } catch (error) {
      const seconds = error.retryAfterSeconds || 0;
      retryAt = now().getTime() + Math.max(30000, seconds * 1000);
      logger.error('Reaction snapshot failed:', /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'REACTION_SNAPSHOT_FAILED');
    }
  }

  function checkPending() {
    const operation = queue.then(capture);
    queue = operation.catch(() => {});
    return operation;
  }

  function schedule() {
    if (stopping) return;
    const instant = now().getTime();
    const midnight = Math.floor(instant / 86400000) * 86400000;
    const remaining = midnight + REACTION_SNAPSHOT_GRACE_MS - instant;
    const delay = remaining > 0 ? Math.min(30000, remaining) : midnight + 86400000 - instant;
    timer = setTimeout(async () => { await checkPending(); schedule(); }, Math.max(1, delay));
    timer.unref();
  }

  return {
    async enrich(snapshot, window) { return applyReactionSnapshots(snapshot, window, await summaryStore.getState()); },
    checkPending,
    async start() {
      await summaryStore.initialize(now().toISOString());
      await checkPending();
      schedule();
    },
    async stop() { stopping = true; clearTimeout(timer); await queue; },
  };
}

module.exports = { createReactionStatistics, applyReactionSnapshots };
