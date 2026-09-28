const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../src/config');

const validEnv = { BOT_TOKEN: 'test-token', OWNER_ID: '123', CHANNEL_ID: '-100456' };

test('reads and trims config without changing the environment', () => {
  const env = { BOT_TOKEN: ' test-token ', OWNER_ID: ' 123 ', CHANNEL_ID: ' -100456 ' };
  assert.deepEqual(loadConfig(env), {
    token: 'test-token', ownerId: '123', channelId: '-100456', debugMemberUpdates: false,
  });
  assert.equal(env.BOT_TOKEN, ' test-token ');
});

test('rejects missing and blank required settings', () => {
  for (const name of Object.keys(validEnv)) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => loadConfig({ ...validEnv, [name]: value }), new RegExp(`${name} is missing`));
    }
  }
});

test('rejects IDs that would never match Telegram updates', () => {
  for (const ownerId of ['placeholder', '0', '-123', '1.5', '9007199254740992']) {
    assert.throws(() => loadConfig({ ...validEnv, OWNER_ID: ownerId }), /OWNER_ID/);
  }
  for (const channelId of ['@channel', '0', '123', '-1.5', '-9007199254740992']) {
    assert.throws(() => loadConfig({ ...validEnv, CHANNEL_ID: channelId }), /CHANNEL_ID/);
  }
});

test('source statistics require explicit enablement and validate credentials without exposing them', () => {
  assert.equal(loadConfig(validEnv).sourceStatistics, undefined);
  assert.throws(() => loadConfig({ ...validEnv, SOURCE_STATS_ENABLED: '1' }), /TELEGRAM_API_ID/);
  const config = loadConfig({ ...validEnv, SOURCE_STATS_ENABLED: '1', TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef', TELEGRAM_SESSION_PATH: '/app/data/.telegram/user.session' });
  assert.equal(config.sourceStatistics.apiId, 12345);
  assert.equal(config.sourceStatistics.sessionPath, '/app/data/.telegram/user.session');
});

test('Ads token enables campaign attribution only with channel source statistics', () => {
  assert.throws(() => loadConfig({ ...validEnv, TELEGRAM_ADS_API_TOKEN: 'secret' }), /requires SOURCE_STATS_ENABLED/);
  assert.equal(loadConfig({ ...validEnv, TELEGRAM_ADS_API_TOKEN: ' ' }).adsStatistics, undefined);
  const config = loadConfig({ ...validEnv, SOURCE_STATS_ENABLED: '1', TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef', TELEGRAM_ADS_API_TOKEN: ' secret ' });
  assert.deepEqual(config.adsStatistics, { token: 'secret', channelId: validEnv.CHANNEL_ID });
});
