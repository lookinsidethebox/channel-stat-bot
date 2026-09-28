const { mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { membershipKey, validateCounts, applySnapshot } = require('../services/source-statistics.service');

function createSourceStatisticsStore(channelId, filePath = path.join(__dirname, '../../data/source-statistics.json')) {
  let queue = Promise.resolve();
  async function read() {
    let state;
    try { state = JSON.parse(await readFile(filePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, channelId, initializedAt: null, lastCheckedAt: null, days: {}, pending: {}, decisions: {} };
      throw error;
    }
    if (state.version !== 1 || state.channelId !== channelId || !state.days || !state.pending || !state.decisions) {
      throw new Error('Invalid source statistics state; file was not changed.');
    }
    Object.values(state.days).forEach(day => validateCounts(day.counts));
    return state;
  }
  async function write(state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, filePath);
    } finally { await rm(temporary, { force: true }); }
  }
  function update(action) {
    const operation = queue.then(async () => {
      const state = await read();
      const result = action(state);
      await write(state);
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    async getState() { await queue; return read(); },
    registerPending(members) {
      return update(state => {
        for (const member of members) {
          const key = membershipKey(member.userId, member.addedAt);
          if (!state.decisions[key]) state.pending[key] = { key, userId: member.userId, addedAt: member.addedAt };
        }
      });
    },
    applySnapshot(snapshot) { return update(state => applySnapshot(state, snapshot)); },
  };
}

module.exports = { createSourceStatisticsStore };
