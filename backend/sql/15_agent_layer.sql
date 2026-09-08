-- 15_agent_layer.sql  (T10.5 – agent persistence layer)
--
-- Creates the four agent tables and the usage index.
-- All statements are idempotent (IF NOT EXISTS) so the migration runner
-- can re-apply safely.
--
-- Dependency for W-L 11.7: agent_usage is required for daily-budget
-- accounting and usage persistence.

CREATE TABLE IF NOT EXISTS agent_conversations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        text        NOT NULL,
  title          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  archived       boolean     NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id              bigserial   PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  turn            integer     NOT NULL,
  role            text        NOT NULL CHECK (role IN ('user','assistant')),
  content         jsonb       NOT NULL,
  snapshot_at     timestamptz,
  graph_loaded_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id          bigserial PRIMARY KEY,
  message_id  bigint    NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  tool_name   text      NOT NULL,
  input       jsonb     NOT NULL,
  result_summary jsonb  NOT NULL,
  duration_ms integer,
  error       text
);

CREATE TABLE IF NOT EXISTS agent_usage (
  id              bigserial   PRIMARY KEY,
  conversation_id uuid        REFERENCES agent_conversations(id) ON DELETE SET NULL,
  user_id         text        NOT NULL,
  provider        text        NOT NULL,
  model           text        NOT NULL,
  input_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens   integer     NOT NULL DEFAULT 0,
  provider_calls  integer     NOT NULL DEFAULT 0,
  tool_iterations integer     NOT NULL DEFAULT 0,
  validator_status text       CHECK (validator_status IN ('clean','repaired','flagged')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_usage_user
  ON agent_usage(user_id, created_at DESC);
