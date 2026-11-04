// Cloudflare Worker entry point. Static files in public/ are served by
// Cloudflare before requests reach this app.
import { Hono } from 'hono';
import * as db from './db.js';
import * as views from './views.js';
import {
  hashPassword, verifyPassword, startSession, endSession, sessionToken, loadMember, requireMember,
} from './auth.js';

const app = new Hono();

app.use('*', async (c, next) => {
  db.use(c.env.DB);
  await next();
});
app.use('*', loadMember);

const page = (c, title, body, status = 200) =>
  c.html(views.layout({ siteName: c.env.SITE_NAME, title, member: c.get('member'), body }), status);

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Letters from any alphabet (ą, č, š, ž…), digits, dots, dashes, underscores.
const USERNAME = /^[\p{L}\p{N}_.-]{2,32}$/u;
const USERNAME_RULES = 'Usernames can use letters, numbers, dots, dashes and underscores.';

// The database only ignores case for A–Z, so usernames are stored and looked
// up in lowercase to make "Šarūnas" and "šarūnas" the same login. NFC makes
// "ė" typed as one character or as e + dot match.
const usernameFrom = (v) => str(v).normalize('NFC').toLowerCase();
const MIN_PASSWORD = 8;

// --- Accounts --------------------------------------------------------------

app.get('/login', (c) => page(c, 'Log in', views.loginPage({})));

app.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const username = usernameFrom(form.username);
  const member = await db.getMemberByUsername(username);
  if (!member || !(await verifyPassword(str(form.password), member.password_hash))) {
    return page(c, 'Log in', views.loginPage({ error: 'Wrong username or password.', username }), 401);
  }
  await startSession(c, member.id);
  return c.redirect('/');
});

app.get('/signup', (c) => page(c, 'Join', views.signupPage({})));

app.post('/signup', async (c) => {
  const inviteCode = c.env.INVITE_CODE;
  const form = await c.req.parseBody();
  const values = {
    invite_code: str(form.invite_code),
    display_name: str(form.display_name),
    username: usernameFrom(form.username),
  };
  const password = typeof form.password === 'string' ? form.password : '';

  let error;
  if (!inviteCode || values.invite_code !== inviteCode) error = 'That group code isn’t right.';
  else if (!values.display_name || !values.username) error = 'Please fill in every field.';
  else if (!USERNAME.test(values.username)) error = USERNAME_RULES;
  else if (password.length < MIN_PASSWORD) error = 'Passwords need at least 8 characters.';
  else if (await db.getMemberByUsername(values.username)) error = 'That username is taken.';
  if (error) return page(c, 'Join', views.signupPage({ error, values }), 400);

  const id = await db.createMember({
    username: values.username,
    displayName: values.display_name,
    passwordHash: await hashPassword(password),
  });
  await startSession(c, id);
  return c.redirect('/');
});

app.post('/logout', async (c) => {
  await endSession(c);
  return c.redirect('/login');
});

// Everything below needs a logged-in member.
app.use('*', requireMember);

// --- Your account ----------------------------------------------------------

const accountPage = (c, props, status = 200) =>
  page(c, 'Your account', views.accountPage({ member: c.get('member'), ...props }), status);

app.get('/account', (c) => accountPage(c, { saved: c.req.query('saved') }));

app.post('/account', async (c) => {
  const me = c.get('member');
  const form = await c.req.parseBody();
  const values = { display_name: str(form.display_name), username: usernameFrom(form.username) };

  let error;
  if (!values.display_name || !values.username) error = 'Please fill in both fields.';
  else if (!USERNAME.test(values.username)) error = USERNAME_RULES;
  else {
    const existing = await db.getMemberByUsername(values.username);
    if (existing && existing.id !== me.id) error = 'That username is taken.';
  }
  if (error) return accountPage(c, { values, detailsError: error }, 400);

  await db.updateMember(me.id, { username: values.username, displayName: values.display_name });
  return c.redirect('/account?saved=details');
});

