const { addDays } = require('../storage/url-promos.store');

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Podgorica', year: 'numeric', month: '2-digit', day: '2-digit',
});

function localDate(timestamp) {
  const parts = Object.fromEntries(dateFormat.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function createUrlPromosService({ store, memberStore }) {
  let queue = Promise.resolve();
  function sync() {
    const operation = queue.then(async () => {
      const { campaigns } = await store.read();
      return memberStore.assignUrlPromos(campaigns.map(item => ({ ...item, endDate: addDays(item.startDate, item.days) })), localDate);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  async function add(input) {
    const campaign = await store.add(input);
    let assigned;
    try { assigned = await sync(); }
    catch (error) { error.promoSaved = true; throw error; }
    return { campaign, assigned };
  }
  return { add, sync };
}

module.exports = { createUrlPromosService, localDate };
