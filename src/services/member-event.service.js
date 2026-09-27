function isChatMember(member) {
  if (member.status === 'restricted') {
    return member.is_member === true;
  }

  return ['creator', 'administrator', 'member'].includes(member.status);
}

function getMemberSource(update) {
  if (update.via_join_request) {
    return { type: 'join_request', name: null };
  }

  if (update.via_chat_folder_invite_link) {
    return { type: 'chat_folder', name: null };
  }

  if (update.invite_link) {
    return { type: 'invite_link', name: update.invite_link.name || null };
  }

  return { type: 'unknown', name: null };
}

function createMemberEvent(update) {
  const wasMember = isChatMember(update.old_chat_member);
  const isMember = isChatMember(update.new_chat_member);

  if (wasMember === isMember) {
    return null;
  }

  const user = update.new_chat_member.user;

  return {
    occurredAt: new Date(update.date * 1000).toISOString(),
    channelId: String(update.chat.id),
    action: isMember ? 'joined' : 'left',
    user: {
      id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
      username: user.username || null,
    },
    source: isMember ? getMemberSource(update) : null,
  };
}

function createPostSnapshot(post) {
  const content = post.text || post.caption || '';
  const preview = Array.from(content).slice(0, 100).join('');

  return {
    messageId: post.message_id,
    postedAt: new Date((post.edit_date || post.date) * 1000).toISOString(),
    preview: preview || null,
  };
}

module.exports = {
  createMemberEvent,
  createPostSnapshot,
  getMemberSource,
};
