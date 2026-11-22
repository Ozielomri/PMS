-- Demo data: 20 properties (18 single listings + 2 multi-units with 3 units each) and 100
-- reservations around today, for one account. Runs as the system (direct database connection)
-- through the same functions the app uses, so every rule, hold, audit row and event applies.
-- One transaction: it either completes or changes nothing.
--
-- Usage: replace __ACCOUNT_ID__ with the account id, then run it once on an empty account.

do $seed$
declare
  v_account uuid := '__ACCOUNT_ID__';
  v_today date;
  v_listing_ids uuid[] := '{}';
  v_units uuid[] := '{}';          -- bookable rows: singles and sub-units
  v_unit_parent uuid[] := '{}';    -- the multi-unit of each bookable row (null for singles)
  v_id uuid;
  v_parent uuid;
  r record;
  i integer;
  u integer;
  v_cursors date[] := '{}';
  v_ci date;
  v_co date;
  v_n integer := 0;
  v_res uuid;
  v_kind text;
  v_source text;
  v_status text;
  v_guests integer;
  v_price integer;
  v_target uuid;
  v_first text[] := array['Emma','Liam','Olivia','Noah','Ava','Ethan','Sophia','Mason','Isabella','Lucas','Mia','James','Charlotte','Benjamin','Amelia','Henry','Harper','Daniel','Evelyn','Jack','Grace','Owen','Chloe','Ryan','Nora'];
  v_last text[] := array['Johnson','Williams','Brown','Garcia','Miller','Davis','Martinez','Lopez','Wilson','Anderson','Taylor','Thomas','Moore','Jackson','Martin','Lee','Harris','Clark','Lewis','Walker','Hall','Young','King','Wright','Scott'];
  v_fn text;
  v_ln text;
  v_total bigint;
