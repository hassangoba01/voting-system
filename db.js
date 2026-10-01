const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'voting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    photo TEXT,
    suspended INTEGER NOT NULL DEFAULT 0
  );
  -- Voters only record WHETHER someone voted, never what they chose.
  CREATE TABLE IF NOT EXISTS voters (
    student_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    has_voted INTEGER NOT NULL DEFAULT 0
  );
  -- Votes have no voter reference and no timestamp, so they cannot be traced back.
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE
  );
`);
db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('voting_open', '0')").run();

// ---------- Settings ----------
function isVotingOpen() {
  return db.prepare("SELECT value FROM settings WHERE key='voting_open'").get().value === '1';
}
function setVotingOpen(open) {
  db.prepare("UPDATE settings SET value=? WHERE key='voting_open'").run(open ? '1' : '0');
}

// ---------- Voters ----------
function getVoter(id) {
  return db.prepare('SELECT * FROM voters WHERE student_id=?').get(id);
}
function upsertVoters(list) {
  const exists = db.prepare('SELECT 1 FROM voters WHERE student_id=?');
  const upsert = db.prepare(`
    INSERT INTO voters(student_id, name) VALUES(?, ?)
    ON CONFLICT(student_id) DO UPDATE SET name=excluded.name`);
  let added = 0, updated = 0;
  db.transaction(() => {
    for (const v of list) {
      if (exists.get(v.id)) updated++; else added++;
      upsert.run(v.id, v.name);
    }
  })();
  return { added, updated };
}

// ---------- Ballot ----------
// Only positions that have at least one active (not suspended) candidate.
function getBallot() {
  const positions = db.prepare('SELECT * FROM positions ORDER BY id').all();
  const cands = db.prepare('SELECT * FROM candidates WHERE position_id=? AND suspended=0 ORDER BY id');
  return positions
    .map(p => ({ ...p, candidates: cands.all(p.id) }))
    .filter(p => p.candidates.length > 0);
}

// Saves all of a voter's picks in one transaction.
// Returns 'ok' | 'closed' | 'already'.
const castVotesTx = db.transaction((studentId, picks) => {
  if (!isVotingOpen()) return 'closed';
  const r = db.prepare('UPDATE voters SET has_voted=1 WHERE student_id=? AND has_voted=0').run(studentId);
  if (r.changes !== 1) return 'already';
  const ins = db.prepare('INSERT INTO votes(position_id, candidate_id) VALUES(?, ?)');
  for (const p of picks) ins.run(p.positionId, p.candidateId);
  return 'ok';
});
function castVotes(studentId, picks) {
  return castVotesTx(studentId, picks);
}

// ---------- Results ----------
// Votes for suspended candidates are excluded. Reinstating restores them.
function getResults() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM voters').get().n;
  const voted = db.prepare('SELECT COUNT(*) AS n FROM voters WHERE has_voted=1').get().n;
  const positions = db.prepare('SELECT * FROM positions ORDER BY id').all();
  const candStmt = db.prepare(`
    SELECT c.id, c.name, c.photo, c.suspended,
           (SELECT COUNT(*) FROM votes v WHERE v.candidate_id = c.id) AS raw_votes
    FROM candidates c WHERE c.position_id=? ORDER BY c.id`);

  const out = positions.map(p => {
    const candidates = candStmt.all(p.id).map(c => ({
      id: c.id, name: c.name, photo: c.photo,
      suspended: !!c.suspended,
      votes: c.suspended ? 0 : c.raw_votes
    }));
    const active = candidates.filter(c => !c.suspended);
    const totalVotes = active.reduce((s, c) => s + c.votes, 0);
    const max = active.reduce((m, c) => Math.max(m, c.votes), 0);
    const leaders = max > 0 ? active.filter(c => c.votes === max) : [];
    candidates.forEach(c => {
      c.percent = !c.suspended && totalVotes ? Math.round((c.votes / totalVotes) * 1000) / 10 : 0;
      c.leader = !c.suspended && leaders.some(l => l.id === c.id);
    });
    return { id: p.id, name: p.name, totalVotes, tie: leaders.length > 1, candidates };
  });

  return {
    turnout: { total, voted, percent: total ? Math.round((voted / total) * 1000) / 10 : 0 },
    positions: out
  };
}

module.exports = { db, isVotingOpen, setVotingOpen, getVoter, upsertVoters, getBallot, castVotes, getResults };
