-- Recoverable project removal; assets and revisions remain intact.
alter table projects add column deleted_at timestamptz;