begin
  if not exists (select 1 from public.accounts where id = v_account) then
    raise exception 'account % not found', v_account;
  end if;
  if exists (select 1 from public.listings where account_id = v_account) then
    raise exception 'account already has listings; the seed only runs on an empty account';
  end if;

  perform set_config('pms.actor_type', 'system', true);
  perform set_config('pms.actor_id', 'demo-seed', true);
  perform setseed(0.4242);
  select (now() at time zone a.timezone)::date into v_today from public.accounts a where a.id = v_account;

  -- -------------------------------------------------------------------------
  -- Properties
  -- -------------------------------------------------------------------------
  for r in
    select * from (values
      ('Ocean Breeze Cottage', 'Ocean Breeze Cottage · Steps to the Beach', 'single', '412 Gulf Shore Dr', 'Destin', 'FL', '32541', 'America/Chicago', 2, 2, 6, 22500, 27500, 12500, 2, 'moderate', '{beach,pet-friendly}'),
      ('Sunset Dunes Villa', 'Sunset Dunes Villa with Private Pool', 'single', '88 Dune Crest Ln', 'Destin', 'FL', '32541', 'America/Chicago', 4, 3, 10, 48000, 56000, 22500, 3, 'strict', '{beach,pool,luxury}'),
      ('Palm Harbor Condo 3B', 'Bayfront Condo · Palm Harbor', 'single', '1200 Harbor Blvd #3B', 'Clearwater', 'FL', '33767', 'America/New_York', 1, 1, 4, 15500, 18500, 9500, 2, 'flexible', '{beach,condo}'),
      ('Coral Key Bungalow', 'Coral Key Bungalow · Walk to Duval', 'single', '614 Elizabeth St', 'Key West', 'FL', '33040', 'America/New_York', 2, 1, 4, 29500, 34500, 15000, 3, 'strict', '{island}'),
      ('Magnolia House', 'Historic Magnolia House Downtown', 'single', '27 Tradd St', 'Charleston', 'SC', '29401', 'America/New_York', 3, 2, 8, 34000, 41000, 17500, 2, 'moderate', '{historic,downtown}'),
      ('Rainbow Row Loft', 'Rainbow Row Loft', 'single', '95 E Bay St #2', 'Charleston', 'SC', '29401', 'America/New_York', 1, 1, 2, 19500, 23500, 8500, 2, 'moderate', '{downtown,couples}'),
      ('Smoky Ridge Cabin', 'Smoky Ridge Cabin · Hot Tub & Views', 'single', '1550 Ridge Top Rd', 'Gatlinburg', 'TN', '37738', 'America/New_York', 3, 2, 8, 26000, 32000, 14000, 2, 'moderate', '{mountain,hot-tub,pet-friendly}'),
      ('Bear Hollow Lodge', 'Bear Hollow Lodge · Sleeps 14', 'single', '310 Bear Hollow Way', 'Pigeon Forge', 'TN', '37863', 'America/New_York', 6, 4, 14, 52000, 62000, 27500, 3, 'strict', '{mountain,groups,game-room}'),
      ('Broadway Studio', 'Nashville Studio · 5 min to Broadway', 'single', '700 Church St #1204', 'Nashville', 'TN', '37203', 'America/Chicago', 0, 1, 2, 14500, 21000, 7500, 2, 'flexible', '{downtown,studio}'),
      ('Music Row Townhouse', 'Music Row Townhouse with Rooftop', 'single', '1810 Division St', 'Nashville', 'TN', '37203', 'America/Chicago', 3, 3, 9, 39000, 52000, 19500, 2, 'moderate', '{downtown,groups}'),
      ('Blue Ridge Retreat', 'Blue Ridge Retreat · Creekside', 'single', '42 Laurel Creek Rd', 'Asheville', 'NC', '28803', 'America/New_York', 2, 2, 5, 21000, 25500, 12000, 2, 'moderate', '{mountain}'),
      ('Outer Banks Beach House', 'Oceanfront Beach House · Nags Head', 'single', '9010 S Old Oregon Inlet Rd', 'Nags Head', 'NC', '27959', 'America/New_York', 5, 4, 12, 45000, 52000, 25000, 7, 'strict', '{beach,groups,pet-friendly}'),
      ('Aspen Creek Chalet', 'Aspen Creek Chalet · Ski-in Access', 'single', '230 Snowmass Club Cir', 'Snowmass Village', 'CO', '81615', 'America/Denver', 4, 3, 10, 69000, 79000, 30000, 4, 'strict', '{ski,luxury,mountain}'),
      ('Red Rocks Casita', 'Red Rocks Casita · Sedona Views', 'single', '75 Canyon Mesa Dr', 'Sedona', 'AZ', '86351', 'America/Phoenix', 1, 1, 3, 23000, 27500, 11000, 2, 'moderate', '{desert,couples}'),
      ('Desert Oasis Pool Home', 'Desert Oasis with Heated Pool', 'single', '6120 E Cactus Rd', 'Scottsdale', 'AZ', '85254', 'America/Phoenix', 4, 3, 10, 36000, 44000, 20000, 3, 'moderate', '{desert,pool,groups}'),
      ('Lakeview A-Frame', 'Lakeview A-Frame · Kayaks Included', 'single', '18 Shoreline Dr', 'Lake Lure', 'NC', '28746', 'America/New_York', 2, 1, 6, 18500, 23000, 10500, 2, 'flexible', '{lake,pet-friendly}'),
      ('French Quarter Suite', 'French Quarter Balcony Suite', 'single', '722 Royal St #3', 'New Orleans', 'LA', '70116', 'America/Chicago', 1, 1, 4, 21500, 29500, 9500, 2, 'moderate', '{downtown,historic}'),
      ('Savannah Garden Flat', 'Savannah Garden Flat on the Square', 'single', '14 W Jones St', 'Savannah', 'GA', '31401', 'America/New_York', 2, 1, 4, 17500, 21500, 9000, 2, 'flexible', '{historic,pet-friendly}'),
      ('Seaside Suites', 'Seaside Suites · Oceanfront Studios', 'multi_parent', '2200 N Ocean Blvd', 'Myrtle Beach', 'SC', '29577', 'America/New_York', 1, 1, 4, 16500, 19500, 8500, 2, 'moderate', '{beach,multi-unit}'),
      ('Pine Lodge Cabins', 'Pine Lodge Cabins', 'multi_parent', '500 Cabin Loop', 'Blue Ridge', 'GA', '30513', 'America/New_York', 2, 1, 6, 19000, 24000, 11000, 2, 'moderate', '{mountain,multi-unit}')
    ) as t(name, title, type, addr, city, st, zip, tz, beds, baths, guests, price, wkend, cleaning, min_n, policy, tags)
  loop
    insert into public.listings (account_id, type, internal_name, public_title, timezone, tags, max_guests, check_in_from, check_in_to,
                                 check_out_by, base_price_cents, weekend_price_cents, min_nights, cleaning_fee_cents, extra_guest_fee_cents,
                                 extra_guest_after, pet_fee_cents, address_line1, city, state_region, postal_code, country_code,
                                 bedrooms, bathrooms_full, cancellation_policy, weekly_discount_bps, monthly_discount_bps)
    values (v_account, r.type::public.listing_type, r.name, r.title, r.tz, r.tags::text[], r.guests, '16:00', '22:00', '10:00',
            r.price, r.wkend, r.min_n, r.cleaning, case when r.guests >= 6 then 2500 else 0 end, case when r.guests >= 6 then r.guests - 2 end,
            case when r.tags like '%pet-friendly%' then 7500 else 0 end, r.addr, r.city, r.st, r.zip, 'US', r.beds, r.baths, r.policy, 1000, 2500)
    returning id into v_id;
    v_listing_ids := v_listing_ids || v_id;
    insert into public.listing_photos (account_id, listing_id, storage_path, position, caption, content_type, size_bytes, width, height)
    values (v_account, v_id, v_account || '/' || v_id || '/demo-cover.jpg', 0, 'Cover photo (demo placeholder)', 'image/jpeg', 245000, 1600, 1067);

    if r.type = 'multi_parent' then
      v_parent := v_id;
      for i in 1..3 loop
        insert into public.listings (account_id, type, parent_id, internal_name, timezone, max_guests, bedrooms, bathrooms_full)
        values (v_account, 'sub_unit', v_parent, format('%s – %s %s', r.name, case when r.name like 'Seaside%' then 'Studio' else 'Cabin' end, i),
                r.tz, r.guests, r.beds, r.baths)
        returning id into v_id;
        v_units := v_units || v_id;
        v_unit_parent := v_unit_parent || v_parent;
      end loop;
      update public.listings set status = 'active' where id = v_parent;
      update public.listings set status = 'active' where parent_id = v_parent;
    else
      update public.listings set status = 'active' where id = v_id;
      v_units := v_units || v_id;
      v_unit_parent := v_unit_parent || null::uuid;
    end if;
  end loop;

  -- -------------------------------------------------------------------------
  -- Reservations: walk each bookable unit from 25 days ago, alternating gaps and stays, until
  -- 100 exist. Past stays are checked out, current ones checked in; future ones mix confirmed,
  -- pending, inquiries, channel bookings, owner stays and cancellations.
  -- -------------------------------------------------------------------------
  for u in 1..array_length(v_units, 1) loop
    v_cursors := v_cursors || (v_today - 25 + (random() * 10)::integer);
  end loop;
  <<rounds>>
  for i in 1..50 loop
    for u in 1..array_length(v_units, 1) loop
      exit rounds when v_n >= 100;
      v_ci := v_cursors[u] + (random() * 12)::integer;
      v_co := v_ci + 2 + (random() * 5)::integer;
      v_cursors[u] := v_co + (random() * 2)::integer;
      continue when v_ci > v_today + 100;
      v_n := v_n + 1;

      v_fn := v_first[1 + (random() * 24)::integer];
      v_ln := v_last[1 + (random() * 24)::integer];
      v_guests := 1 + (random() * 3)::integer;
      v_target := v_units[u];
      select l.base_price_cents into v_price from public.listings l where l.id = coalesce(v_unit_parent[u], v_units[u]);
      v_source := (array['direct','direct','phone','email','website','booking_com','booking_com','airbnb','airbnb','vrbo'])[1 + (random() * 9)::integer];
      v_kind := case when v_n % 33 = 7 then 'owner_stay' else 'guest' end;
      v_status := case
        when v_ci > v_today + 3 and v_n % 11 = 4 then 'reserved'
        when v_ci > v_today + 3 and v_n % 13 = 5 then 'inquiry'
        else 'confirmed' end;

      if v_kind = 'owner_stay' then
        v_res := private.create_reservation_core(v_target, v_ci, v_co, null, 'confirmed', 'owner_stay', 'owner', 2, 0, 0, 0,
          null, null, null, null, null, null, null, null, '{}');
      elsif v_source in ('booking_com', 'airbnb', 'vrbo') and v_status <> 'inquiry' then
        v_total := v_price * (v_co - v_ci);
        v_res := ((public.ingest_channel_reservation(v_account, v_source,
          case v_source when 'booking_com' then (4000000000 + (random() * 99999999)::bigint)::text
                        when 'airbnb' then 'HM' || upper(substr(md5(random()::text), 1, 8))
                        else 'HA-' || (1000000 + (random() * 8999999)::integer)::text end,
          jsonb_build_object('action', 'create', 'listing_id', v_target, 'check_in', v_ci, 'check_out', v_co,
            'status', v_status, 'adults', v_guests, 'children', (random() * 1.4)::integer,
            'guest', jsonb_build_object('first_name', v_fn, 'last_name', v_ln,
              'email', lower(v_fn || '.' || v_ln || v_n) || '@guest.' || replace(v_source, '_', '') || '.example'),
            'commission_cents', (v_total * case v_source when 'booking_com' then 15 when 'airbnb' then 3 else 8 end) / 100,
            'lines', jsonb_build_array(
              jsonb_build_object('kind', 'accommodation', 'label', format('%s nights', v_co - v_ci), 'amount_cents', v_total),
              jsonb_build_object('kind', 'cleaning_fee', 'label', 'Cleaning fee',
                'amount_cents', (select l.cleaning_fee_cents from public.listings l where l.id = coalesce(v_unit_parent[u], v_target)))))))
          ->> 'reservation_id')::uuid;
      else
        if v_source in ('booking_com', 'airbnb', 'vrbo') then
          v_source := 'email';
        end if;
        v_res := public.create_reservation(
          v_target,
          v_ci, v_co, v_status::public.reservation_status, null,
          jsonb_build_object('first_name', v_fn, 'last_name', v_ln, 'email', lower(v_fn || '.' || v_ln || v_n) || '@example.com',
                             'phone', format('+1 (%s) 555-%s', 200 + (random() * 700)::integer, lpad(((random() * 9999)::integer)::text, 4, '0'))),
          v_guests, (random() * 1.4)::integer, 0, case when random() < 0.12 then 1 else 0 end, v_source, 'guest',
          null, null, case when random() < 0.4 then '17:00'::time end, null,
          case when random() < 0.15 then '{vip}'::text[] when random() < 0.1 then '{returning}'::text[] else '{}'::text[] end,
          case when random() < 0.2 then 'Guest asked about early check-in.' end);
      end if;

      -- Stay status and money for confirmed stays.
      if v_status = 'confirmed' and v_kind = 'guest' then
        if v_co <= v_today then
          if v_n % 17 = 3 then
            perform public.set_stay_status(v_res, 'no_show');
          else
            perform public.set_stay_status(v_res, 'checked_in');
            perform public.set_stay_status(v_res, 'checked_out');
          end if;
        elsif v_ci < v_today then
          perform public.set_stay_status(v_res, 'checked_in');
        end if;

        select guest_total into v_total from private.reservation_totals(v_res);
        if v_source in ('booking_com', 'airbnb', 'vrbo') then
          if v_source <> 'booking_com' then
            perform public.record_payment(v_res, v_total, 'channel_collected', null, null, 'Collected by the channel');
          end if;
        elsif v_ci <= v_today then
          perform public.record_payment(v_res, v_total, (array['card_external','bank_transfer','cash'])[1 + (random() * 2)::integer], null, null, null);
        elsif random() < 0.6 then
          perform public.record_payment(v_res, v_total / 2, 'card_external', null, 'Deposit', '50 % deposit');
        end if;

        -- A few future direct bookings were canceled.
        if v_ci > v_today + 5 and v_n % 14 = 9 and v_source not in ('booking_com', 'airbnb', 'vrbo') then
          perform public.cancel_reservation(v_res, case when v_n % 2 = 0 then 'guest' else 'host' end, 'Plans changed');
        end if;
      end if;
    end loop;
  end loop rounds;

  raise notice 'seeded % listings (+ % units) and % reservations', array_length(v_listing_ids, 1),
    (select count(*) from public.listings where account_id = v_account and type = 'sub_unit'),
    (select count(*) from public.reservations where account_id = v_account);
end;
$seed$;
