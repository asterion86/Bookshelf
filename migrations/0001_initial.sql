-- Initial schema. Never edit a migration once it has been applied to the
-- live database: add a new numbered file instead.

CREATE TABLE members (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE books (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES members(id),
  title      TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  isbn       TEXT NOT NULL DEFAULT '',
  cover_url  TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX books_isbn ON books(isbn) WHERE isbn != '';

-- One row per spell a book spends away from its owner.
-- A book with no open loan (ended_at IS NULL) is at home with its owner.
CREATE TABLE loans (
  id         INTEGER PRIMARY KEY,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  holder_id  INTEGER NOT NULL REFERENCES members(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT
);

CREATE UNIQUE INDEX one_open_loan_per_book ON loans(book_id) WHERE ended_at IS NULL;

-- Cover photos members upload. books.cover_url points at /books/:id/cover
-- when one exists.
CREATE TABLE covers (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  mime    TEXT NOT NULL,
  data    BLOB NOT NULL
);
