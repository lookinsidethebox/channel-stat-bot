const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const defaultPath = path.join(__dirname, '../../data/url-promos.json');

function addDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  try { return addDays(date, 0) === date; }
  catch { return false; }
}

function validate(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.campaigns)
    || !data.campaigns.every(item => item && typeof item.id === 'string'
      && typeof item.title === 'string' && item.title.trim()
      && validDate(item.startDate) && Number.isSafeInteger(item.days)
      && item.days > 0 && item.days <= 3650 && typeof item.createdAt === 'string')) {
    throw new Error('URL_PROMOS_INVALID_STATE');
  }
  return data;
}

function createUrlPromosStore(filePath = defaultPath) {
  let queue = Promise.resolve();

  async function read() {
    await queue;
    try { return validate(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, campaigns: [] };
      throw error;
    }
  }

  function add({ title, startDate, days }) {
    if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 100
      || !validDate(startDate) || !Number.isSafeInteger(days) || days < 1 || days > 3650) {
      throw new Error('URL_PROMO_INVALID_INPUT');
    }
    const operation = queue.then(async () => {
      let data;
      try { data = validate(JSON.parse(await readFile(filePath, 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        data = { version: 1, campaigns: [] };
      }
      const endDate = addDays(startDate, days);
      if (data.campaigns.some(item => startDate < addDays(item.startDate, item.days) && item.startDate < endDate)) {
        throw new Error('URL_PROMO_OVERLAP');
      }
      const campaign = { id: randomUUID(), title: title.trim(), startDate, days, createdAt: new Date().toISOString() };
      data.campaigns.push(campaign);
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await rename(temporaryPath, filePath);
      } finally { await rm(temporaryPath, { force: true }); }
      return campaign;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { read, add };
}

module.exports = { createUrlPromosStore, addDays };
