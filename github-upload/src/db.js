// Queries against Cloudflare D1 (SQLite). The schema lives in migrations/.

let d1;

// The D1 binding is the same object for every request, so it's set once
// per request by middleware rather than threaded through every call.
export function use(binding) {
  d1 = binding;
}

const q = (sql, ...params) => d1.prepare(sql).bind(...params);

// --- Members ---------------------------------------------------------------

export async function createMember({ username, displayName, passwordHash }) {
  const { meta } = await q(
    'INSERT INTO members (username, display_name, password_hash) VALUES (?, ?, ?)',
    username, displayName, passwordHash,
  ).run();
  return meta.last_row_id;
}

export function getMemberByUsername(username) {
  return q('SELECT * FROM members WHERE username = ?', username).first();
}

export function getMember(id) {
  return q('SELECT id, username, display_name FROM members WHERE id = ?', id).first();
}

export async function listMembers() {
  const { results } = await q(`
    SELECT m.id, m.display_name,
      (SELECT COUNT(*) FROM books b WHERE b.owner_id = m.id) AS owned,
      (SELECT COUNT(*) FROM loans l WHERE l.holder_id = m.id AND l.ended_at IS NULL) AS holding
    FROM members m
    ORDER BY m.display_name COLLATE NOCASE
  `).all();
  return results;
}

// --- Sessions --------------------------------------------------------------

export async function createSession(token, memberId, days) {
  await d1.batch([
    q("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    q(`INSERT INTO sessions (token, member_id, expires_at)
       VALUES (?, ?, datetime('now', ?))`, token, memberId, `+${days} days`),
  ]);
}

export function getSessionMember(token) {
  return q(`
    SELECT m.id, m.username, m.display_name
    FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `, token).first();
}

export async function deleteSession(token) {
  await q('DELETE FROM sessions WHERE token = ?', token).run();
}

// --- Books -----------------------------------------------------------------

// Every book query returns where the book currently is: holder_* is NULL when
// it's with the owner.
const BOOK_SELECT = `
  SELECT b.*, o.display_name AS owner_name,
         l.holder_id, h.display_name AS holder_name, l.started_at AS loaned_at
  FROM books b
  JOIN members o ON o.id = b.owner_id
  LEFT JOIN loans l ON l.book_id = b.id AND l.ended_at IS NULL
  LEFT JOIN members h ON h.id = l.holder_id
`;

export async function listBooks({ q: search = '', filter = 'all', memberId }) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(b.title LIKE ? OR b.author LIKE ? OR b.isbn = ?)');
    params.push(`%${search}%`, `%${search}%`, search);
  }
  if (filter === 'available') where.push('l.id IS NULL');
  if (filter === 'mine') { where.push('b.owner_id = ?'); params.push(memberId); }
  if (filter === 'holding') { where.push('l.holder_id = ?'); params.push(memberId); }
  if (filter === 'lent') { where.push('b.owner_id = ? AND l.id IS NOT NULL'); params.push(memberId); }

  const sql = BOOK_SELECT
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY b.title COLLATE NOCASE';
  const { results } = await q(sql, ...params).all();
  return results;
}

export function getBook(id) {
  return q(`${BOOK_SELECT} WHERE b.id = ?`, id).first();
}

export async function createBook(ownerId, { title, author, isbn, coverUrl, notes }) {
  const { meta } = await q(`
    INSERT INTO books (owner_id, title, author, isbn, cover_url, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `, ownerId, title, author, isbn, coverUrl, notes).run();
  return meta.last_row_id;
}

export async function updateBook(id, { title, author, isbn, coverUrl, notes }) {
  await q(`
    UPDATE books SET title = ?, author = ?, isbn = ?, cover_url = ?, notes = ?
    WHERE id = ?
  `, title, author, isbn, coverUrl, notes, id).run();
}

export async function deleteBook(id) {
  await q('DELETE FROM books WHERE id = ?', id).run();
}

// Another member's copy of the same edition, preferring one with a cover.
export function findByIsbn(isbn) {
  return q(`
    SELECT b.title, b.author, b.cover_url, m.display_name AS owner_name
    FROM books b JOIN members m ON m.id = b.owner_id
    WHERE b.isbn = ?
    ORDER BY b.cover_url != '' DESC, b.id
    LIMIT 1
  `, isbn).first();
}

// --- Covers ----------------------------------------------------------------

export async function getCover(bookId) {
  const row = await q('SELECT mime, data FROM covers WHERE book_id = ?', bookId).first();
  // D1 returns BLOBs as arrays of byte values.
  return row && { mime: row.mime, data: new Uint8Array(row.data) };
}

export async function saveCover(bookId, mime, data) {
  await q(`
    INSERT INTO covers (book_id, mime, data) VALUES (?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET mime = excluded.mime, data = excluded.data
  `, bookId, mime, data).run();
}

// Returns false if the source book has no uploaded cover.
export async function copyCover(fromBookId, toBookId) {
  const { meta } = await q(`
    INSERT OR REPLACE INTO covers (book_id, mime, data)
    SELECT ?, mime, data FROM covers WHERE book_id = ?
  `, toBookId, fromBookId).run();
  return meta.changes > 0;
}

export async function deleteCover(bookId) {
  await q('DELETE FROM covers WHERE book_id = ?', bookId).run();
}

export async function setCoverUrl(bookId, url) {
  await q('UPDATE books SET cover_url = ? WHERE id = ?', url, bookId).run();
}

// --- Loans -----------------------------------------------------------------

// Moves a book to a member. Handing it to the owner means it's back home.
// The statements run as one atomic batch.
export async function handOver(book, toMemberId) {
  const statements = [
    q("UPDATE loans SET ended_at = datetime('now') WHERE book_id = ? AND ended_at IS NULL", book.id),
  ];
  if (toMemberId !== book.owner_id) {
    statements.push(q('INSERT INTO loans (book_id, holder_id) VALUES (?, ?)', book.id, toMemberId));
  }
  await d1.batch(statements);
}

export async function loanHistory(bookId) {
  const { results } = await q(`
    SELECT l.started_at, l.ended_at, m.display_name AS holder_name
    FROM loans l JOIN members m ON m.id = l.holder_id
    WHERE l.book_id = ?
    ORDER BY l.started_at DESC, l.id DESC
  `, bookId).all();
  return results;
}
