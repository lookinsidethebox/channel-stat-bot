const path = require('node:path');
const readline = require('node:readline');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { Logger, LogLevel } = require('teleproto/extensions/Logger');
const qrcode = require('qrcode-terminal');
const {
  LoginError, projectRoot, getSessionPath, readAuthConfig, readSession, assertOwner, saveOwnerSession,
} = require('../src/services/telegram-user-session');

function readPassword(signal) {
  if (signal.aborted) throw new LoginError('Вход отменён.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new LoginError('Для ввода пароля запусти npm run telegram:login в своём терминале.');
  }
  process.stdout.write('Пароль двухэтапной защиты (ввод скрыт): ');
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const abort = () => finish(new LoginError('Вход отменён или истекло время ожидания.'));
    function finish(error) {
      process.stdin.removeListener('keypress', onKey);
      signal.removeEventListener('abort', abort);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
      value = '';
    }
    function onKey(text, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return finish(new LoginError('Вход отменён.'));
      if (['return', 'enter'].includes(key.name)) return finish();
      if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    }
    process.stdin.on('keypress', onKey);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('npm run telegram:login — войти по QR-коду; npm run telegram:check — проверить сохранённую сессию.');
    return;
  }
  if (args.some(arg => arg !== '--check')) throw new LoginError('Неизвестный аргумент. Используй --help.');
  require('dotenv').config({ path: path.join(projectRoot, '.env') });
  const config = readAuthConfig(process.env);
  const saved = readSession();
  const checkOnly = args.includes('--check');
  if (checkOnly && !saved) throw new LoginError('Сессии пока нет. Сначала выполни npm run telegram:login.');
  if (!checkOnly && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new LoginError('Для входа запусти npm run telegram:login в своём терминале.');
  }

  const client = new TelegramClient(new StringSession(saved), config.apiId, config.apiHash, {
    connectionRetries: 3,
    requestRetries: 3,
    timeout: 10,
    floodSleepThreshold: 0,
    deviceModel: process.env.RAILWAY_ENVIRONMENT_ID ? 'Channel Stat Bot (Railway)' : 'Channel Stat Bot (local)',
    appVersion: '1.0.0',
    baseLogger: new Logger(LogLevel.NONE),
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const timer = setTimeout(cancel, 5 * 60 * 1000);
  let newlyAuthorized = false;
  try {
    await client.connect();
    if (!await client.checkAuthorization()) {
      if (checkOnly) throw new LoginError('Сессия больше не действует. Выполни npm run telegram:login.');
      console.log('В Telegram на телефоне: Настройки → Устройства → Подключить устройство.');
      console.log('Подтверди вход аккаунтом владельца канала. QR обновляется автоматически; Ctrl+C — отмена.');
      await client.signInUserWithQrCode(config, {
        abortSignal: controller.signal,
        qrCode: async ({ token }) => {
          const url = 'tg://login?token=' + token.toString('base64url');
          console.log('\nОтсканируй актуальный QR-код:');
          qrcode.generate(url, { small: true });
        },
        password: () => readPassword(controller.signal),
        onError: async (error) => {
          if (error.errorMessage === 'PASSWORD_HASH_INVALID') {
            console.log('Пароль не подошёл. Попробуй ещё раз.');
            return false;
          }
          throw error;
        },
      });
      newlyAuthorized = true;
    }
    const me = await client.getMe();
    try {
      assertOwner(me, config.ownerId);
    } catch (error) {
      if (newlyAuthorized) await client.invoke(new Api.auth.LogOut());
      throw error;
    }
    saveOwnerSession(me, config.ownerId, client.session.save());
    console.log(`Авторизация подтверждена. Аккаунт совпадает с OWNER_ID (${config.ownerId}).`);
    console.log(`Сессия сохранена: ${path.relative(projectRoot, getSessionPath())} (доступ только владельцу файла).`);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await client.destroy();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), (error) => {
    const rpcCode = /^[A-Z0-9_]+$/.test(error.errorMessage || '') ? error.errorMessage : null;
    const message = error instanceof LoginError ? error.message
      : error.name === 'AbortError' ? 'Вход отменён или истекло время ожидания.'
        : `Не удалось завершить вход${rpcCode ? `: ${rpcCode}` : ''}.`;
    console.error(message);
    process.exit(1);
  });
}