app.post('/account/password', async (c) => {
  const me = c.get('member');
  const form = await c.req.parseBody();
  const current = typeof form.current_password === 'string' ? form.current_password : '';
  const next = typeof form.new_password === 'string' ? form.new_password : '';

  const { password_hash } = await db.getMemberByUsername(me.username);
  let error;
  if (!(await verifyPassword(current, password_hash))) error = 'Your current password isn’t right.';
  else if (next.length < MIN_PASSWORD) error = 'New passwords need at least 8 characters.';
  if (error) return accountPage(c, { passwordError: error }, 400);

  await db.updatePassword(me.id, await hashPassword(next));
  await db.deleteOtherSessions(me.id, sessionToken(c));
  return c.redirect('/account?saved=password');
});

// --- Books -----------------------------------------------------------------

app.get('/', async (c) => {
  const q = str(c.req.query('q'));
  const filter = c.req.query('filter') || 'all';
  const books = await db.listBooks({ q, filter, memberId: c.get('member').id });
  return page(c, null, views.bookList({ books, q, filter }));
});

// An uploaded cover lives at /books/:id/cover; ?v= busts the browser cache.
const LOCAL_COVER = /^\/books\/(\d+)\/cover(\?v=\d+)?$/;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// D1 rows are limited to 2 MB, and the form shrinks photos to ~100 KB anyway.
const MAX_COVER_BYTES = 1.5 * 1024 * 1024;

const coverPath = (bookId) => `/books/${bookId}/cover?v=${Date.now()}`;

function bookFromForm(form) {
  const coverUrl = str(form.cover_url);
  return {
    title: str(form.title),
    author: str(form.author),
    isbn: str(form.isbn).replace(/[^0-9Xx]/g, '').toUpperCase(),
    coverUrl: /^https:\/\//.test(coverUrl) || LOCAL_COVER.test(coverUrl) ? coverUrl : '',
    notes: str(form.notes),
  };
}

function uploadedCover(form) {
  const file = form.cover_file;
  return file instanceof File && file.size > 0 ? file : null;
}

function formError(book, file) {
  if (!book.title) return 'A title is needed.';
  if (file && !COVER_TYPES.includes(file.type)) return 'Cover photos need to be JPEG, PNG or WebP.';
  if (file && file.size > MAX_COVER_BYTES) return 'That photo is too large (1.5 MB max).';
  return null;
}

// Runs after the book row is saved, so the cover always belongs to bookId.
async function saveCoverFor(bookId, file, coverUrl) {
  if (file) {
    await db.saveCover(bookId, file.type, await file.arrayBuffer());
    await db.setCoverUrl(bookId, coverPath(bookId));
    return;
  }
  const local = coverUrl.match(LOCAL_COVER);
  if (!local) {
    // An Open Library link, or no cover at all.
    await db.deleteCover(bookId);
  } else if (Number(local[1]) !== bookId) {
    // Reusing another member's photo of the same edition: take our own copy
    // so it survives them removing their book.
    const copied = await db.copyCover(Number(local[1]), bookId);
    await db.setCoverUrl(bookId, copied ? coverPath(bookId) : '');
  }
}

const newBookForm = (props) =>
  views.bookForm({ mode: 'new', action: '/books', heading: 'Add a book', ...props });

// After adding, members land back on an empty form (?added=<id>) so they can
// add their next book straight away.
app.get('/books/new', async (c) => {
  const addedId = Number(c.req.query('added'));
  const added = addedId ? await db.getBook(addedId) : null;
  const mine = added && added.owner_id === c.get('member').id;
  return page(c, 'Add a book', newBookForm({ added: mine ? added : null }));
});

app.post('/books', async (c) => {
  const form = await c.req.parseBody();
  const book = bookFromForm(form);
  const file = uploadedCover(form);
  const error = formError(book, file);
  if (error) {
    return page(c, 'Add a book', newBookForm({ book: { ...book, cover_url: book.coverUrl }, error }), 400);
  }
  const id = await db.createBook(c.get('member').id, book);
  await saveCoverFor(id, file, book.coverUrl);
  return c.redirect(`/books/new?added=${id}`);
});

