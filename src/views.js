// Server-rendered pages. The html`` helper escapes every interpolated value.
import { html } from 'hono/html';

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS".
function formatDate(sqlDate) {
  if (!sqlDate) return '';
  return new Date(sqlDate.replace(' ', 'T') + 'Z')
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function layout({ siteName = 'Bookshelf', title, member, body }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · ${siteName}` : siteName}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="/">${siteName}</a>
    ${member ? html`
      <nav>
        <a href="/books/new">Add a book</a>
        <a href="/members">Members</a>
        <form method="post" action="/logout" class="inline">
          <button class="link">Log out ${member.display_name}</button>
        </form>
      </nav>` : ''}
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function whereabouts(book) {
  if (!book.holder_id) return html`<span class="status available">With ${book.owner_name}</span>`;
  return html`<span class="status on-loan">With ${book.holder_name} since ${formatDate(book.loaned_at)}</span>`;
}

function cover(book, cls = 'cover') {
  return book.cover_url
    ? html`<img class="${cls}" src="${book.cover_url}" alt="" loading="lazy">`
    : html`<div class="${cls} placeholder">${book.title}</div>`;
}

const FILTERS = [
  ['all', 'All books'],
  ['available', 'Available'],
  ['mine', 'My books'],
  ['lent', 'I’ve lent out'],
  ['holding', 'I’m borrowing'],
];

export function bookList({ books, q, filter }) {
  return html`
    <form class="search" method="get" action="/">
      <input type="search" name="q" value="${q}" placeholder="Search title, author or ISBN">
      <input type="hidden" name="filter" value="${filter}">
      <button>Search</button>
    </form>
    <div class="filters">
      ${FILTERS.map(([key, label]) => html`
        <a class="${key === filter ? 'active' : ''}"
           href="/?filter=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}">${label}</a>`)}
    </div>
    ${books.length === 0
      ? html`<p class="empty">No books here yet. <a href="/books/new">Add one?</a></p>`
      : html`<ul class="book-grid">
          ${books.map((b) => html`
            <li>
              <a href="/books/${b.id}" class="book-card">
                ${cover(b)}
                <strong>${b.title}</strong>
                <span class="muted">${b.author}</span>
                <span class="muted small">Owned by ${b.owner_name}</span>
                ${whereabouts(b)}
              </a>
            </li>`)}
        </ul>`}`;
}

function memberSelect(members, excludeId) {
  return html`<select name="member_id" required>
    <option value="">Choose a member…</option>
    ${members.filter((m) => m.id !== excludeId).map((m) => html`
      <option value="${m.id}">${m.display_name}</option>`)}
  </select>`;
}

export function bookDetail({ book, member, members, history }) {
  const isOwner = book.owner_id === member.id;
  const holderId = book.holder_id ?? book.owner_id;
  const isHolder = holderId === member.id;

  return html`
    <article class="book-detail">
      ${cover(book, 'cover large')}
      <div>
        <h1>${book.title}</h1>
        ${book.author ? html`<p class="author">${book.author}</p>` : ''}
        <p class="muted">Owned by ${book.owner_name}${book.isbn ? html` · ISBN ${book.isbn}` : ''}</p>
        <p>${whereabouts(book)}</p>
        ${book.notes ? html`<p class="notes">${book.notes}</p>` : ''}

        <div class="actions">
          ${!isHolder ? html`
            <form method="post" action="/books/${book.id}/take">
              <button class="primary">${book.holder_id ? 'I’ve got it now' : 'Borrow'}</button>
            </form>` : ''}
          ${book.holder_id && (isHolder || isOwner) ? html`
            <form method="post" action="/books/${book.id}/return">
              <button>${isOwner ? 'Mark as returned' : `Returned to ${book.owner_name}`}</button>
            </form>` : ''}
          ${isHolder || isOwner ? html`
            <form method="post" action="/books/${book.id}/handover" class="handover">
              <label>${isOwner && !book.holder_id ? 'Lend to' : 'Pass on to'}
                ${memberSelect(members, holderId)}
              </label>
              <button>Hand over</button>
            </form>` : ''}
        </div>

        ${isOwner ? html`
          <p class="owner-tools">
            <a href="/books/${book.id}/edit">Edit details</a>
            <form method="post" action="/books/${book.id}/delete" class="inline"
                  onsubmit="return confirm('Remove this book and its history?')">
              <button class="link danger">Remove book</button>
            </form>
          </p>` : ''}
      </div>
    </article>

    <section>
      <h2>History</h2>
      ${history.length === 0
        ? html`<p class="muted">Never been lent out.</p>`
        : html`<ul class="history">
            ${history.map((h) => html`
              <li>
                <strong>${h.holder_name}</strong>
                ${formatDate(h.started_at)} – ${h.ended_at ? formatDate(h.ended_at) : 'now'}
              </li>`)}
          </ul>`}
    </section>`;
}

export function bookForm({ book = {}, action, heading, error }) {
  return html`
    <h1>${heading}</h1>
    ${error ? html`<p class="error">${error}</p>` : ''}
    <form method="post" action="${action}" enctype="multipart/form-data" class="stack" id="book-form">
      <label>ISBN <span class="muted small">(optional — fills in the rest)</span>
        <span class="row">
          <input name="isbn" value="${book.isbn ?? ''}" inputmode="numeric" autocomplete="off">
          <button type="button" id="lookup">Look up</button>
        </span>
        <span id="lookup-status" class="muted small"></span>
      </label>
      <label>Title <input name="title" value="${book.title ?? ''}" required></label>
      <label>Author <input name="author" value="${book.author ?? ''}"></label>

      <fieldset class="cover-field">
        <legend>Cover</legend>
        <img id="cover-preview" class="cover" src="${book.cover_url ?? ''}" alt=""
             ${book.cover_url ? '' : html`hidden`}>
        <div class="cover-controls">
          <label class="file-button">Take or choose a photo
            <input type="file" name="cover_file" id="cover-file" accept="image/*">
          </label>
          <button type="button" id="remove-cover" class="link danger"
                  ${book.cover_url ? '' : html`hidden`}>Remove cover</button>
          <span id="cover-status" class="muted small"></span>
        </div>
        <input type="hidden" name="cover_url" value="${book.cover_url ?? ''}">
      </fieldset>

      <label>Notes <span class="muted small">(condition, edition, anything)</span>
        <textarea name="notes" rows="3">${book.notes ?? ''}</textarea>
      </label>
      <button class="primary">Save</button>
    </form>
    <script src="/book-form.js" defer></script>`;
}

export function membersPage({ members }) {
  return html`
    <h1>Members</h1>
    <table class="members">
      <thead><tr><th>Name</th><th>Books owned</th><th>Currently borrowing</th></tr></thead>
      <tbody>
        ${members.map((m) => html`
          <tr><td>${m.display_name}</td><td>${m.owned}</td><td>${m.holding}</td></tr>`)}
      </tbody>
    </table>`;
}

export function loginPage({ error, username = '' }) {
  return html`
    <div class="auth">
      <h1>Log in</h1>
      ${error ? html`<p class="error">${error}</p>` : ''}
      <form method="post" action="/login" class="stack">
        <label>Username <input name="username" value="${username}" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="primary">Log in</button>
      </form>
      <p class="muted">New here? <a href="/signup">Join with the group code</a></p>
    </div>`;
}

export function signupPage({ error, values = {} }) {
  return html`
    <div class="auth">
      <h1>Join</h1>
      ${error ? html`<p class="error">${error}</p>` : ''}
      <form method="post" action="/signup" class="stack">
        <label>Group code <span class="muted small">(ask in the group chat)</span>
          <input name="invite_code" value="${values.invite_code ?? ''}" required>
        </label>
        <label>Your name <input name="display_name" value="${values.display_name ?? ''}" required></label>
        <label>Username <input name="username" value="${values.username ?? ''}" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
        <button class="primary">Create account</button>
      </form>
      <p class="muted">Already joined? <a href="/login">Log in</a></p>
    </div>`;
}

export function notFound() {
  return html`<h1>Not found</h1><p><a href="/">Back to the shelf</a></p>`;
}
