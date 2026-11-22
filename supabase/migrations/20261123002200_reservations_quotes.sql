-- Step 4 / RES-05: quotes — one or more priced options for a guest, a share link (token), an
-- optional hold per option, an expiry. Accepting an option re-checks availability and creates a
-- confirmed reservation with the quoted price; the other options' holds are released.

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id),
  guest_id uuid not null,
  token_hash text not null unique,
  status text not null default 'open' check (status in ('open', 'accepted', 'expired', 'canceled')),
  expires_at timestamptz not null,
  hold boolean not null default false,
  message text check (message is null or length(message) <= 5000),
  accepted_option_id uuid,
  reservation_id uuid,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, account_id),
  foreign key (guest_id, account_id) references public.guests (id, account_id),
  foreign key (reservation_id, account_id) references public.reservations (id, account_id)
);

create table public.quote_options (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  quote_id uuid not null,
  position integer not null default 0,
  listing_id uuid not null,
  check_in date not null,
  check_out date not null,
  adults integer not null default 1 check (adults between 0 and 100),
  children integer not null default 0 check (children between 0 and 100),
  infants integer not null default 0 check (infants between 0 and 100),
  pets integer not null default 0 check (pets between 0 and 20),
  -- quote_stay() result at creation (price shown to the guest and booked on accept)
  price jsonb not null,
  total_cents bigint not null,
  hold_id uuid references public.calendar_holds (id),
  created_at timestamptz not null default now(),
  foreign key (quote_id, account_id) references public.quotes (id, account_id),
  foreign key (listing_id, account_id) references public.listings (id, account_id),
  constraint quote_options_dates check (check_out > check_in and check_out - check_in <= 365)
);

create index quotes_account_idx on public.quotes (account_id, created_at desc);
create index quote_options_quote_idx on public.quote_options (quote_id, position);

create trigger quotes_touch before update on public.quotes
  for each row execute function private.touch_updated_at();
create trigger audit_quotes after insert or update or delete on public.quotes
  for each row execute function private.audit_row_change('token_hash');
create trigger audit_quote_options after insert or update or delete on public.quote_options
  for each row execute function private.audit_row_change();
create trigger events_quotes after insert or update on public.quotes
  for each row execute function private.emit_row_event('quote', 'token_hash');
create trigger quote_options_append_only before update or delete on public.quote_options
  for each row execute function private.append_only();

