-- HK-003: platform persistence for CT-002 (ingestion, jobs) and CT-003
-- (projects, takes, immutable revisions). TigerData / PostgreSQL.
--
-- Ownership and revision relationships are relational: every row hangs off
-- projects(id), and projects.owner_id is the Supabase auth user ID. Small
-- documents (take manifests, contract records) are JSONB. Binary media lives
-- in private object storage; rows hold only its storage key and hash.
--
-- Contract records are kept verbatim in `doc` (exact timestamp strings and
-- optional fields round-trip); the other columns are projections of `doc`
-- used for ownership, uniqueness and ordering. Both are written together.

create table projects (
  id             text primary key check (id ~ '^prj_'),
  owner_id       text not null check (char_length(owner_id) between 1 and 128),
  title          text not null check (char_length(title) between 1 and 120),
  active_take_id text not null,
  created_at     timestamptz not null,
  updated_at     timestamptz not null
);
create index projects_owner_idx on projects (owner_id, updated_at desc);

create table revisions (
  id                 text primary key check (id ~ '^rev_'),
  project_id         text not null,
  take_id            text not null,
  number             integer not null check (number >= 1),
  parent_revision_id text references revisions (id),
  origin             text not null check (origin in ('create', 'save', 'fork')),
  manifest           jsonb not null,
  manifest_hash      text not null check (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at         timestamptz not null,
  created_by         text not null,
  idempotency_key    text not null,
  message            text check (char_length(message) <= 200),
  -- Compare-and-swap backstop: two writers can never both create number N.
  unique (project_id, take_id, number)
);

-- A take's head pointer. Saves lock this row (SELECT ... FOR UPDATE), compare
-- head_revision with expectedRevision, then append a revision and move the
-- head inside the same transaction.
create table takes (
  project_id         text not null references projects (id) on delete cascade,
  id                 text not null check (id ~ '^tk_'),
  name               text not null,
  parent_take_id     text,
  parent_revision_id text references revisions (id),
  head_revision      integer not null check (head_revision >= 1),
  head_revision_id   text not null references revisions (id) deferrable initially deferred,
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  primary key (project_id, id),
  check ((parent_take_id is null) = (parent_revision_id is null))
);

alter table revisions
  add constraint revisions_take_fk foreign key (project_id, take_id)
  references takes (project_id, id) on delete cascade deferrable initially deferred;

create table assets (
  project_id   text not null references projects (id) on delete cascade,
  id           text not null check (id ~ '^ast_'),
  kind         text not null,
  mime_type    text not null,
  byte_size    bigint not null check (byte_size >= 0),
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  storage_key  text not null,
  origin       text not null,
  created_at   timestamptz not null,
  doc          jsonb not null,
  primary key (project_id, id)
);

-- Capture sessions (CT-005). No port writes them yet; the capture lane owns
-- the lifecycle. Sources may reference a session ID before it is stored, so
-- sources.capture_session_id is intentionally not a foreign key.
create table capture_sessions (
  project_id       text not null references projects (id) on delete cascade,
  id               text not null check (id ~ '^cap_'),
  kind             text not null check (kind in ('chert_facetime', 'phone_camera')),
  state            text not null,
  provider_call_id text,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  doc              jsonb not null,
  primary key (project_id, id)
);

create table sources (
  project_id         text not null references projects (id) on delete cascade,
  id                 text not null check (id ~ '^src_'),
  adapter            text not null,
  media_kind         text not null check (media_kind in ('image', 'video', 'live_stream')),
  asset_id           text,
  content_hash       text,
  capture_session_id text,
  created_at         timestamptz not null,
  doc                jsonb not null,
  primary key (project_id, id),
  foreign key (project_id, asset_id) references assets (project_id, id)
);

-- Idempotency: (source, sequence) is unique; ingest locks the source row so
-- classification (new / duplicate / out of order) is serialized per source.
create table observations (
  project_id         text not null,
  id                 text not null check (id ~ '^obs_'),
  source_id          text not null,
  sequence           bigint not null check (sequence >= 0),
  source_time_us     bigint not null check (source_time_us >= 0),
  frame_asset_id     text not null,
  frame_content_hash text not null,
  mode               text not null check (mode in ('evidence', 'preview')),
  out_of_order       boolean not null,
  received_at        timestamptz not null,
  doc                jsonb not null,
  primary key (project_id, id),
  unique (project_id, source_id, sequence),
  foreign key (project_id, source_id) references sources (project_id, id) on delete cascade,
  foreign key (project_id, frame_asset_id) references assets (project_id, id)
);
create index observations_source_time_idx
  on observations (project_id, source_id, source_time_us, sequence);

create table jobs (
  project_id          text not null references projects (id) on delete cascade,
  id                  text not null check (id ~ '^job_'),
  kind                text not null,
  state               text not null
    check (state in ('queued', 'submitted', 'running', 'succeeded', 'failed', 'canceled')),
  provider            text not null,
  provider_model      text not null,
  provider_request_id text,
  input_hash          text not null,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  doc                 jsonb not null,
  primary key (project_id, id)
);

-- Retry keys for create/save/fork. Written in the same transaction as the
-- revision, so a replay returns exactly the committed response. The
-- fingerprint is the sha256 of the canonical request JSON.
create table idempotency_keys (
  scope       text not null,
  key         text not null,
  fingerprint text not null,
  response    jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (scope, key)
);
