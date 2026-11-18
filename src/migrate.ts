import { pool } from "./db.ts";

// Each migration runs once, in order, when the app starts. Never edit one that
// has shipped: add a new entry at the end instead.
const migrations: { id: string; sql: string }[] = [
  {
    id: "001_base",
    sql: `
      create table users (
        id serial primary key,
        name text not null,
        email text not null unique,
        password_hash text not null,
        role text not null check (role in ('owner', 'staff')),
        totp_secret text,
        totp_enabled boolean not null default false,
        office boolean not null default false,
        active boolean not null default true,
        created_at timestamptz not null default now()
      );

      create table "session" (
        sid varchar not null primary key,
        sess json not null,
        expire timestamp(6) not null
      );
      create index session_expire_idx on "session" (expire);

      create table client_groups (
        id serial primary key,
        name text not null unique,
        notes text,
        created_at timestamptz not null default now()
      );

      create table assessors (
        id serial primary key,
        name text not null unique,
        user_id integer references users(id) on delete set null,
        email text,
        home_postcode text,
        home_lat double precision,
        home_lng double precision,
        active boolean not null default true
      );

      create table clients (
        id serial primary key,
        group_id integer references client_groups(id) on delete set null,
        name text not null,
        legal_name text,
        status text not null default 'client' check (status in ('prospect', 'client', 'former')),
        business_type text,
        address1 text,
        address2 text,
        town text,
        postcode text,
        phone text,
        website text,
        assessor_id integer references assessors(id) on delete set null,
        lat double precision,
        lng double precision,
        geocoded_postcode text,
        contract_start date,
        notice_months integer not null default 3,
        first_year integer,
        monthly_pence integer,
        annual_pence integer,
        services text[] not null default '{}',
        visit_months integer[] not null default '{}',
        visit_days integer[] not null default '{}',
        visit_assessors integer[] not null default '{}',
        visit_types text[] not null default '{}',
        visit_weekdays integer[] not null default '{}',
        public_term text,
        complytrack boolean not null default false,
        left_on date,
        notes text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index clients_group_idx on clients (group_id);
      create index clients_name_idx on clients (lower(name));

      create table visits (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        year integer not null,
        month integer not null check (month between 1 and 12),
        seq integer not null default 1,
        days integer not null default 1 check (days between 1 and 5),
        assessor_id integer references assessors(id) on delete set null,
        status text not null default 'to_book'
          check (status in ('to_book', 'booked', 'done', 'cancelled')),
        booked_on date,
        booked_time text,
        done_on date,
        notes text,
        visit_type text check (visit_type in ('fire', 'food', 'general', 'compliance')),
        -- Calendar invites and who has accepted them.
        invite_sequence integer not null default 0,
        invited_at timestamptz,
        invite_client_email text,
        invite_assessor_email text,
        client_token text unique,
        assessor_token text unique,
        client_response text check (client_response in ('accepted', 'change')),
        client_response_at timestamptz,
        client_response_note text,
        assessor_response text check (assessor_response in ('accepted', 'change')),
        assessor_response_at timestamptz,
        assessor_response_note text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (client_id, year, seq)
      );

      -- Days an assessor can't do visits (holidays, training).
      create table assessor_away (
        id serial primary key,
        assessor_id integer not null references assessors(id) on delete cascade,
        from_date date not null,
        to_date date not null,
        note text,
        check (to_date >= from_date)
      );
      create index assessor_away_idx on assessor_away (assessor_id, from_date);
      create index visits_month_idx on visits (year, month, status);

      create table contacts (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        name text not null,
        first_name text,
        job_title text,
        email text,
        phone text,
        is_primary boolean not null default false,
        created_at timestamptz not null default now()
      );
      create index contacts_client_idx on contacts (client_id);

      create table activities (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        user_id integer references users(id) on delete set null,
        kind text not null check (kind in ('note', 'call', 'email', 'visit', 'meeting')),
        body text not null,
        happened_on date not null default current_date,
        created_at timestamptz not null default now()
      );
      create index activities_client_idx on activities (client_id, happened_on desc);

      create table tasks (
        id serial primary key,
        client_id integer references clients(id) on delete cascade,
        title text not null,
        details text,
        assigned_to integer references users(id) on delete set null,
        created_by integer references users(id) on delete set null,
        due_on date,
        status text not null default 'open' check (status in ('open', 'done')),
        done_at timestamptz,
        done_by integer references users(id) on delete set null,
        done_note text,
        created_at timestamptz not null default now()
      );
      create index tasks_assigned_idx on tasks (assigned_to, status);
      create index tasks_client_idx on tasks (client_id);

      create table chasers (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        item text not null,
        requested_on date not null default current_date,
        chase_again_on date,
        received_on date,
        notes text,
        created_by integer references users(id) on delete set null,
        created_at timestamptz not null default now()
      );
      create index chasers_client_idx on chasers (client_id);

      create table price_items (
        id serial primary key,
        name text not null unique,
        monthly_pence integer,
        annual_pence integer,
        active boolean not null default true,
        sort_order integer not null default 0
      );
      insert into price_items (name, sort_order) values
        ('Health & Safety Consultancy', 1),
        ('Food Safety Consultancy', 2),
        ('Fire Safety Consultancy', 3),
        ('Email / Telephone Support', 4);

      create table quotes (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        status text not null default 'draft'
          check (status in ('draft', 'ready', 'approved', 'sent', 'accepted', 'declined')),
        notes text,
        review_note text,
        prepared_by integer references users(id) on delete set null,
        approved_by integer references users(id) on delete set null,
        approved_at timestamptz,
        sent_on date,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index quotes_client_idx on quotes (client_id);

      create table quote_lines (
        id serial primary key,
        quote_id integer not null references quotes(id) on delete cascade,
        description text not null,
        monthly_pence integer,
        annual_pence integer,
        sort_order integer not null default 0
      );

      create table populate_jobs (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        title text not null,
        status text not null default 'open' check (status in ('open', 'checking', 'done')),
        assigned_to integer references users(id) on delete set null,
        notes text,
        created_at timestamptz not null default now(),
        completed_at timestamptz
      );

      create table populate_items (
        id serial primary key,
        job_id integer not null references populate_jobs(id) on delete cascade,
        document text not null,
        done_at timestamptz,
        done_by integer references users(id) on delete set null,
        sort_order integer not null default 0
      );
      create index populate_items_job_idx on populate_items (job_id);

      -- Word templates with {placeholders} that documents are created from.
      create table doc_templates (
        id serial primary key,
        name text not null,
        filename text not null,
        content bytea not null,
        kind text not null default 'other' check (kind in ('ra', 'sop', 'other')),
        active boolean not null default true,
        uploaded_by integer references users(id) on delete set null,
        created_at timestamptz not null default now()
      );

      create table doc_requests (
        id serial primary key,
        client_id integer not null references clients(id) on delete cascade,
        title text not null,
        kind text not null default 'ra' check (kind in ('ra', 'sop', 'other')),
        department text,
        template_id integer references doc_templates(id) on delete set null,
        requested_by integer references users(id) on delete set null,
        assigned_to integer references users(id) on delete set null,
        due_on date,
        status text not null default 'requested'
          check (status in ('requested', 'ready', 'returned', 'approved', 'cancelled')),
        notes text,
        review_note text,
        approved_by integer references users(id) on delete set null,
        approved_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index doc_requests_assigned_idx on doc_requests (assigned_to, status);
      create index doc_requests_client_idx on doc_requests (client_id);

      create table doc_files (
        id serial primary key,
        request_id integer not null references doc_requests(id) on delete cascade,
        filename text not null,
        mime text not null,
        size integer not null,
        content bytea not null,
        uploaded_by integer references users(id) on delete set null,
        created_at timestamptz not null default now()
      );
      create index doc_files_request_idx on doc_files (request_id);
    `,
  },
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // One app instance at a time applies migrations.
    await client.query("select pg_advisory_lock(424242)");
    await client.query(`create table if not exists schema_migrations (
      id text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query("select id from schema_migrations")).rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (id) values ($1)", [m.id]);
        await client.query("commit");
        console.log(`migration ${m.id} applied`);
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
}
