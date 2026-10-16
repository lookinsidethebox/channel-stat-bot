const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const defaultPath = path.join(__dirname, '../../data/anti-spam.json');
const empty = () => ({ version: 1, phrases: [], blockedUsers: [], blockedUsernames: [], knownUsers: {} });
const normalize = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const username = value => value.replace(/^@/, '').toLowerCase();
const validId = value => Number.isSafeInteger(value) && value > 0;

function validate(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.phrases)
    || !data.phrases.every(value => typeof value === 'string' && value.trim())
    || !Array.isArray(data.blockedUsers) || !data.blockedUsers.every(validId)
    || !Array.isArray(data.blockedUsernames) || !data.blockedUsernames.every(value => typeof value === 'string' && /^[a-z0-9_]{5,32}$/.test(value))
    || !data.knownUsers || typeof data.knownUsers !== 'object' || Array.isArray(data.knownUsers)
    || !Object.entries(data.knownUsers).every(([name, id]) => /^[a-z0-9_]{5,32}$/.test(name) && validId(id))) {
    throw new Error('ANTI_SPAM_INVALID_STATE');
  }
  return data;
}

function createAntiSpamStore(filePath = defaultPath) {
  let queue = Promise.resolve();
  async function load() {
    try { return validate(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw error;
    }
  }
  async function read() { await queue; return load(); }
  function update(change) {
    const operation = queue.then(async () => {
      const data = await load();
      const result = change(data);
      await mkdir(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
        await rename(temp, filePath);
      } finally { await rm(temp, { force: true }); }
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    read,
    addPhrase(value) {
      const phrase = value.trim();
      if (!phrase || [...phrase].length > 200) throw new Error('ANTI_SPAM_INVALID_PHRASE');
      return update(data => {
        if (data.phrases.some(item => normalize(item) === normalize(phrase))) return false;
        data.phrases.push(phrase);
        return true;
      });
    },
    removePhrase(value) {
      return update(data => {
        const index = data.phrases.findIndex(item => normalize(item) === normalize(value));
        if (index < 0) return false;
        data.phrases.splice(index, 1);
        return true;
      });
    },
    blockId(id) {
      if (!validId(id)) throw new Error('ANTI_SPAM_INVALID_USER');
      return update(data => {
        if (!data.blockedUsers.includes(id)) data.blockedUsers.push(id);
      });
    },
    blockUsername(value) {
      const name = username(value);
      if (!/^[a-z0-9_]{5,32}$/.test(name)) throw new Error('ANTI_SPAM_INVALID_USERNAME');
      return update(data => {
        if (!data.blockedUsernames.includes(name)) data.blockedUsernames.push(name);
        return data.knownUsers[name] || null;
      });
    },
    unblock(value) {
      return update(data => {
        const name = username(String(value));
        const id = /^\d+$/.test(String(value)) ? Number(value) : data.knownUsers[name];
        const wasBlocked = data.blockedUsernames.includes(name) || data.blockedUsers.includes(id);
        data.blockedUsernames = data.blockedUsernames.filter(item => item !== name);
        if (id) data.blockedUsers = data.blockedUsers.filter(item => item !== id);
        return { id: id || null, wasBlocked };
      });
    },
    rememberUser(user) {
      if (!validId(user?.id) || !user.username) return Promise.resolve();
      const name = username(user.username);
      if (!/^[a-z0-9_]{5,32}$/.test(name)) return Promise.resolve();
      return update(data => {
        for (const [oldName, id] of Object.entries(data.knownUsers)) {
          if (id === user.id && oldName !== name) delete data.knownUsers[oldName];
        }
        data.knownUsers[name] = user.id;
        if (data.blockedUsernames.includes(name) && !data.blockedUsers.includes(user.id)) data.blockedUsers.push(user.id);
      });
    },
  };
}

module.exports = { createAntiSpamStore, normalize };