app.get('/books/:id/cover', async (c) => {
  const cover = await db.getCover(Number(c.req.param('id')));
  if (!cover) return c.notFound();
  return c.body(cover.data, 200, {
    'Content-Type': cover.mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

// Loads :id into c.get('book') or 404s.
async function loadBook(c, next) {
  const book = await db.getBook(Number(c.req.param('id')));
  if (!book) return page(c, 'Not found', views.notFound(), 404);
  c.set('book', book);
  await next();
}

async function ownerOnly(c, next) {
  if (c.get('book').owner_id !== c.get('member').id) return c.text('Only the owner can do that.', 403);
  await next();
}

app.get('/books/:id', loadBook, async (c) => {
  const book = c.get('book');
  const [members, history] = await Promise.all([db.listMembers(), db.loanHistory(book.id)]);
  return page(c, book.title, views.bookDetail({ book, member: c.get('member'), members, history }));
});

app.get('/books/:id/edit', loadBook, ownerOnly, (c) => {
  const book = c.get('book');
  return page(c, 'Edit', views.bookForm({ book, mode: 'edit', action: `/books/${book.id}/edit`, heading: 'Edit book' }));
});

app.post('/books/:id/edit', loadBook, ownerOnly, async (c) => {
  const id = c.get('book').id;
  const form = await c.req.parseBody();
  const book = bookFromForm(form);
  const file = uploadedCover(form);
  const error = formError(book, file);
  if (error) {
    return page(c, 'Edit', views.bookForm({
      book: { ...book, cover_url: book.coverUrl }, mode: 'edit', action: `/books/${id}/edit`, heading: 'Edit book', error,
    }), 400);
  }
  await db.updateBook(id, book);
  await saveCoverFor(id, file, book.coverUrl);
  return c.redirect(`/books/${id}`);
});

app.post('/books/:id/delete', loadBook, ownerOnly, async (c) => {
  await db.deleteBook(c.get('book').id);
  return c.redirect('/?filter=mine');
});

// --- Moving books between members ------------------------------------------

// Anyone can say "I have this now" — the group trusts each other, and the
// history shows who claimed what.
app.post('/books/:id/take', loadBook, async (c) => {
  await db.handOver(c.get('book'), c.get('member').id);
  return c.redirect(`/books/${c.get('book').id}`);
});

// Only the owner or whoever has it can send it home or pass it on.
async function holderOrOwner(c, next) {
  const book = c.get('book');
  const me = c.get('member').id;
  if (me !== book.owner_id && me !== (book.holder_id ?? book.owner_id)) {
    return c.text('Only the owner or the current holder can do that.', 403);
  }
  await next();
}

app.post('/books/:id/return', loadBook, holderOrOwner, async (c) => {
  const book = c.get('book');
  await db.handOver(book, book.owner_id);
  return c.redirect(`/books/${book.id}`);
});

app.post('/books/:id/handover', loadBook, holderOrOwner, async (c) => {
  const book = c.get('book');
  const form = await c.req.parseBody();
  const to = await db.getMember(Number(form.member_id));
  if (!to) return c.text('Unknown member.', 400);
  await db.handOver(book, to.id);
  return c.redirect(`/books/${book.id}`);
});

app.get('/members', async (c) =>
  page(c, 'Members', views.membersPage({ members: await db.listMembers() })));

// --- ISBN lookup -----------------------------------------------------------

// Checks books already on the shelf first (the only source for most
// Lithuanian titles), then Open Library (free, no key).
app.get('/api/lookup', async (c) => {
  const isbn = str(c.req.query('isbn')).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (isbn.length !== 10 && isbn.length !== 13) return c.json({ found: false }, 400);

  const local = await db.findByIsbn(isbn);
  if (local) {
    return c.json({
      found: true,
      source: `${local.owner_name}’s copy`,
      title: local.title,
      author: local.author,
      cover: local.cover_url,
    });
  }

  try {
    const res = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
      { headers: { 'User-Agent': 'Bookshelf community lending app' }, signal: AbortSignal.timeout(15000) },
    );
    const data = (await res.json())[`ISBN:${isbn}`];
    if (!data) return c.json({ found: false });
    return c.json({
      found: true,
      source: 'Open Library',
      title: data.subtitle ? `${data.title}: ${data.subtitle}` : data.title,
      author: (data.authors ?? []).map((a) => a.name).join(', '),
      cover: data.cover?.medium ?? '',
    });
  } catch {
    return c.json({ found: false, error: 'Lookup failed' }, 502);
  }
});

app.notFound((c) => page(c, 'Not found', views.notFound(), 404));

export default app;
