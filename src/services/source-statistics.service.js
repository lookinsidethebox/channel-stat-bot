const SOURCE_NAMES = {
  URL: 'url', Ads: 'ads', 'Shareable Chat Folders': 'chat_folder', Search: 'search', PM: 'pm',
};
const SOURCE_TYPES = Object.values(SOURCE_NAMES);
const emptyCounts = () => Object.fromEntries(SOURCE_TYPES.map(type => [type, 0]));
const membershipKey = (userId, addedAt) => `${userId}:${addedAt}`;

function validateCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)
    || SOURCE_TYPES.some(type => !Object.hasOwn(counts, type))
    || Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid source statistics counters.');
  }
}

function parseSourceGraph(graph) {
  if (!Array.isArray(graph?.columns) || !graph.types || !graph.names) {
    throw new Error('Invalid source statistics graph.');
  }
  const xColumns = graph.columns.filter(column => graph.types[column[0]] === 'x');
  if (xColumns.length !== 1) throw new Error('Invalid source statistics time axis.');
  const x = xColumns[0];
  const series = graph.columns.filter(column => column !== x);
  const keys = series.map(column => SOURCE_NAMES[graph.names[column[0]]] || `other:${graph.names[column[0]]}`);
  if (new Set(keys).size !== keys.length || series.some(column => column.length !== x.length)) {
    throw new Error('Invalid source statistics columns.');
  }
  const days = {};
  for (let i = 1; i < x.length; i += 1) {
    if (!Number.isSafeInteger(x[i]) || x[i] % 86400000 !== 0) {
      throw new Error('Expected daily source statistics in UTC.');
    }
    const day = new Date(x[i]).toISOString().slice(0, 10);
    if (days[day]) throw new Error('Duplicate statistics day.');
    const counts = emptyCounts();
    series.forEach((column, index) => { counts[keys[index]] = column[i]; });
    validateCounts(counts);
    days[day] = counts;
  }
  return days;
}

function validateSnapshot(snapshot, channelId) {
  if (snapshot?.channelId !== channelId || !Number.isFinite(Date.parse(snapshot?.fetchedAt))
    || !snapshot.days || typeof snapshot.days !== 'object' || Array.isArray(snapshot.days)) {
    throw new Error('Invalid source statistics snapshot.');
  }
  for (const [day, counts] of Object.entries(snapshot.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid statistics day.');
    validateCounts(counts);
  }
}

function applySnapshot(state, snapshot) {
  validateSnapshot(snapshot, state.channelId);
  if (state.lastCheckedAt && snapshot.fetchedAt < state.lastCheckedAt) {
    throw new Error('Outdated source statistics snapshot.');
  }
  const initializing = !state.initializedAt;
  if (initializing) state.initializedAt = snapshot.fetchedAt;
  const resolved = [];
  function decide(entry, day, details) {
    const decision = { userId: entry.userId, addedAt: entry.addedAt, day, checkedAt: snapshot.fetchedAt, ...details };
    state.decisions[entry.key] = decision;
    delete state.pending[entry.key];
    resolved.push(decision);
  }

  // A baseline taken after the join cannot identify that historic join.
  for (const entry of Object.values(state.pending)) {
    if (entry.addedAt <= state.initializedAt) {
      decide(entry, entry.addedAt.slice(0, 10), { status: 'unresolved', reason: 'no_prior_snapshot' });
    }
  }
  for (const [day, counts] of Object.entries(snapshot.days)) {
    const previous = state.days[day];
    const before = previous?.counts || emptyCounts();
    const pending = Object.values(state.pending).filter(entry => entry.addedAt.slice(0, 10) === day);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(counts)])];
    const delta = Object.fromEntries(keys.map(key => [key, (counts[key] || 0) - (before[key] || 0)]));
    const positive = keys.filter(key => delta[key] > 0);
    const total = Object.values(delta).reduce((sum, value) => sum + value, 0);
    const corrected = Object.values(delta).some(value => value < 0);
    let consume = initializing || pending.length === 0;
    if (!initializing && pending.length && (corrected || total >= pending.length)) {
      const matched = !corrected && total === pending.length && positive.length === 1 && SOURCE_TYPES.includes(positive[0]);
      for (const entry of pending) {
        decide(entry, day, {
          status: matched ? 'matched' : 'unresolved',
          ...(matched ? { source: { type: positive[0], name: null, attribution: 'statistics_delta' } }
            : { reason: corrected ? 'counters_corrected' : 'ambiguous_delta' }),
          before: { ...before }, after: { ...counts }, delta,
        });
      }
      consume = true;
    }
    // Keep the consumed baseline while Telegram's update is still incomplete.
    state.days[day] = {
      counts: { ...(consume ? counts : before) }, observedCounts: { ...counts }, checkedAt: snapshot.fetchedAt,
    };
  }
  const firstDay = Object.keys(snapshot.days).sort()[0];
  for (const entry of Object.values(state.pending)) {
    if (firstDay && entry.addedAt.slice(0, 10) < firstDay) {
      decide(entry, entry.addedAt.slice(0, 10), { status: 'unresolved', reason: 'day_no_longer_available' });
    }
  }
  state.lastCheckedAt = snapshot.fetchedAt;
  return resolved;
}

module.exports = { SOURCE_NAMES, emptyCounts, membershipKey, validateCounts, parseSourceGraph, validateSnapshot, applySnapshot };
