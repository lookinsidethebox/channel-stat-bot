const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const defaultFilePath = path.join(__dirname, '../../data/channel-members.json');
const migratedCampaignFields = Symbol('migratedCampaignFields');

function migrateLegacyCampaign(member) {
  let changed = false;
  if (Object.hasOwn(member, 'campaignLookup')) {
    const lookup = member.campaignLookup;
    if (lookup?.status !== 'not_applicable' || member.source?.type === 'ads') {
      member.adsCampaign = { ...lookup, ...member.adsCampaign };
    }
    delete member.campaignLookup;
    changed = true;
  }
  if (Object.hasOwn(member, 'campaign')) {
    const campaign = member.campaign;
    if (member.source?.type === 'ads' || campaign?.adId || campaign?.attribution === 'statistics_delta') {
      member.adsCampaign = { ...member.adsCampaign, ...campaign };
    } else if (member.source?.type === 'url' || campaign?.attribution === 'scheduled_url_promo') {
      member.urlCampaign = campaign;
    } else {
      throw new Error('MEMBER_CAMPAIGN_SOURCE_UNKNOWN');
    }
    delete member.campaign;
    changed = true;
  }
  return changed;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isPost(value) {
  return isObject(value)
    && Number.isSafeInteger(value.messageId) && value.messageId > 0
    && isTimestamp(value.postedAt)
    && (value.preview === null || typeof value.preview === 'string');
}

function isMember(value) {
  return isObject(value)
    && ['string', 'number'].includes(typeof value.userId)
    && (value.addedAt === null || isTimestamp(value.addedAt))
    && (value.removedAt === null || isTimestamp(value.removedAt));
}

async function readMemberData(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isObject(data) || !Array.isArray(data.members) || !data.members.every(isMember)
      || (data.latestPost != null && !isPost(data.latestPost))) {
      throw new Error(`Invalid member data in ${filePath}; the file was not changed.`);
    }
    let migrated = false;
    for (const member of data.members) if (migrateLegacyCampaign(member)) migrated = true;
    const result = { ...data, latestPost: data.latestPost ?? null };
    Object.defineProperty(result, migratedCampaignFields, { value: migrated });
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') return { latestPost: null, members: [] };
    throw error;
  }
}

