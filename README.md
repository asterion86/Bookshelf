# Bookshelf

A small communal book-lending tracker. Members list the books they own, anyone
can borrow them, and the app keeps track of who has each book and where it's been.

- Runs on **Cloudflare Workers**, using [Hono](https://hono.dev) as the only runtime dependency
- Data is stored in **Cloudflare D1** (SQLite). The schema lives in `migrations/`
- Server-rendered HTML with no build step. The only browser JavaScript is on the add/edit book form
- Cover photos are stored in the database, shrunk on the device to ~600px (about 50–100 KB each)

## How lending works

- Every book has an **owner**. When nobody has borrowed it, it's "with the owner".
- **Borrow / I've got it now**: any member can mark themselves as holding a book.
  The group is small and trusts each other, and the history shows who claimed what.
- **Pass on to…**: the current holder (or the owner) can hand it to another member,
  for example if Bob passes Alice's book straight to Carol.
- **Returned**: the holder or the owner marks it as back home.
- Each book page shows its full lending history.

Joining needs a shared **group code** (the `INVITE_CODE` secret), which you can post
in the group chat. Nobody gets email, and nobody needs an admin.

## Adding books

Type an ISBN and press **Look up**. The app checks two places, in this order:

1. **Books already on the shelf.** If another member has added the same edition,
   its title, author and cover photo are copied. This is the main source for
   Lithuanian books, so the catalogue improves as the group adds books.
2. **[Open Library](https://openlibrary.org/developers/api)** (free, no key), which
   is good for English and translated books.

If neither has the book, type the title and author, then tap **Take or choose a
photo** to photograph the cover. On a phone this offers the camera directly.

## Run it locally

You need Node.js 20 or newer. Wrangler runs a local copy of Workers and D1,
with no Cloudflare account needed.

1. Install the dependencies:
   ```bash
   npm install
   ```
2. Copy the example settings file. It sets the group code to `letmein`:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
3. Create the local database:
   ```bash
   npm run db:migrate:local
   ```
4. Start the app:
   ```bash
   npm run dev
   ```
5. Open http://localhost:8787, join with the code `letmein`, and add a book.

Local data is kept in `.wrangler/state/`.

## Deploying to Cloudflare

These steps are needed once.

1. Log in to Cloudflare:
   ```bash
   npx wrangler login
   ```
2. Create the database:
   ```bash
   npx wrangler d1 create bookshelf
   ```
3. Copy the `database_id` it prints into `wrangler.jsonc`.
4. Create the tables:
   ```bash
   npm run db:migrate:remote
   ```
5. Set the group code. Wrangler prompts you for the value:
   ```bash
   npx wrangler secret put INVITE_CODE
   ```
6. Deploy the app:
   ```bash
   npm run deploy
   ```

The app is then live at `https://bookshelf.<your-subdomain>.workers.dev`. You can
add your own domain in the Cloudflare dashboard.

### Updating

Run `npm run deploy` again after changing code. This never touches the data.

### Changing the data structure

Never edit a migration that has already been applied. Instead:

1. Add a new numbered file, such as `migrations/0002_add_language.sql`, containing
   e.g. `ALTER TABLE books ADD COLUMN language TEXT NOT NULL DEFAULT ''`.
2. Apply it locally:
   ```bash
   npm run db:migrate:local
   ```
3. Apply it to the live database:
   ```bash
   npm run db:migrate:remote
   ```
4. Deploy the new code:
   ```bash
   npm run deploy
   ```

Wrangler records which migrations each database has had, so each one runs exactly once.

### Backups

D1 keeps a point-in-time history ("Time Travel") that lets you restore to an
earlier moment. For a copy of your own, export the database:

```bash
npx wrangler d1 export bookshelf --remote --output backup.sql
```

## Project layout

```
src/server.js     routes (Worker entry point)
src/db.js         D1 queries
src/auth.js       password hashing (PBKDF2) and sessions
src/views.js      HTML pages
migrations/       database schema, applied in order
public/           stylesheet and book form script (ISBN lookup, photo resizing)
wrangler.jsonc    Cloudflare configuration
```