-- p_options: [{listing_id, check_in, check_out, adults?, children?, infants?, pets?}]
-- Returns the quote id and the raw token (shown once; only its hash is stored).
create or replace function public.create_quote(
  p_account_id uuid,
  p_options jsonb,
  p_expires_at timestamptz,
  p_guest_id uuid default null,
  p_guest jsonb default null,
  p_hold boolean default false,
  p_message text default null
)
returns table (quote_id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_guest uuid;
  v_quote uuid;
  v_opt jsonb;
  v_option_id uuid;
  v_listing public.listings;
  v_price jsonb;
  v_pos integer := 0;
  v_hold uuid;
begin
  if not private.has_permission(p_account_id, 'reservations.create') then
    raise exception 'forbidden: reservations.create' using errcode = '42501';
  end if;
  if jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) not between 1 and 10 then
    raise exception 'invalid_options: 1 to 10 options' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '60 days' then
    raise exception 'invalid_expiry: within the next 60 days' using errcode = '22023';
  end if;
  v_guest := private.resolve_guest(p_account_id, p_guest_id, p_guest);
  if v_guest is null then
    raise exception 'guest_required: choose or create a guest' using errcode = '22023';
  end if;

  insert into public.quotes (account_id, guest_id, token_hash, expires_at, hold, message)
  values (p_account_id, v_guest, encode(extensions.digest(v_token, 'sha256'), 'hex'), p_expires_at, p_hold, nullif(btrim(p_message), ''))
  returning id into v_quote;

  for v_opt in select * from jsonb_array_elements(p_options) loop
    v_listing := private.calendar_authorize((v_opt ->> 'listing_id')::uuid, 'reservations.create');
    if v_listing.account_id <> p_account_id then
      raise exception 'listing_not_found' using errcode = 'P0002';
    end if;
    v_price := public.quote_stay(v_listing.id, (v_opt ->> 'check_in')::date, (v_opt ->> 'check_out')::date,
      greatest(coalesce((v_opt ->> 'adults')::integer, 1) + coalesce((v_opt ->> 'children')::integer, 0), 1),
      coalesce((v_opt ->> 'pets')::integer, 0));
    v_option_id := gen_random_uuid();
    v_hold := null;
    if p_hold then
      v_hold := private.place_hold_internal(v_listing.id, (v_opt ->> 'check_in')::date, (v_opt ->> 'check_out')::date,
        'quote', v_option_id, p_expires_at, 'Quote hold', null, false, 1);
    end if;
    insert into public.quote_options (id, account_id, quote_id, position, listing_id, check_in, check_out, adults, children, infants, pets,
                                      price, total_cents, hold_id)
    values (v_option_id, p_account_id, v_quote, v_pos, v_listing.id, (v_opt ->> 'check_in')::date, (v_opt ->> 'check_out')::date,
            coalesce((v_opt ->> 'adults')::integer, 1), coalesce((v_opt ->> 'children')::integer, 0),
            coalesce((v_opt ->> 'infants')::integer, 0), coalesce((v_opt ->> 'pets')::integer, 0),
            v_price, (v_price ->> 'total_cents')::bigint, v_hold);
    v_pos := v_pos + 1;
  end loop;
  return query select v_quote, v_token;
end;
$$;

create or replace function private.release_quote_holds(p_quote_id uuid, p_except_option uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold uuid;
begin
  for v_hold in
    select o.hold_id from public.quote_options o
    join public.calendar_holds h on h.id = o.hold_id
    where o.quote_id = p_quote_id and o.id is distinct from p_except_option and h.status = 'active'
  loop
    perform public.release_hold(v_hold, p_reason);
  end loop;
end;
$$;

create or replace function public.cancel_quote(p_quote_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.quotes;
begin
  select * into v from public.quotes where id = p_quote_id for update;
  if not found or not private.has_permission(v.account_id, 'reservations.create') then
    raise exception 'quote_not_found' using errcode = 'P0002';
  end if;
  if v.status <> 'open' then
    raise exception 'quote_not_open: this quote is %', v.status using errcode = 'P0001';
  end if;
  perform private.release_quote_holds(v.id, null, 'quote canceled');
  update public.quotes set status = 'canceled' where id = v.id;
end;
$$;

-- Public view of a quote by its token (the guest's link page).
create or replace function public.get_quote(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', q.id,
    'status', case when q.status = 'open' and q.expires_at <= now() then 'expired' else q.status end,
    'expires_at', q.expires_at,
    'message', q.message,
    'account_name', a.name,
    'guest_first_name', g.first_name,
    'accepted_option_id', q.accepted_option_id,
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'listing_title', coalesce(l.public_title, l.internal_name), 'city', l.city,
        'check_in', o.check_in, 'check_out', o.check_out, 'nights', o.check_out - o.check_in,
        'adults', o.adults, 'children', o.children, 'pets', o.pets,
        'currency', o.price ->> 'currency', 'lines', o.price -> 'lines', 'total_cents', o.total_cents)
        order by o.position)
      from public.quote_options o join public.listings l on l.id = o.listing_id
      where o.quote_id = q.id), '[]'::jsonb))
  from public.quotes q
  join public.accounts a on a.id = q.account_id
  join public.guests g on g.id = q.guest_id
  where q.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;

