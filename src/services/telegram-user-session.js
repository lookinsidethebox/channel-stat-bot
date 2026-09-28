const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const projectRoot = path.resolve(__dirname, '../..');
const sessionPath = path.join(projectRoot, '.telegram/user.session');

function getSessionPath(env = process.env) {
  return env.TELEGRAM_SESSION_PATH ? path.resolve(projectRoot, env.TELEGRAM_SESSION_PATH) : sessionPath;
}

class LoginError extends Error {}

function readAuthConfig(env) {
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || apiId > 2147483647
    || !/^[a-f0-9]{32}$/i.test(apiHash || '')) {
    throw new LoginError('Добавь TELEGRAM_API_ID и TELEGRAM_API_HASH из https://my.telegram.org/apps в .env.');
  }
  if (!/^[1-9]\d*$/.test(env.OWNER_ID || '')) {
    throw new LoginError('В .env нужен положительный числовой OWNER_ID.');
  }
  return { apiId, apiHash, ownerId: env.OWNER_ID };
}

function readSession(file = getSessionPath()) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function assertOwner(user, ownerId) {
  if (!user || user.bot || String(user.id) !== String(ownerId)) {
    throw new LoginError('Вход выполнен другим аккаунтом: он не совпадает с OWNER_ID. Сессия не сохранена.');
  }
}

function saveOwnerSession(user, ownerId, session, file = getSessionPath()) {
  assertOwner(user, ownerId);
  if (typeof session !== 'string' || !session.trim()) {
    throw new LoginError('Telegram не вернул сессию для сохранения.');
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = path.join(dir, `.session-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, session.trim() + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { LoginError, projectRoot, sessionPath, getSessionPath, readAuthConfig, readSession, assertOwner, saveOwnerSession };
