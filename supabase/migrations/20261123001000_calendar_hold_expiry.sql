-- Step 4 support (Calendar): change the expiry of an active hold. Reservations uses it when a
-- Reserved booking (time-limited hold) is approved and its nights must stay blocked for good.
-- Availability does not change, so no calendar.updated event; the change log records it.

create or replace function public.set_hold_expiry(p_hold_id uuid, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.calendar_holds;
begin
  select * into v from public.calendar_holds where id = p_hold_id for update;
  if not found then
    raise exception 'hold_not_found: %', p_hold_id using errcode = 'P0002';
  end if;
  perform private.calendar_authorize(v.listing_id, private.hold_permission(v.source_type, 'move'));
  if v.status <> 'active' or (v.expires_at is not null and v.expires_at <= now()) then
    raise exception 'hold_not_active: % is %', p_hold_id, case when v.status = 'active' then 'expired' else v.status end
      using errcode = 'P0001';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'invalid_expiry: expires_at is in the past' using errcode = '22023';
  end if;
  update public.calendar_holds set expires_at = p_expires_at where id = v.id;
  perform private.log_calendar_change(v.account_id, v.listing_id, v.nights, 'availability',
    jsonb_build_object('hold_id', v.id, 'expires_at', v.expires_at),
    jsonb_build_object('hold_id', v.id, 'expires_at', p_expires_at), v.id);
end;
$$;

revoke execute on function public.set_hold_expiry(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.set_hold_expiry(uuid, timestamptz) to service_role;

revoke execute on all functions in schema private from public;