-- Accept one option: re-check availability (the calendar decides), book it confirmed at the quoted
-- price, release the other holds. Callable from the public link (anon) — the token is the key.
create or replace function public.accept_quote(p_token text, p_option_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.quotes;
  o public.quote_options;
  v_res uuid;
  r public.reservations;
begin
  select * into v from public.quotes where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'P0002';
  end if;
  if v.status = 'accepted' then
    select * into r from public.reservations where id = v.reservation_id;
    return jsonb_build_object('reservation_code', r.code, 'already_accepted', true);
  end if;
  if v.status <> 'open' or v.expires_at <= now() then
    raise exception 'quote_not_open: this quote has expired or was withdrawn' using errcode = 'P0001';
  end if;
  select * into o from public.quote_options where id = p_option_id and quote_id = v.id;
  if not found then
    raise exception 'quote_option_not_found' using errcode = 'P0002';
  end if;

  -- Act as the system from here: the guest is not a member of the account.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('pms.actor_type', 'api', true);
  perform set_config('pms.actor_id', 'quote:' || v.id, true);
  perform set_config('pms.line_source', 'quote', true);

  perform private.release_quote_holds(v.id, null, 'quote accepted');
  v_res := private.create_reservation_core(o.listing_id, o.check_in, o.check_out, v.guest_id, 'confirmed', 'guest', 'direct',
    o.adults, o.children, o.infants, o.pets, null,
    (select jsonb_agg(jsonb_build_object(
        'kind', case x ->> 'code' when 'weekly_discount' then 'discount' when 'monthly_discount' then 'discount' else x ->> 'code' end,
        'label', x ->> 'label', 'quantity', coalesce((x ->> 'quantity')::integer, 1),
        'unit_amount_cents', x ->> 'unit_amount_cents', 'amount_cents', x ->> 'amount_cents'))
     from jsonb_array_elements(o.price -> 'lines') x),
    null, null, null, null, null, null, '{}');
  perform private.log_reservation_activity(v_res, 'quote', 'Booked from an accepted quote', jsonb_build_object('quote_id', v.id, 'option_id', o.id));
  update public.quotes set status = 'accepted', accepted_option_id = o.id, reservation_id = v_res where id = v.id;
  select * into r from public.reservations where id = v_res;
  return jsonb_build_object('reservation_code', r.code, 'already_accepted', false);
end;
$$;

-- Quotes past their expiry → expired (holds expired by themselves already).
create or replace function public.expire_quotes()
returns integer
language sql
security definer
set search_path = ''
as $$
  with x as (
    update public.quotes q set status = 'expired'
    where q.status = 'open' and q.expires_at <= now()
      and (private.calendar_is_system() or private.is_member(q.account_id))
    returning 1
  )
  select count(*)::integer from x
$$;

alter table public.quotes enable row level security;
alter table public.quote_options enable row level security;
revoke all on public.quotes, public.quote_options from anon;
revoke insert, update, delete, truncate on public.quotes, public.quote_options from authenticated;
revoke select on public.quotes from authenticated;
grant select (id, account_id, guest_id, status, expires_at, hold, message, accepted_option_id, reservation_id, created_by, created_at, updated_at)
  on public.quotes to authenticated;

create policy quotes_select on public.quotes for select to authenticated
  using (private.has_permission(account_id, 'reservations.view'));
create policy quote_options_select on public.quote_options for select to authenticated
  using (private.has_permission(account_id, 'reservations.view'));

revoke execute on function public.create_quote(uuid, jsonb, timestamptz, uuid, jsonb, boolean, text) from public, anon;
revoke execute on function public.cancel_quote(uuid) from public, anon;
revoke execute on function public.expire_quotes() from public, anon;
grant execute on function public.create_quote(uuid, jsonb, timestamptz, uuid, jsonb, boolean, text) to authenticated, service_role;
grant execute on function public.cancel_quote(uuid) to authenticated, service_role;
grant execute on function public.expire_quotes() to authenticated, service_role;
grant execute on function public.get_quote(text) to anon, authenticated, service_role;
grant execute on function public.accept_quote(text, uuid) to anon, authenticated, service_role;

revoke execute on all functions in schema private from public;
