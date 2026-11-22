-- AI agent foundations (docs/plans/ai-agent.md), part 1: the `agent` role.
-- A new enum value cannot be used in the transaction that adds it, so it gets its own migration;
-- 20261125001100 seeds its permissions and keeps it off human memberships.

alter type public.account_role add value if not exists 'agent';
