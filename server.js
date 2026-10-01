const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');

const config = require('./config');
const db = require('./db');

const app = express();
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const adminHash = bcrypt.hashSync(config.ADMIN_PASSWORD, 10);

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

// ---------- helpers ----------
const normalizeId = v => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const back = (req, res, fallback = '/admin') => res.redirect(req.get('referer') || fallback);
const toInt = v => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const removePhoto = file => {
  if (!file) return;
  try { fs.unlinkSync(path.join(uploadsDir, path.basename(file))); } catch (e) { /* already gone */ }
};

app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.electionName = config.ELECTION_NAME;
  res.locals.votingOpen = db.isVotingOpen();
  next();
});

// ---------- uploads ----------
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Photos must be JPG or PNG files.'));
  }
}).single('photo');

const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
}).single('file');

const handleUpload = mw => (req, res, next) => mw(req, res, err => {
  if (!err) return next();
  flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : err.message);
  back(req, res);
});

// =====================================================
//  VOTER INTERFACE
// =====================================================
function requireVoter(req, res, next) {
  const id = req.session.voterId;
  if (!id) return res.redirect('/');
  if (!db.isVotingOpen()) {
    delete req.session.voterId; delete req.session.selections;
    flash(req, 'error', 'Voting is closed.');
    return res.redirect('/');
  }
  const voter = db.getVoter(id);
  if (!voter || voter.has_voted) {
    delete req.session.voterId; delete req.session.selections;
    return res.redirect('/');
  }
  req.voter = voter;
  next();
}

app.get('/', (req, res) => {
  if (req.session.voterId && db.isVotingOpen()) return res.redirect('/ballot');
  res.render('voter/login', { title: 'Vote', area: 'voter' });
});

app.post('/login', (req, res) => {
  if (!db.isVotingOpen()) {
    flash(req, 'error', 'Voting is closed.');
    return res.redirect('/');
  }
  const id = normalizeId(req.body.student_id);
  const voter = id && db.getVoter(id);
  if (!voter) {
    flash(req, 'error', 'This student ID is not on the voters list. Check it and try again.');
    return res.redirect('/');
  }
  if (voter.has_voted) {
    flash(req, 'error', 'This student ID has already voted.');
    return res.redirect('/');
  }
  req.session.voterId = id;
  delete req.session.selections;
  res.redirect('/ballot');
});

app.post('/leave', (req, res) => {
  delete req.session.voterId; delete req.session.selections;
  res.redirect('/');
});

app.get('/ballot', requireVoter, (req, res) => {
  const ballot = db.getBallot();
  res.render('voter/ballot', {
    title: 'Ballot', area: 'voter', voter: req.voter, ballot,
    selections: req.session.selections || {}
  });
});

// Validates picks against the current ballot. Returns the picks or null.
function readPicks(ballot, source) {
  const picks = [];
  for (const pos of ballot) {
    const candId = toInt(source[pos.id] !== undefined ? source[pos.id] : source['p_' + pos.id]);
    const cand = pos.candidates.find(c => c.id === candId);
    if (!cand) return null;
    picks.push({ positionId: pos.id, candidateId: cand.id, position: pos, candidate: cand });
  }
  return picks;
}

app.post('/review', requireVoter, (req, res) => {
  const ballot = db.getBallot();
  if (!ballot.length) {
    flash(req, 'error', 'There is no ballot to vote on yet.');
    return res.redirect('/ballot');
  }
  const picks = readPicks(ballot, req.body);
  if (!picks) {
    flash(req, 'error', 'Choose one candidate for every position before continuing.');
    return res.redirect('/ballot');
  }
  req.session.selections = {};
  picks.forEach(p => { req.session.selections[p.positionId] = p.candidateId; });
  res.render('voter/review', { title: 'Review your votes', area: 'voter', voter: req.voter, picks });
});

app.post('/submit', requireVoter, (req, res) => {
  const ballot = db.getBallot();
  const picks = req.session.selections && ballot.length ? readPicks(ballot, req.session.selections) : null;
  if (!picks) {
    delete req.session.selections;
    flash(req, 'error', 'The ballot has changed. Please choose again.');
    return res.redirect('/ballot');
  }
  const result = db.castVotes(req.voter.student_id, picks);
  delete req.session.selections;
  if (result !== 'ok') {
    delete req.session.voterId;
    flash(req, 'error', result === 'closed' ? 'Voting closed before your votes were saved.' : 'This student ID has already voted.');
    return res.redirect('/');
  }
  delete req.session.voterId;
  res.redirect('/thanks');
});

