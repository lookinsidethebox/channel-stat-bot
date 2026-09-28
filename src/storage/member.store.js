const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

const defaultFilePath = path.join(__dirname, '../../data/channel-members.json');

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
    return { ...data, latestPost: data.latestPost ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return { latestPost: null, members: [] };
    throw error;
  }
}

async function writeMemberData(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
      if (changed) await writeMemberData(filePath, data);
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
        ...(joined && event.campaignLookup ? { campaignLookup: event.campaignLookup } : {}),
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

  async function getPendingCampaignLookups() {
    await writeQueue;
    return (await readMemberData(filePath)).members.filter(member => member.campaignLookup?.status === 'pending');
  }

  function resolveMemberCampaign(decision) {
    return updateMemberData(data => {
      const member = data.members.find(entry => String(entry.userId) === String(decision.userId)
        && entry.addedAt === decision.addedAt);
      if (!member || member.campaignLookup?.status !== 'pending') return false;
      const eligible = member.source?.type === 'ads' && !member.campaign;
      if (decision.campaign && eligible) member.campaign = decision.campaign;
      member.campaignLookup = {
        status: decision.campaign && !eligible ? 'not_applicable' : decision.status,
        checkedAt: decision.checkedAt,
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
      return member;
    });
  }

  return { recordMemberEvent, saveLatestPost, getPendingSourceLookups, resolveMemberSource, getMember,
    getPendingCampaignLookups, resolveMemberCampaign };
}

module.exports = { createMemberStore };
