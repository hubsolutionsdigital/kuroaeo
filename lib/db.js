const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client_name TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One uploaded sheet (kind = 'table') or blog document (kind = 'doc').
  -- Re-uploading a sheet with the same tab + name each month creates a new
  -- version; the client can switch between versions by period.
  CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tab TEXT NOT NULL,
    name TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'table',
    columns TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    source_file TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- item_key is stable across versions (e.g. "keywords:family lawyer singapore"),
  -- so feedback on a keyword follows it from month to month.
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tab TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'row',
    item_key TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS items_dataset ON items(dataset_id, position);
  CREATE INDEX IF NOT EXISTS items_key ON items(project_id, item_key);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES feedback(id) ON DELETE CASCADE,
    dataset_id INTEGER,
    tab TEXT NOT NULL DEFAULT '',
    item_key TEXT NOT NULL,
    item_label TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    author_role TEXT NOT NULL DEFAULT 'client',
    name TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    quote TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'noted',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS feedback_project ON feedback(project_id, created_at);
`);

// Words the client changed directly in a blog or landing page, one row per
// paragraph (block) of an article, for the uploaded version they edited.
db.exec(`
  CREATE TABLE IF NOT EXISTS doc_edits (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    block INTEGER NOT NULL,
    original_html TEXT NOT NULL,
    html TEXT NOT NULL,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (dataset_id, item_key, block)
  );
`);

// Columns added after the first release.
const datasetCols = db.prepare('PRAGMA table_info(datasets)').all().map((c) => c.name);
if (!datasetCols.includes('phase')) db.exec('ALTER TABLE datasets ADD COLUMN phase INTEGER');
const feedbackCols = db.prepare('PRAGMA table_info(feedback)').all().map((c) => c.name);
// The section of a blog article a comment is about, e.g. "Hearing Loss and Dementia".
if (!feedbackCols.includes('area')) db.exec("ALTER TABLE feedback ADD COLUMN area TEXT NOT NULL DEFAULT ''");

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, transaction, DATA_DIR };
