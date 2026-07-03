// Owner-activity tracker. The dashboard polls /api/servers/:id/status every
// few seconds while its tab is foreground, so a recent poll means the owner is
// actively watching that server. The idle-stop loop uses this to avoid the
// worst-case UX: a user starts a server, spends 10+ minutes configuring it or
// waiting for friends, and the platform shuts it off under them ("it keeps
// turning on and off"). Purely in-memory — resets on deploy, which is fine.

const lastOwnerPoll = new Map(); // serverId → ts of last owner status poll

function touch(serverId) {
  lastOwnerPoll.set(serverId, Date.now());
}

function ownerActiveWithin(serverId, ms) {
  const ts = lastOwnerPoll.get(serverId);
  return !!ts && Date.now() - ts < ms;
}

module.exports = { touch, ownerActiveWithin };