app.get('/thanks', (req, res) => res.render('voter/thanks', { title: 'Thank you', area: 'voter' }));

// =====================================================
//  ADMIN INTERFACE
// =====================================================
const admin = express.Router();

admin.use((req, res, next) => { res.locals.area = 'admin'; res.locals.active = ''; next(); });

admin.get('/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin sign in', area: 'login' });
});
admin.post('/login', (req, res) => {
  const okUser = req.body.username === config.ADMIN_USERNAME;
  const okPass = bcrypt.compareSync(String(req.body.password || ''), adminHash);
  if (!okUser || !okPass) {
    flash(req, 'error', 'Wrong username or password.');
    return res.redirect('/admin/login');
  }
  req.session.isAdmin = true;
  res.redirect('/admin');
});
admin.post('/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

admin.use((req, res, next) => {
  if (req.session.isAdmin) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/admin/login');
});

// Structure (positions/candidates) can only change while voting is closed.
const requireClosed = (req, res, next) => {
  if (!db.isVotingOpen()) return next();
  flash(req, 'error', 'Close voting before adding, editing or deleting positions and candidates. You can still suspend or reinstate candidates.');
  back(req, res);
};

// ----- dashboard -----
admin.get('/', (req, res) => {
  res.render('admin/dashboard', { title: 'Results', active: 'results' });
});
admin.get('/api/results', (req, res) => {
  res.json({ votingOpen: db.isVotingOpen(), ...db.getResults() });
});
admin.post('/voting/toggle', (req, res) => {
  const open = !db.isVotingOpen();
  db.setVotingOpen(open);
  flash(req, 'success', open ? 'Voting is now open.' : 'Voting is now closed.');
  back(req, res);
});

// ----- positions -----
admin.get('/positions', (req, res) => {
  const positions = db.db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM candidates c WHERE c.position_id=p.id) AS candidate_count
    FROM positions p ORDER BY p.id`).all();
  res.render('admin/positions', { title: 'Positions', active: 'positions', positions });
});
admin.post('/positions', requireClosed, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { flash(req, 'error', 'Enter a position name.'); return back(req, res); }
  try {
    db.db.prepare('INSERT INTO positions(name) VALUES(?)').run(name);
    flash(req, 'success', `Added position "${name}".`);
  } catch (e) {
    flash(req, 'error', 'A position with that name already exists.');
  }
  back(req, res);
});
admin.post('/positions/:id/edit', requireClosed, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { flash(req, 'error', 'Enter a position name.'); return back(req, res); }
  try {
    db.db.prepare('UPDATE positions SET name=? WHERE id=?').run(name, toInt(req.params.id));
    flash(req, 'success', 'Position renamed.');
  } catch (e) {
    flash(req, 'error', 'A position with that name already exists.');
  }
  back(req, res);
});
admin.post('/positions/:id/delete', requireClosed, (req, res) => {
  const id = toInt(req.params.id);
  const photos = db.db.prepare('SELECT photo FROM candidates WHERE position_id=?').all(id);
  db.db.prepare('DELETE FROM positions WHERE id=?').run(id);
  photos.forEach(p => removePhoto(p.photo));
  flash(req, 'success', 'Position deleted along with its candidates.');
  back(req, res);
});

// ----- candidates -----
admin.get('/candidates', (req, res) => {
  const positions = db.db.prepare('SELECT * FROM positions ORDER BY id').all();
  const stmt = db.db.prepare('SELECT * FROM candidates WHERE position_id=? ORDER BY id');
  positions.forEach(p => { p.candidates = stmt.all(p.id); });
  res.render('admin/candidates', { title: 'Candidates', active: 'candidates', positions });
});
admin.post('/candidates', requireClosed, handleUpload(photoUpload), (req, res) => {
  const name = String(req.body.name || '').trim();
  const positionId = toInt(req.body.position_id);
  const position = positionId && db.db.prepare('SELECT 1 FROM positions WHERE id=?').get(positionId);
  if (!name || !position) {
    removePhoto(req.file && req.file.filename);
    flash(req, 'error', 'Enter a name and choose a position.');
    return back(req, res);
  }
  db.db.prepare('INSERT INTO candidates(position_id, name, photo) VALUES(?, ?, ?)')
    .run(positionId, name, req.file ? req.file.filename : null);
  flash(req, 'success', `Added ${name}.`);
  back(req, res);
});
admin.post('/candidates/:id/edit', requireClosed, handleUpload(photoUpload), (req, res) => {
  const id = toInt(req.params.id);
  const cand = db.db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
  const name = String(req.body.name || '').trim();
  const positionId = toInt(req.body.position_id);
  const position = positionId && db.db.prepare('SELECT 1 FROM positions WHERE id=?').get(positionId);
  if (!cand || !name || !position) {
    removePhoto(req.file && req.file.filename);
    flash(req, 'error', 'Enter a name and choose a position.');
    return back(req, res);
  }
  let photo = cand.photo;
  if (req.file) { removePhoto(cand.photo); photo = req.file.filename; }
  // Moving a candidate to another position invalidates votes cast for the old one.
  if (cand.position_id !== positionId) {
    db.db.prepare('DELETE FROM votes WHERE candidate_id=?').run(id);
  }
  db.db.prepare('UPDATE candidates SET name=?, position_id=?, photo=? WHERE id=?').run(name, positionId, photo, id);
  flash(req, 'success', 'Candidate updated.');
  back(req, res);
});
admin.post('/candidates/:id/suspend', (req, res) => {
  const id = toInt(req.params.id);
  db.db.prepare('UPDATE candidates SET suspended = 1 - suspended WHERE id=?').run(id);
  const c = db.db.prepare('SELECT name, suspended FROM candidates WHERE id=?').get(id);
  if (c) flash(req, 'success', c.suspended ? `${c.name} is suspended. Their votes are excluded from results.` : `${c.name} is reinstated. Their votes count again.`);
  back(req, res);
});
admin.post('/candidates/:id/delete', requireClosed, (req, res) => {
  const id = toInt(req.params.id);
  const c = db.db.prepare('SELECT photo FROM candidates WHERE id=?').get(id);
  db.db.prepare('DELETE FROM candidates WHERE id=?').run(id);
  if (c) removePhoto(c.photo);
  flash(req, 'success', 'Candidate deleted.');
  back(req, res);
});

// ----- voters -----
admin.get('/voters', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db.db.prepare(`
    SELECT student_id, name, has_voted FROM voters
    WHERE (? = '' OR student_id LIKE ? OR name LIKE ?)
    ORDER BY name LIMIT 300`).all(q, like, like);
  const total = db.db.prepare('SELECT COUNT(*) AS n FROM voters').get().n;
  const voted = db.db.prepare('SELECT COUNT(*) AS n FROM voters WHERE has_voted=1').get().n;
  res.render('admin/voters', { title: 'Voters', active: 'voters', rows, total, voted, q });
});

const headerKey = k => String(k).toLowerCase().replace(/[^a-z]/g, '');
admin.post('/voters/upload', handleUpload(sheetUpload), (req, res) => {
  if (!req.file) { flash(req, 'error', 'Choose an Excel file (.xlsx) to upload.'); return back(req, res); }
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) {
    flash(req, 'error', 'That file could not be read. Upload a valid .xlsx file.');
    return back(req, res);
  }
  const idKeys = ['id', 'studentid'];
  const nameKeys = ['name', 'fullname', 'studentname'];
  const list = [];
  const seen = new Set();
  let skipped = 0, foundColumns = false;
  for (const row of rows) {
    const map = {};
    Object.keys(row).forEach(k => { map[headerKey(k)] = row[k]; });
    const idKey = idKeys.find(k => k in map);
    const nameKey = nameKeys.find(k => k in map);
    if (!idKey || !nameKey) continue;
    foundColumns = true;
    const id = normalizeId(map[idKey]);
    const name = String(map[nameKey]).trim();
    if (!id || !name || seen.has(id)) { skipped++; continue; }
    seen.add(id);
    list.push({ id, name });
  }
  if (!foundColumns) {
    flash(req, 'error', 'The first row must contain columns named "name" and "id".');
    return back(req, res);
  }
  const { added, updated } = db.upsertVoters(list);
  flash(req, 'success', `Voters list uploaded: ${added} added, ${updated} updated, ${skipped} skipped (blank or duplicate rows).`);
  back(req, res);
});
admin.post('/voters/delete', (req, res) => {
  const id = normalizeId(req.body.student_id);
  const r = db.db.prepare('DELETE FROM voters WHERE student_id=? AND has_voted=0').run(id);
  flash(req, r.changes ? 'success' : 'error', r.changes ? 'Voter removed.' : 'Voters who have already voted cannot be removed.');
  back(req, res);
});

// ----- PDF export -----
admin.get('/export.pdf', (req, res) => {
  const results = db.getResults();
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="election-results.pdf"');
  doc.pipe(res);

  const left = 50, width = 495;
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#1b2430').text(config.ELECTION_NAME, left, 50);
  doc.font('Helvetica').fontSize(11).fillColor('#5b6673')
    .text(`Results generated ${new Date().toLocaleString()}`)
    .text(`Voting is currently ${db.isVotingOpen() ? 'open' : 'closed'}`);
  doc.moveDown(0.8);

  const t = results.turnout;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1b2430').text('Turnout', left, doc.y);
  doc.font('Helvetica').fontSize(12)
    .text(`${t.voted} of ${t.total} eligible voters have voted (${t.percent}%)`, left, doc.y + 2);
  doc.moveDown(1.2);

  const ROW = 52;
  results.positions.forEach(pos => {
    const active = pos.candidates.filter(c => !c.suspended).sort((a, b) => b.votes - a.votes);
    if (doc.y + 40 + ROW > doc.page.height - 60) doc.addPage();

    doc.font('Helvetica-Bold').fontSize(15).fillColor('#0b6b66').text(pos.name, left, doc.y);
    doc.font('Helvetica').fontSize(10).fillColor('#5b6673')
      .text(`${pos.totalVotes} vote${pos.totalVotes === 1 ? '' : 's'} counted`, left, doc.y);
    doc.moveDown(0.4);

    if (!active.length) {
      doc.fontSize(11).fillColor('#5b6673').text('No active candidates.', left, doc.y);
      doc.moveDown(1);
      return;
    }

    active.forEach(c => {
      if (doc.y + ROW > doc.page.height - 60) doc.addPage();
      const y = doc.y;
      if (c.leader) doc.rect(left, y, width, ROW - 4).fill('#fdf0c8');
      else doc.rect(left, y, width, ROW - 4).lineWidth(0.5).stroke('#d9dee4');

      let drewPhoto = false;
      if (c.photo) {
        const p = path.join(uploadsDir, path.basename(c.photo));
        if (fs.existsSync(p)) {
          try { doc.image(p, left + 6, y + 4, { fit: [40, 40], align: 'center', valign: 'center' }); drewPhoto = true; } catch (e) { /* skip */ }
        }
      }
      if (!drewPhoto) doc.circle(left + 26, y + 24, 18).fill('#e3e8ed');

      doc.fillColor('#1b2430').font('Helvetica-Bold').fontSize(12)
        .text(c.name, left + 60, y + 10, { width: 250, lineBreak: false });
      if (c.leader) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#8a5a00')
          .text(pos.tie ? 'TIE FOR FIRST' : 'WINNER', left + 60, y + 28, { lineBreak: false });
      }
      doc.font('Helvetica').fontSize(12).fillColor('#1b2430')
        .text(`${c.votes} vote${c.votes === 1 ? '' : 's'}`, left + 330, y + 16, { width: 80, lineBreak: false })
        .text(`${c.percent}%`, left + 420, y + 16, { width: 60, align: 'right', lineBreak: false });
      doc.y = y + ROW;
    });
    doc.moveDown(0.8);
  });

  doc.font('Helvetica').fontSize(9).fillColor('#5b6673')
    .text('Suspended candidates are excluded from this report.', left, doc.y + 4);
  doc.end();
});

app.use('/admin', admin);

app.use((req, res) => res.status(404).render('voter/error', { title: 'Not found', area: 'voter', message: 'That page does not exist.' }));

app.listen(config.PORT, () => {
  console.log(`\n  Voting system running`);
  console.log(`  Voters: http://localhost:${config.PORT}/`);
  console.log(`  Admin:  http://localhost:${config.PORT}/admin  (user: ${config.ADMIN_USERNAME})\n`);
});
