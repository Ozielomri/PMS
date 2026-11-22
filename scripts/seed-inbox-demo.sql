-- Demo inbox: guest conversations for an account seeded with scripts/seed-demo.sql.
-- Inbound mail goes through public.ingest_inbound_email (the real threading); replies and notes
-- are written as the account's admin. Message times are then spread over the last days so the
-- inbox looks lived-in (the messages table stamps rows with now(); the append-only guard is
-- paused only inside this transaction for that one update). Runs once; refuses if the account
-- already has conversations.
--
-- Usage: replace __ACCOUNT_ID__ with the account id, then run it.

do $seed$
declare
  v_account uuid := '__ACCOUNT_ID__';
  v_user uuid;
  v_token text;
  v_today date;
  r record;
  s record;
  v_conv uuid;
  v_msg uuid;
  v_res jsonb;
  v_n integer := 0;
  v_first text;
begin
  if exists (select 1 from public.conversations where account_id = v_account) then
    raise exception 'account already has conversations; the inbox seed only runs once';
  end if;
  select m.user_id into v_user from public.memberships m
  where m.account_id = v_account and m.role = 'admin' and m.status = 'active' order by m.created_at limit 1;
  select inbound_token into v_token from public.inbox_settings where account_id = v_account;
  select (now() at time zone a.timezone)::date into v_today from public.accounts a where a.id = v_account;
  if v_user is null or v_token is null then
    raise exception 'account needs an active admin and inbox settings';
  end if;

  perform set_config('pms.actor_type', 'system', true);
  perform set_config('pms.actor_id', 'demo-seed', true);

  create temp table seed_times (message_id uuid primary key, at timestamptz not null) on commit drop;

  -- Scenarios: which reservations, and the script (kind, hours ago, body). {first} = guest first name.
  for s in
    select * from (values
      (1, 'arriving', 0, '[["in",20,"Hi! We land at 11am — is there any chance of an early check-in? Happy to pay extra."],["out",19,"Hi {first}, welcome! The cleaners finish around 1pm, so we can let you in at 1:30pm at no charge. I will send the door code on the morning of arrival."],["in",18,"That is perfect, thank you so much!"]]', 'done', false),
      (2, 'arriving', 1, '[["in",3,"Hello, is there parking on site, and how many cars fit? We are coming with two cars."]]', 'open', false),
      (3, 'in_house', 0, '[["in",30,"Hi, the wifi keeps dropping in the bedroom. Is there a booster?"],["out",29,"Sorry about that, {first}! There is a mesh extender in the hall closet, top shelf — plug it in near the bedroom and it pairs automatically."],["in",28,"Found it, works great now. Thanks!"]]', 'done', false),
      (4, 'in_house', 1, '[["in",1,"Quick question — how do we turn on the hot tub? The panel shows an error E2."]]', 'open', true),
      (5, 'pending', 0, '[["in",6,"Hi! Before you approve: we would bring our small dog (8 kg, house-trained). Is that OK?"]]', 'open', false),
      (6, 'pending', 1, '[["in",26,"Hello, could you confirm the beds? We are two couples and need two queen beds."],["out",25,"Hi {first}, yes — two bedrooms, each with a queen bed. I will approve your request today."]]', 'open', false),
      (7, 'inquiry', 0, '[["in",50,"Hi, are these dates still free, and what would the total be for 2 adults?"],["out",48,"Hi {first}, the dates are free. I have sent you a quote with the full price; it holds for 3 days."],["in",4,"Thanks! One more thing: is there a crib available?"]]', 'open', true),
      (8, 'upcoming', 0, '[["out",72,"Hi {first}, looking forward to hosting you! Check-in is from 4pm. Let us know your arrival time and anything you need."],["in",70,"Thank you! We should arrive around 6pm."]]', 'done', false),
      (9, 'upcoming', 1, '[["in",10,"Can we check out a bit later on our last day, around noon?"]]', 'open', false),
      (10, 'upcoming', 2, '[["in",40,"Is there a grocery store nearby? We would like to cook on the first evening."],["out",39,"Hi {first}, there is a supermarket 5 minutes away by car, open until 10pm. The kitchen is fully equipped, including spices and coffee."]]', 'done', false),
      (11, 'past', 0, '[["in",36,"We had a wonderful stay, thank you! I think I left a phone charger in the bedroom."],["out",35,"So glad you enjoyed it, {first}! The cleaners found the charger — we will post it to you today."]]', 'done', false),
      (12, 'past', 1, '[["in",8,"Hi, could you send me an invoice for our stay for my employer?"]]', 'open', false)
    ) as t(n, tab, pick, script, final_status, assign)
  loop
    -- Pick the reservation for this scenario.
    select res.id, res.code, res.check_in, res.guest_id, g.email, g.first_name, coalesce(g.last_name, '') as last_name
    into r
    from public.reservations res
    join public.guests g on g.id = res.guest_id
    where res.account_id = v_account and res.kind = 'guest' and g.email is not null
      and case s.tab
            when 'arriving' then res.status = 'confirmed' and res.check_in = v_today
            when 'in_house' then res.status = 'confirmed' and res.stay_status = 'checked_in'
            when 'pending' then res.status = 'reserved'
            when 'inquiry' then res.status = 'inquiry'
            when 'upcoming' then res.status = 'confirmed' and res.check_in > v_today + 2
            when 'past' then res.status = 'confirmed' and res.stay_status = 'checked_out'
          end
    order by res.check_in, res.code
    offset s.pick limit 1;
    continue when r.id is null;
    v_first := r.first_name;
    v_conv := null;

    for v_n in 0 .. jsonb_array_length(s.script::jsonb) - 1 loop
      declare
        v_step jsonb := (s.script::jsonb) -> v_n;
        v_kind text := v_step ->> 0;
        v_body text := replace(v_step ->> 2, '{first}', v_first);
        v_at timestamptz := now() - make_interval(hours => (v_step ->> 1)::integer) - make_interval(mins => (random() * 40)::integer);
      begin
        if v_kind = 'in' then
          v_res := public.ingest_inbound_email('seed', jsonb_build_object(
            'provider_message_id', 'seed-' || gen_random_uuid(),
            'from_email', r.email, 'from_name', btrim(r.first_name || ' ' || r.last_name),
            'account_token', v_token, 'to', jsonb_build_array(v_token || '@in.example.com'),
            'subject', 'Re: ' || r.code, 'raw_subject', 'Re: ' || r.code, 'text', v_body,
            'rfc_message_id', '<seed-' || gen_random_uuid() || '@guest.example>'));
          v_conv := (v_res ->> 'conversation_id')::uuid;
          v_msg := (v_res ->> 'message_id')::uuid;
        else
          if v_conv is null then
            v_conv := (private.reservation_conversation((select x from public.reservations x where x.id = r.id))).id;
          end if;
          insert into public.messages (account_id, conversation_id, kind, channel, author_type, author_user_id, recipient_email, subject, body)
          values (v_account, v_conv, 'outbound', 'email', 'user', v_user, r.email,
                  (select c.subject from public.conversations c where c.id = v_conv), v_body)
          returning id into v_msg;
          insert into public.message_deliveries (message_id, account_id, channel, to_address, to_name)
          values (v_msg, v_account, 'email', r.email, btrim(r.first_name || ' ' || r.last_name));
          update public.message_deliveries set status = 'sending', attempts = 1 where message_id = v_msg;
          update public.message_deliveries set status = 'delivered', provider = 'log' where message_id = v_msg;
        end if;
        insert into seed_times values (v_msg, v_at);
      end;
    end loop;

    if s.n = 4 then
      insert into public.messages (account_id, conversation_id, kind, channel, author_type, author_user_id, body)
      values (v_account, v_conv, 'note', 'internal', 'user', v_user, 'E2 = low water level. Asked the pool contractor to stop by this afternoon.')
      returning id into v_msg;
      insert into seed_times values (v_msg, now() - interval '20 minutes');
    end if;
    if s.assign then
      update public.conversations set assignee_user_id = v_user where id = v_conv;
    end if;
    if s.final_status = 'done' then
      update public.conversations set status = 'done' where id = v_conv;
    end if;
  end loop;

  -- A new inquiry from someone without a booking (matched as a new conversation).
  v_res := public.ingest_inbound_email('seed', jsonb_build_object(
    'provider_message_id', 'seed-' || gen_random_uuid(),
    'from_email', 'lena.fischer@example.com', 'from_name', 'Lena Fischer',
    'account_token', v_token, 'to', jsonb_build_array(v_token || '@in.example.com'),
    'subject', 'Family reunion in March', 'raw_subject', 'Family reunion in March',
    'text', 'Hello! We are planning a family reunion for 12 people in mid-March. Do you have a large house or several units close together? Thanks, Lena',
    'rfc_message_id', '<seed-' || gen_random_uuid() || '@guest.example>'));
  insert into seed_times values ((v_res ->> 'message_id')::uuid, now() - interval '2 hours 15 minutes');

  -- Spread the times. The append-only guard is paused for this update only (same transaction).
  alter table public.messages disable trigger messages_append_only;
  update public.messages m set created_at = t.at from seed_times t where t.message_id = m.id;
  -- INB-13: response time = reply time minus the first guest message it answers.
  update public.messages o
  set response_seconds = (
    select floor(extract(epoch from (o.created_at - min(i.created_at))))::integer
    from public.messages i
    where i.conversation_id = o.conversation_id and i.kind = 'inbound' and i.created_at < o.created_at
      and i.created_at > coalesce((select max(p.created_at) from public.messages p
                                   where p.conversation_id = o.conversation_id and p.kind = 'outbound' and p.created_at < o.created_at), '-infinity'))
  where o.account_id = v_account and o.kind = 'outbound';
  alter table public.messages enable trigger messages_append_only;

  alter table public.message_deliveries disable trigger message_deliveries_rules;
  alter table public.message_deliveries disable trigger audit_message_deliveries;
  update public.message_deliveries d
  set queued_at = t.at, sent_at = t.at + interval '2 seconds', delivered_at = t.at + interval '9 seconds', updated_at = t.at + interval '9 seconds'
  from seed_times t where t.message_id = d.message_id;
  alter table public.message_deliveries enable trigger message_deliveries_rules;
  alter table public.message_deliveries enable trigger audit_message_deliveries;

  -- Rebuild each conversation's summary from its (now back-dated) messages.
  update public.conversations c
  set last_message_at = x.last_at,
      last_message_preview = x.last_preview,
      last_message_kind = x.last_kind,
      last_guest_message_at = x.last_in,
      awaiting_reply_since = case when x.last_kind = 'inbound' and c.status <> 'done' then x.first_unanswered end
  from (
    select m.conversation_id,
           max(m.created_at) filter (where m.kind <> 'note') as last_at,
           (array_agg(left(regexp_replace(m.body, '\s+', ' ', 'g'), 200) order by m.created_at desc) filter (where m.kind <> 'note'))[1] as last_preview,
           (array_agg(m.kind order by m.created_at desc) filter (where m.kind <> 'note'))[1] as last_kind,
           max(m.created_at) filter (where m.kind = 'inbound') as last_in,
           min(m.created_at) filter (where m.kind = 'inbound' and m.created_at > coalesce(
             (select max(o.created_at) from public.messages o where o.conversation_id = m.conversation_id and o.kind = 'outbound'), '-infinity')) as first_unanswered
    from public.messages m
    where m.account_id = v_account
    group by m.conversation_id
  ) x
  where c.id = x.conversation_id;

  -- Saved replies (INB-05).
  insert into public.saved_replies (account_id, title, shortcut, body, created_by) values
    (v_account, 'Check-in instructions', 'checkin',
     E'Hi {{guest.first_name}},\n\nWe are looking forward to welcoming you at {{listing.title}} on {{reservation.check_in}}. Check-in is from {{listing.check_in_from}}; the address is {{listing.address}}.\n\nSafe travels,\n{{account.name}}', v_user),
    (v_account, 'Early check-in', 'early',
     E'Hi {{guest.first_name}},\n\nWe will do our best to have {{listing.title}} ready early. We will confirm on the morning of {{reservation.check_in}}.', v_user),
    (v_account, 'Late check-out', 'late',
     E'Hi {{guest.first_name}},\n\nCheck-out is normally by {{listing.check_out_by}}. We can usually offer a later check-out if no one arrives that day — we will confirm the evening before.', v_user),
    (v_account, 'Thank you after stay', 'thanks',
     E'Hi {{guest.first_name}},\n\nThank you for staying at {{listing.title}}! We hope you had a great time and would love to host you again.\n\n{{account.name}}', v_user);
end;
$seed$;
