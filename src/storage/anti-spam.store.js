const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const defaultPath = path.join(__dirname, '../../data/anti-spam.json');
const empty = () => ({ version: 3, phrases: [], blockedUsers: [], profiles: {} });
const normalize = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const validId = value => Number.isSafeInteger(value) && value > 0;

function validProfile(profile) {
  return profile && typeof profile.name === 'string' && profile.name.trim()
    && (profile.username === undefined || typeof profile.username === 'string');
}

function validate(data) {
  if (!data || ![1, 2, 3].includes(data.version) || !Array.isArray(data.phrases)
    || !data.phrases.every(value => typeof value === 'string' && value.trim())
    || !Array.isArray(data.blockedUsers) || !data.blockedUsers.every(validId)
    || (data.version === 3 && (!data.profiles || typeof data.profiles !== 'object'
      || Array.isArray(data.profiles) || !Object.entries(data.profiles).every(([id, profile]) =>
        validId(Number(id)) && validProfile(profile))))) {
    throw new Error('ANTI_SPAM_INVALID_STATE');
  }
  // Version 1 included username rules. They are deliberately discarded.
  return { version: 3, phrases: data.phrases, blockedUsers: data.blockedUsers,
    profiles: data.version === 3 ? data.profiles : {} };
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
    blockId(id, profile) {
      if (!validId(id)) throw new Error('ANTI_SPAM_INVALID_USER');
      if (profile !== undefined && !validProfile(profile)) throw new Error('ANTI_SPAM_INVALID_PROFILE');
      return update(data => {
        if (!data.blockedUsers.includes(id)) data.blockedUsers.push(id);
        if (profile) data.profiles[id] = profile;
      });
    },
    saveProfile(id, profile) {
      if (!validId(id) || !validProfile(profile)) throw new Error('ANTI_SPAM_INVALID_PROFILE');
      return update(data => {
        if (data.blockedUsers.includes(id)) data.profiles[id] = profile;
      });
    },
    unblockId(id) {
      if (!validId(id)) throw new Error('ANTI_SPAM_INVALID_USER');
      return update(data => {
        const blocked = data.blockedUsers.includes(id);
        data.blockedUsers = data.blockedUsers.filter(value => value !== id);
        delete data.profiles[id];
        return blocked;
      });
    },
  };
}

module.exports = { createAntiSpamStore, normalize };