async function writeMemberData(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// Create one store per data file; its queue serializes read-modify-write operations.
function createMemberStore(filePath = defaultFilePath) {
  let writeQueue = Promise.resolve();

  function updateMemberData(update) {
    const operation = writeQueue.then(async () => {
      const data = await readMemberData(filePath);
      const changed = update(data);
      if (changed || data[migratedCampaignFields]) await writeMemberData(filePath, data);
      return changed;
    });
    // Report the failure to the caller without blocking subsequent operations.
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function saveLatestPost(post, { isEdit = false } = {}) {
    return updateMemberData((data) => {
      const latest = data.latestPost;
      if (isEdit && latest?.messageId !== post.messageId) return false;
      if (latest && latest.messageId > post.messageId) return false;
      if (latest?.messageId === post.messageId && latest.postedAt > post.postedAt) return false;

      data.latestPost = post;
      return true;
    });
  }

  function migrateCampaignFields() {
    return updateMemberData(data => data[migratedCampaignFields]);
  }

  function recordMemberEvent(event, post = null) {
    return updateMemberData((data) => {
      if (!['joined', 'left'].includes(event.action)) {
        throw new Error(`Unknown member action: ${event.action}`);
      }

      const previous = data.members.findLast((entry) => String(entry.userId) === String(event.user.id));
      const lastChangedAt = previous?.removedAt ?? previous?.addedAt;
      if (lastChangedAt && event.occurredAt < lastChangedAt) return false;

      const joined = event.action === 'joined';
      if (joined && previous?.removedAt === null) return false;
      if (!joined && previous?.removedAt === event.occurredAt) return false;

      if (!event.postLookupError) data.latestPost = post;
      if (!joined && previous?.removedAt === null) {
        previous.removedAt = event.occurredAt;
        previous.postAtRemoval = post;
        if (event.postLookupError) previous.postAtRemovalError = event.postLookupError;
        return true;
      }

      data.members.push({
        userId: event.user.id,
        name: event.user.name,
        username: event.user.username,
        addedAt: joined ? event.occurredAt : null,
        source: joined ? event.source : null,
        postAtAddition: joined ? post : null,
        removedAt: joined ? null : event.occurredAt,
        postAtRemoval: joined ? null : post,
        returned: joined && Boolean(previous),
        ...(joined && event.sourceLookup ? { sourceLookup: event.sourceLookup } : {}),
        ...(joined && event.adsCampaign ? { adsCampaign: event.adsCampaign } : {}),
        ...(joined && event.joinNotification ? { joinNotification: event.joinNotification } : {}),
        ...(event.postLookupError ? {
          [joined ? 'postAtAdditionError' : 'postAtRemovalError']: event.postLookupError,
        } : {}),
      });
      return true;
    });
  }

  async function getPendingSourceLookups() {
    await writeQueue;
    const data = await readMemberData(filePath);
    return data.members.filter(member => member.sourceLookup?.status === 'pending');
  }

  async function getMember(userId, addedAt) {
    await writeQueue;
    const data = await readMemberData(filePath);
    return data.members.find(member => String(member.userId) === String(userId) && member.addedAt === addedAt);
  }

  async function getMemberAtRemoval(userId, removedAt) {
    await writeQueue;
    const data = await readMemberData(filePath);
    return data.members.findLast(member => String(member.userId) === String(userId) && member.removedAt === removedAt);
  }

  async function getMemberHistory(userId, addedAt) {
    await writeQueue;
    const { members } = await readMemberData(filePath);
    const currentIndex = members.findIndex(member => String(member.userId) === String(userId) && member.addedAt === addedAt);
    if (currentIndex < 0) return [];
    // Stop at this particular arrival, even if newer periods were saved while its lookup was pending.
    return members.slice(0, currentIndex).filter(member => String(member.userId) === String(userId));
  }

  async function countEvents(from, to) {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('INVALID_MEMBER_EVENT_PERIOD');
    await writeQueue;
    const { members } = await readMemberData(filePath);
    const inPeriod = value => value && Date.parse(value) >= start && Date.parse(value) < end;
    return { joined: members.filter(member => inPeriod(member.addedAt)).length,
      left: members.filter(member => inPeriod(member.removedAt)).length };
  }

  function resolveMemberSource(decision) {
    return updateMemberData(data => {
      const member = data.members.find(entry => String(entry.userId) === String(decision.userId)
        && entry.addedAt === decision.addedAt);
      if (!member || member.sourceLookup?.status !== 'pending') return false;
      // Direct Telegram metadata and owner corrections always take precedence.
      if (decision.source && member.source?.type === 'unknown') member.source = decision.source;
      member.sourceLookup = {
        status: decision.status, day: decision.day, checkedAt: decision.checkedAt,
        ...(decision.source ? { statisticsSource: decision.source.type } : { reason: decision.reason }),
      };
      return member;
    });
  }

  async function getMemberByNotificationMessage(messageId) {
    await writeQueue;
    return (await readMemberData(filePath)).members.findLast(member =>
      member.joinNotification?.status === 'sent'
      && member.joinNotification.messageIds?.includes(messageId));
  }

  function setManualSourceByNotification(messageId, type, { adsEnabled = false } = {}) {
    return updateMemberData(data => {
      const member = data.members.findLast(entry => entry.joinNotification?.status === 'sent'
        && entry.joinNotification.messageIds?.includes(messageId));
      if (!member || member.source?.type !== 'unknown') return false;
      member.source = { type, name: null, attribution: 'manual', confirmedBy: 'owner' };
      member.sourceLookup = { status: 'manual', checkedAt: new Date().toISOString() };
      if (type === 'ads' && adsEnabled) member.adsCampaign = { status: 'pending' };
      else delete member.adsCampaign;
      return member;
    });
  }

  async function getPendingCampaignLookups() {
    await writeQueue;
    return (await readMemberData(filePath)).members.filter(member => member.adsCampaign?.status === 'pending');
  }

  function resolveMemberCampaign(decision) {
    return updateMemberData(data => {
      const member = data.members.find(entry => String(entry.userId) === String(decision.userId)
        && entry.addedAt === decision.addedAt);
      if (!member || member.adsCampaign?.status !== 'pending') return false;
      const eligible = member.source?.type === 'ads' && !member.adsCampaign.adId;
      if (!eligible && member.source?.type !== 'ads') {
        delete member.adsCampaign;
        return member;
      }
      member.adsCampaign = {
        ...(decision.campaign && eligible ? decision.campaign : {}),
        status: decision.campaign && !eligible ? 'not_applicable' : decision.status,
        checkedAt: decision.checkedAt,
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      return member;
    });
  }

  function assignUrlPromos(campaigns, localDate) {
    return updateMemberData(data => {
      let assigned = 0;
      for (const member of data.members) {
        if (member.source?.type !== 'url' || !member.addedAt || member.urlCampaign) continue;
        const date = localDate(member.addedAt);
        const matches = campaigns.filter(item => date >= item.startDate && date < item.endDate);
        if (matches.length !== 1) continue;
        member.urlCampaign = { id: matches[0].id, title: matches[0].title, attribution: 'scheduled_url_promo' };
        assigned++;
      }
      return assigned;
    });
  }

  async function getPendingJoinNotifications() {
    await writeQueue;
    return (await readMemberData(filePath)).members.filter(member => member.joinNotification?.status === 'pending');
  }

  function prepareJoinNotification(userId, addedAt, messages) {
    return updateMemberData(data => {
      const member = data.members.find(entry => String(entry.userId) === String(userId) && entry.addedAt === addedAt);
      if (!member || member.joinNotification?.status !== 'pending' || member.joinNotification.messages) return false;
      member.joinNotification = { status: 'pending', messages, sentCount: 0, messageIds: [] };
      return true;
    });
  }

  function markJoinNotificationPartSent(userId, addedAt, sentCount, messageIds = []) {
    return updateMemberData(data => {
      const member = data.members.find(entry => String(entry.userId) === String(userId) && entry.addedAt === addedAt);
      if (!member || member.joinNotification?.status !== 'pending') return false;
      member.joinNotification.sentCount = sentCount;
      member.joinNotification.messageIds = messageIds;
      return true;
    });
  }

  function markJoinNotified(userId, addedAt) {
    return updateMemberData(data => {
      const member = data.members.find(entry => String(entry.userId) === String(userId) && entry.addedAt === addedAt);
      if (!member || member.joinNotification?.status !== 'pending') return false;
      member.joinNotification = { status: 'sent', sentAt: new Date().toISOString(),
        messageIds: member.joinNotification.messageIds || [] };
      return true;
    });
  }

  return { recordMemberEvent, saveLatestPost, migrateCampaignFields, getPendingSourceLookups, resolveMemberSource,
    getMemberByNotificationMessage, setManualSourceByNotification, getMember, getMemberAtRemoval,
    getMemberHistory, countEvents, getPendingCampaignLookups, resolveMemberCampaign, assignUrlPromos, getPendingJoinNotifications,
    prepareJoinNotification, markJoinNotificationPartSent, markJoinNotified };
}

module.exports = { createMemberStore };
