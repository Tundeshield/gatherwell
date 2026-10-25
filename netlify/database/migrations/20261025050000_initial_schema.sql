-- Gatherwell initial schema
-- Hierarchy: platform -> organisations -> branches -> people / gatherings / events / follow-ups.
-- Every tenant-owned row carries org_id; the API filters on it for every query.

CREATE TABLE organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  country TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX branches_org_idx ON branches (org_id);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- A user's access within one organisation. branch_ids NULL = all branches.
CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'lead', 'usher', 'viewer')),
  branch_ids UUID[],
  can_export BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'lead', 'usher', 'viewer')),
  branch_ids UUID[],
  can_export BOOLEAN NOT NULL DEFAULT FALSE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX invites_org_idx ON invites (org_id);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  active_org_id UUID REFERENCES organisations(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  leader_person_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX units_org_idx ON units (org_id);

-- Administrative status (status) is separate from attendance signals (last_seen_at, visit_count).
CREATE TABLE people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT,
  phone_norm TEXT,
  email TEXT,
  gender TEXT,
  birthday DATE,
  status TEXT NOT NULL DEFAULT 'visitor' CHECK (status IN ('visitor', 'member', 'inactive', 'transferred', 'archived')),
  unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  first_visit_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  visit_count INTEGER NOT NULL DEFAULT 0,
  joined_at DATE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX people_org_branch_idx ON people (org_id, branch_id);
CREATE INDEX people_org_status_idx ON people (org_id, status);
CREATE INDEX people_org_last_seen_idx ON people (org_id, last_seen_at);
CREATE UNIQUE INDEX people_org_phone_uniq ON people (org_id, phone_norm) WHERE phone_norm IS NOT NULL;
CREATE INDEX people_org_email_idx ON people (org_id, lower(email));

-- Attendance sessions (services, meetings).
CREATE TABLE gatherings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',
  description TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'scheduled', 'open', 'closed', 'archived')),
  public_token TEXT NOT NULL UNIQUE,
  form JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX gatherings_org_branch_start_idx ON gatherings (org_id, branch_id, starts_at DESC);

CREATE TABLE gathering_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',
  form JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One check-in per person per gathering.
CREATE TABLE checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  gathering_id UUID NOT NULL REFERENCES gatherings(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr', 'manual', 'import')),
  first_time BOOLEAN NOT NULL DEFAULT FALSE,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gathering_id, person_id)
);
CREATE INDEX checkins_org_created_idx ON checkins (org_id, created_at);
CREATE INDEX checkins_person_idx ON checkins (person_id, created_at DESC);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE, -- NULL = organisation-wide
  name TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  registration_opens_at TIMESTAMPTZ,
  registration_closes_at TIMESTAMPTZ,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'postponed', 'cancelled', 'completed')),
  public_token TEXT NOT NULL UNIQUE,
  form JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX events_org_start_idx ON events (org_id, starts_at DESC);

CREATE TABLE registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  phone_norm TEXT,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'waitlist', 'cancelled')),
  code TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ,
  checked_in_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, code)
);
CREATE UNIQUE INDEX registrations_event_phone_uniq ON registrations (event_id, phone_norm) WHERE phone_norm IS NOT NULL AND status <> 'cancelled';
CREATE UNIQUE INDEX registrations_event_email_uniq ON registrations (event_id, lower(email)) WHERE email IS NOT NULL AND status <> 'cancelled';
CREATE INDEX registrations_event_idx ON registrations (event_id);

CREATE TABLE followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('first_visit', 'second_visit', 'absence', 'event', 'manual')),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
  assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ NOT NULL,
  outcome TEXT,
  next_action TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
-- Never more than one open follow-up per person per automatic reason.
CREATE UNIQUE INDEX followups_open_uniq ON followups (person_id, reason)
  WHERE status IN ('pending', 'in_progress') AND reason <> 'manual';
CREATE INDEX followups_org_status_due_idx ON followups (org_id, status, due_at);

CREATE TABLE followup_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  followup_id UUID NOT NULL REFERENCES followups(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('call', 'message', 'visit', 'note', 'no_answer')),
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX followup_notes_followup_idx ON followup_notes (followup_id);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp')),
  subject TEXT,
  body TEXT NOT NULL,
  audience JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sent', 'failed')),
  scheduled_for TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX messages_org_idx ON messages (org_id, created_at DESC);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_org_idx ON audit_log (org_id, created_at DESC);

-- Fixed-window rate limiting for public endpoints and login.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL
);
