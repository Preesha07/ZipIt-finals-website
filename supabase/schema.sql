-- =============================================================================
-- ZipIt finals: Supabase backend.
--
-- Run this whole file once in the Supabase SQL editor, then set the admin password:
--     select private.set_admin_password('pick-a-long-passphrase');
-- Running the file again is safe: it drops and recreates everything (all data is lost).
--
-- Every UPDATE/DELETE has a WHERE clause: Supabase's pg_safeupdate rejects ones without.
--
-- Model: everyone can read the tables (the audience page needs them). Nobody can write
-- them directly. Every change goes through public.zipit_action(password, action), a
-- security-definer function that checks the shared admin password, applies the same
-- rules the old Python server had, bumps app_state.version (Realtime pushes that row to
-- every open page), and returns a fresh snapshot.
--
-- Timers are stored as "accumulated ms + running-since timestamp" in server time, so a
-- refresh never loses time. The 10-minute stop is applied by whichever comes first: any
-- admin action, or any open page calling public.zipit_tick() when its countdown hits 0.
-- Either way the recorded end is exactly 10:00.000.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

drop schema if exists private cascade;
drop table if exists public.attempts, public.matches, public.teams, public.live_watches, public.app_state cascade;
drop function if exists public.zipit_action(text, jsonb), public.zipit_tick(), public.zipit_snapshot(), public.zipit_check(text);

create schema private;
revoke all on schema private from public;

-- ---------- tables ----------

create table private.admin_secret (
  id int primary key default 1 check (id = 1),
  hash text not null
);

create table public.teams (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 60),
  headstart numeric(9, 3) not null default 0,        -- seconds, subtracted from the run time
  seed int not null,
  created_at timestamptz not null default now()
);
create unique index teams_name_key on public.teams (lower(name));

create table public.matches (
  id bigint generated always as identity primary key,
  round int not null,                                -- bracket size of the round: 16, 8, 4, 2
  slot int not null,                                 -- position in the round, top to bottom
  team_a bigint references public.teams (id),        -- null = bye
  team_b bigint references public.teams (id),
  status text not null default 'pending' check (status in ('pending', 'live', 'done')),
  winner bigint references public.teams (id),
  checkpoints int not null,
  started_at bigint,
  ended_at bigint,
  unique (round, slot)
);

create table public.attempts (
  id bigint generated always as identity primary key,
  match_id bigint not null references public.matches (id) on delete cascade,
  team_id bigint not null references public.teams (id),
  attempt_no int not null,
  laps jsonb not null default '[]',                  -- checkpoint split times (ms)
  partial_ms bigint not null,                        -- unfinished lap when the attempt ended
  end_reason text not null,                          -- reset | timeout | match_end
  edited boolean not null default false,
  voided boolean not null default false,
  created_at bigint not null
);

create table public.app_state (
  id int primary key default 1 check (id = 1),
  match_id bigint references public.matches (id) on delete set null,
  clock_accum bigint not null default 0,
  clock_since bigint,
  clock_over boolean not null default false,
  duration_ms int not null default 600000,
  default_checkpoints int not null default 6,
  t_size int,                                        -- bracket size, null before the bracket exists
  t_round int,
  t_view text not null default 'setup',              -- setup | match | bracket
  t_champion bigint references public.teams (id) on delete set null,
  version bigint not null default 0
);

-- One stopwatch per side of the live match.
-- status: idle | running | paused | complete (all checkpoints reached) | done (time up)
create table public.live_watches (
  side text primary key check (side in ('A', 'B')),
  status text not null default 'idle',
  laps jsonb not null default '[]',
  accum bigint not null default 0,
  since bigint,
  attempt_no int not null default 1,
  last_t bigint not null default 0
);

insert into public.app_state (id) values (1);
insert into public.live_watches (side) values ('A'), ('B');

-- ---------- access: read for everyone, writes only through the functions below ----------

alter table public.teams enable row level security;
alter table public.matches enable row level security;
alter table public.attempts enable row level security;
alter table public.app_state enable row level security;
alter table public.live_watches enable row level security;

create policy "read" on public.teams for select using (true);
create policy "read" on public.matches for select using (true);
create policy "read" on public.attempts for select using (true);
create policy "read" on public.app_state for select using (true);
create policy "read" on public.live_watches for select using (true);

revoke insert, update, delete, truncate on public.teams, public.matches, public.attempts, public.app_state, public.live_watches from anon, authenticated;
grant select on public.teams, public.matches, public.attempts, public.app_state, public.live_watches to anon, authenticated;

-- Realtime: pages listen for app_state version bumps.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.app_state;
  end if;
end $$;

-- ---------- helpers ----------

create function private.now_ms() returns bigint language sql volatile as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

create function private.fail(msg text) returns void language plpgsql as $$
begin
  raise exception using message = msg, errcode = 'P0001';
end $$;

create function private.set_admin_password(pw text) returns void
language sql security definer set search_path = '' as $$
  insert into private.admin_secret (id, hash) values (1, extensions.crypt(pw, extensions.gen_salt('bf')))
  on conflict (id) do update set hash = excluded.hash
$$;

create function private.check_key(p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare h text;
begin
  select hash into h from private.admin_secret where id = 1;
  if h is null then
    raise exception using message = 'Admin password not set. Run: select private.set_admin_password(''...'');', errcode = 'ZA403';
  end if;
  if p_key is null or extensions.crypt(p_key, h) <> h then
    perform pg_sleep(0.5);   -- slows down guessing
    raise exception using message = 'Wrong admin password.', errcode = 'ZA403';
  end if;
end $$;

create function private.lap_sum(laps jsonb) returns bigint language sql immutable as $$
  select coalesce(sum(x::bigint), 0) from jsonb_array_elements_text(laps) x
$$;

-- Validate a JSON list of split times: each 0..60 min, rounded to whole ms.
create function private.ms_list(v jsonb) returns jsonb language plpgsql as $$
declare out jsonb := '[]'; x jsonb;
begin
  if v is null or jsonb_typeof(v) <> 'array' then perform private.fail('Times must be a list.'); end if;
  for x in select * from jsonb_array_elements(v) loop
    if jsonb_typeof(x) <> 'number' or x::numeric < 0 or x::numeric >= 3600000 then
      perform private.fail('Times must be between 0 and 60 minutes.');
    end if;
    out := out || to_jsonb(round(x::numeric)::bigint);
  end loop;
  return out;
end $$;

create function private.parse_headstart(v text) returns numeric language plpgsql as $$
declare s text := btrim(coalesce(v, ''));
begin
  s := btrim(regexp_replace(s, '[sS]$', ''));
  if s = '' then return 0; end if;
  if s !~ '^\d+(\.\d+)?$' then perform private.fail('Headstart must be a number of seconds.'); end if;
  if s::numeric > 3600 then perform private.fail('Headstart must be between 0 and 3600 seconds.'); end if;
  return s::numeric;
end $$;

create function private.clean_name(v text) returns text language plpgsql as $$
declare s text := btrim(coalesce(v, ''));
begin
  if s = '' then perform private.fail('Team name can''t be empty.'); end if;
  if length(s) > 60 then perform private.fail('Team name is too long.'); end if;
  return s;
end $$;

-- Seed order for the first round: {1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11} for 16.
create function private.bracket_order(size int) returns int[] language plpgsql immutable as $$
declare o int[] := array[1]; n int;
begin
  while array_length(o, 1) < size loop
    n := array_length(o, 1) * 2;
    select array_agg(x order by ord) into o from (
      select s as x, i * 2 as ord from unnest(o) with ordinality u(s, i)
      union all
      select n + 1 - s, i * 2 + 1 from unnest(o) with ordinality u(s, i)
    ) q;
  end loop;
  return o;
end $$;

create function private.reset_live(p_match bigint) returns void language sql as $$
  update public.app_state set match_id = p_match, clock_accum = 0, clock_since = null, clock_over = false where id = 1;
  update public.live_watches set status = 'idle', laps = '[]', accum = 0, since = null, attempt_no = 1, last_t = 0 where side in ('A', 'B');
$$;

create function private.save_attempt(p_side text, p_reason text, p_t bigint) returns boolean
language plpgsql as $$
declare w public.live_watches; mid bigint; tid bigint;
begin
  select * into w from public.live_watches where side = p_side;
  if jsonb_array_length(w.laps) = 0 and w.accum = 0 then return false; end if;
  select match_id into mid from public.app_state where id = 1;
  select case when p_side = 'A' then team_a else team_b end into tid from public.matches where id = mid;
  insert into public.attempts (match_id, team_id, attempt_no, laps, partial_ms, end_reason, created_at)
  values (mid, tid, w.attempt_no, w.laps, w.accum, p_reason, p_t);
  return true;
end $$;

-- Stop everything at the exact moment the match clock hits zero.
create function private.check_expiry(p_t bigint) returns boolean language plpgsql as $$
declare s public.app_state; e bigint; sd text;
begin
  select * into s from public.app_state where id = 1;
  if s.clock_since is null or s.clock_over then return false; end if;
  if s.clock_accum + (p_t - s.clock_since) < s.duration_ms then return false; end if;
  e := s.clock_since + (s.duration_ms - s.clock_accum);
  update public.live_watches set accum = accum + greatest(0, e - since), since = null where status = 'running';
  for sd in select side from public.live_watches where status in ('running', 'paused', 'complete') order by side loop
    perform private.save_attempt(sd, 'timeout', e);
  end loop;
  update public.live_watches set status = 'done' where side in ('A', 'B');
  update public.app_state set clock_accum = duration_ms, clock_since = null, clock_over = true where id = 1;
  return true;
end $$;

-- The operator's press time (already in server time), when plausible: never in the future,
-- never before the watch's last event, at most 2 s back (network jitter).
create function private.action_time(a jsonb, p_t bigint, w public.live_watches) returns bigint
language plpgsql as $$
declare at numeric; fl bigint;
begin
  if jsonb_typeof(a -> 'at') <> 'number' then return p_t; end if;
  at := (a ->> 'at')::numeric;
  fl := greatest(w.last_t, coalesce(w.since, 0), p_t - 2000);
  return least(p_t, greatest(fl, at))::bigint;
end $$;

create function private.get_watch(a jsonb) returns public.live_watches language plpgsql as $$
declare w public.live_watches;
begin
  if (select match_id from public.app_state where id = 1) is null then perform private.fail('No match is running.'); end if;
  select * into w from public.live_watches where side = a ->> 'side';
  if not found then perform private.fail('side must be A or B'); end if;
  return w;
end $$;

create function private.match_checkpoints() returns int language sql stable as $$
  select m.checkpoints from public.matches m join public.app_state s on s.match_id = m.id where s.id = 1
$$;

-- Start the next unplayed match of the current round, or show the bracket when the round is over.
create function private.start_next(p_t bigint, p_cps int) returns void language plpgsql as $$
declare s public.app_state; nxt public.matches;
begin
  select * into s from public.app_state where id = 1;
  select * into nxt from public.matches where round = s.t_round and status = 'pending' order by slot limit 1;
  if not found then
    perform private.reset_live(null);
    update public.app_state set t_view = 'bracket',
      t_champion = case when s.t_round = 2 then (select winner from public.matches where round = 2 and slot = 0) else t_champion end
    where id = 1;
    return;
  end if;
  update public.matches set status = 'live', started_at = p_t, checkpoints = coalesce(p_cps, checkpoints) where id = nxt.id;
  perform private.reset_live(nxt.id);
  update public.app_state set t_view = 'match' where id = 1;
end $$;

-- ---------- actions ----------

create function private.do_action(a jsonb, t bigint) returns void language plpgsql as $$
declare
  kind text := a ->> 'type';
  s public.app_state;
  w public.live_watches;
  tt bigint;
  n int;
  most int;
  v_laps jsonb;
  saved boolean;
  r public.attempts;
  v_total bigint;
  m public.matches;
  winner_id bigint;
  ids bigint[];
  ord int[];
  sz int;
  i int;
  j int;
  tmp bigint;
  nm text;
  hs numeric;
  ln text;
  parts text[];
  names text[] := '{}';
  heads numeric[] := '{}';
begin
  select * into s from public.app_state where id = 1;

  case kind
  when 'ping' then
    null;

  -- ----- stopwatches -----
  when 'watch.start' then
    w := private.get_watch(a);
    if s.clock_over then perform private.fail('Time is up for this match.'); end if;
    if w.status in ('idle', 'paused') then
      tt := private.action_time(a, t, w);
      update public.live_watches set status = 'running', since = tt, last_t = tt where side = w.side;
      if s.clock_since is null then update public.app_state set clock_since = tt where id = 1; end if;
    end if;

  when 'watch.lap' then
    w := private.get_watch(a);
    if w.status = 'running' then
      tt := private.action_time(a, t, w);
      v_laps := w.laps || to_jsonb(w.accum + tt - w.since);
      update public.live_watches set laps = v_laps, accum = 0, since = tt, last_t = tt where side = w.side;
      if jsonb_array_length(v_laps) >= private.match_checkpoints() then
        -- the last checkpoint is the finish line: the run is over
        update public.live_watches set status = 'complete', since = null where side = w.side;
      end if;
    end if;

  when 'watch.stop' then
    w := private.get_watch(a);
    if w.status = 'running' then
      tt := private.action_time(a, t, w);
      update public.live_watches set status = 'paused', accum = accum + tt - since, since = null, last_t = tt where side = w.side;
    end if;

  when 'watch.reset' then
    w := private.get_watch(a);
    if w.status in ('paused', 'complete') then
      saved := private.save_attempt(w.side, 'reset', t);
      update public.live_watches set status = 'idle', laps = '[]', accum = 0, since = null, last_t = 0,
        attempt_no = case when saved then attempt_no + 1 else attempt_no end
      where side = w.side;
    end if;

  when 'watch.undo' then
    -- fold an accidental split back into the current lap
    w := private.get_watch(a);
    if w.status in ('running', 'paused', 'complete') and jsonb_array_length(w.laps) > 0 then
      update public.live_watches set
        accum = accum + (laps ->> -1)::bigint,
        laps = laps - (jsonb_array_length(laps) - 1),
        status = case when status = 'complete' then 'paused' else status end
      where side = w.side;
    end if;

  when 'watch.edit' then
    w := private.get_watch(a);
    v_laps := private.ms_list(a -> 'laps');
    if jsonb_array_length(v_laps) <> jsonb_array_length(w.laps) then
      perform private.fail('Use Undo to remove a checkpoint; editing keeps the same number of splits.');
    end if;
    update public.live_watches set laps = v_laps where side = w.side;

  when 'attempt.edit' then
    select * into r from public.attempts where id = (a ->> 'id')::bigint;
    if not found then perform private.fail('Unknown attempt.'); end if;
    v_laps := private.ms_list(a -> 'laps');
    v_total := coalesce((a ->> 'totalMs')::numeric::bigint, private.lap_sum(v_laps) + r.partial_ms);
    if v_total < private.lap_sum(v_laps) then perform private.fail('Total time can''t be less than the checkpoint splits added up.'); end if;
    update public.attempts set laps = v_laps, partial_ms = v_total - private.lap_sum(v_laps), edited = true where id = r.id;

  when 'attempt.delete' then
    update public.attempts set voided = true where id = (a ->> 'id')::bigint;

  -- ----- match clock -----
  when 'clock.start' then
    if s.match_id is null then perform private.fail('No match is running.'); end if;
    if not s.clock_over and s.clock_since is null then update public.app_state set clock_since = t where id = 1; end if;

  when 'clock.pause' then
    -- emergency freeze: the clock and both robots
    if s.clock_since is not null then
      update public.app_state set clock_accum = clock_accum + t - clock_since, clock_since = null where id = 1;
      update public.live_watches set status = 'paused', accum = accum + t - since, since = null, last_t = t where status = 'running';
    end if;

  -- ----- match / tournament flow -----
  when 'match.restart' then
    if s.match_id is null then perform private.fail('No match is running.'); end if;
    update public.attempts set voided = true where match_id = s.match_id;
    perform private.reset_live(s.match_id);

  when 'match.checkpoints' then
    if s.match_id is null then perform private.fail('No match is running.'); end if;
    n := coalesce((a ->> 'n')::int, 0);
    if n < 1 or n > 30 then perform private.fail('Checkpoints must be between 1 and 30.'); end if;
    select max(jsonb_array_length(lw.laps)) into most from public.live_watches lw;
    if n < most then perform private.fail(format('A team has already passed %s checkpoints.', most)); end if;
    update public.matches set checkpoints = n where id = s.match_id;
    -- course got longer: a finished run can carry on
    update public.live_watches set status = 'paused' where status = 'complete' and jsonb_array_length(live_watches.laps) < n;

  when 'match.finish' then
    if s.match_id is null then perform private.fail('No match is running.'); end if;
    if coalesce(a ->> 'winner', '') not in ('A', 'B') then perform private.fail('Pick the winner.'); end if;
    update public.live_watches set accum = accum + t - since, since = null where status = 'running';
    for w in select * from public.live_watches where status in ('running', 'paused', 'complete') order by side loop
      perform private.save_attempt(w.side, 'match_end', t);
    end loop;
    select * into m from public.matches where id = s.match_id;
    winner_id := case when a ->> 'winner' = 'A' then m.team_a else m.team_b end;
    update public.matches set status = 'done', winner = winner_id, ended_at = t where id = m.id;
    perform private.start_next(t, m.checkpoints);

  when 'bracket.generate' then
    if exists (select 1 from public.matches) then perform private.fail('A bracket already exists. Reset the tournament first.'); end if;
    select array_agg(id order by seed, id) into ids from public.teams;
    n := coalesce(array_length(ids, 1), 0);
    if n < 2 then perform private.fail('Add at least two teams.'); end if;
    sz := 2;
    while sz < n loop sz := sz * 2; end loop;
    ord := private.bracket_order(sz);
    for i in 0 .. sz / 2 - 1 loop
      -- ids[seed] is null past the last team: that's a bye
      insert into public.matches (round, slot, team_a, team_b, status, winner, checkpoints, ended_at)
      select sz, i, x.ta, x.tb,
        case when x.ta is null or x.tb is null then 'done' else 'pending' end,
        case when x.ta is null or x.tb is null then coalesce(x.ta, x.tb) end,
        s.default_checkpoints,
        case when x.ta is null or x.tb is null then t end
      from (select ids[ord[2 * i + 1]] as ta, ids[ord[2 * i + 2]] as tb) x;
    end loop;
    update public.app_state set t_size = sz, t_round = sz, t_view = 'bracket', t_champion = null where id = 1;
    perform private.reset_live(null);

  when 'tournament.reset' then
    perform private.reset_live(null);
    delete from public.attempts where id is not null;
    delete from public.matches where id is not null;
    update public.app_state set t_size = null, t_round = null, t_view = 'setup', t_champion = null where id = 1;

  when 'round.proceed' then
    -- start the current round, or build the next one from this round's winners
    if s.t_size is null then perform private.fail('Generate the bracket first.'); end if;
    if s.match_id is not null then
      update public.app_state set t_view = 'match' where id = 1;
    elsif exists (select 1 from public.matches where round = s.t_round and status = 'pending') then
      perform private.start_next(t, null);
    elsif s.t_round = 2 then
      perform private.fail('The tournament is over.');
    else
      select checkpoints into n from public.matches where round = s.t_round order by ended_at desc nulls last limit 1;
      for i in 0 .. s.t_round / 4 - 1 loop
        insert into public.matches (round, slot, team_a, team_b, checkpoints)
        values (s.t_round / 2, i,
          (select winner from public.matches where round = s.t_round and slot = 2 * i),
          (select winner from public.matches where round = s.t_round and slot = 2 * i + 1), n);
      end loop;
      update public.app_state set t_round = s.t_round / 2 where id = 1;
      perform private.start_next(t, null);
    end if;

  when 'view.set' then
    if s.t_size is null or coalesce(a ->> 'view', '') not in ('match', 'bracket') then perform private.fail('Nothing to show yet.'); end if;
    if a ->> 'view' = 'match' and s.match_id is null then perform private.fail('No match is running.'); end if;
    update public.app_state set t_view = a ->> 'view' where id = 1;

  -- ----- teams -----
  when 'teams.add' then
    nm := private.clean_name(a ->> 'name');
    hs := private.parse_headstart(a ->> 'headstart');
    if (select count(*) from public.teams) >= 64 then perform private.fail('Too many teams.'); end if;
    if exists (select 1 from public.teams where lower(name) = lower(nm)) then perform private.fail(format('A team called %s already exists.', nm)); end if;
    insert into public.teams (name, headstart, seed) values (nm, hs, coalesce((select max(seed) from public.teams), 0) + 1);

  when 'teams.bulk' then
    -- one team per line, best seed first: "name, headstart" (comma or tab)
    i := 0;
    for ln in select * from regexp_split_to_table(coalesce(a ->> 'text', ''), E'\r?\n') loop
      i := i + 1;
      continue when btrim(ln) = '';
      if position(E'\t' in ln) > 0 then
        parts := array[split_part(ln, E'\t', 1), split_part(ln, E'\t', 2)];
      else
        parts := coalesce(regexp_match(ln, '^(.*),([^,]*)$'), array[ln, '']);
      end if;
      begin
        names := names || private.clean_name(parts[1]);
        heads := heads || private.parse_headstart(parts[2]);
      exception when others then
        perform private.fail(format('Line %s: %s', i, sqlerrm));
      end;
    end loop;
    for j in 1 .. coalesce(array_length(names, 1), 0) loop
      if exists (select 1 from public.teams where lower(name) = lower(names[j])) then
        update public.teams set headstart = heads[j] where lower(name) = lower(names[j]);
      else
        insert into public.teams (name, headstart, seed) values (names[j], heads[j], coalesce((select max(seed) from public.teams), 0) + 1);
      end if;
    end loop;

  when 'teams.update' then
    if not exists (select 1 from public.teams where id = (a ->> 'id')::bigint) then perform private.fail('Unknown team.'); end if;
    if a ? 'name' then
      nm := private.clean_name(a ->> 'name');
      if exists (select 1 from public.teams where lower(name) = lower(nm) and id <> (a ->> 'id')::bigint) then
        perform private.fail(format('A team called %s already exists.', nm));
      end if;
      update public.teams set name = nm where id = (a ->> 'id')::bigint;
    end if;
    if a ? 'headstart' then
      update public.teams set headstart = private.parse_headstart(a ->> 'headstart') where id = (a ->> 'id')::bigint;
    end if;

  when 'teams.move' then
    -- swap a team's seed with its neighbour above (dir -1) or below (dir 1)
    if s.t_size is not null then perform private.fail('Seeds are locked once the bracket exists. Reset the tournament to reseed.'); end if;
    select array_agg(id order by seed, id) into ids from public.teams;
    i := array_position(ids, (a ->> 'id')::bigint);
    if i is null then perform private.fail('Unknown team.'); end if;
    j := i + case when (a ->> 'dir')::int = 1 then 1 else -1 end;
    if j between 1 and array_length(ids, 1) then
      tmp := ids[i]; ids[i] := ids[j]; ids[j] := tmp;
      update public.teams tm set seed = u.ord from unnest(ids) with ordinality u(tid, ord) where tm.id = u.tid;
    end if;

  when 'teams.delete' then
    if exists (select 1 from public.matches where team_a = (a ->> 'id')::bigint or team_b = (a ->> 'id')::bigint) then
      perform private.fail('This team is in the bracket. Reset the tournament to remove it.');
    end if;
    delete from public.teams where id = (a ->> 'id')::bigint;
    update public.teams tm set seed = u.ord
    from (select id, row_number() over (order by seed, id) as ord from public.teams) u where tm.id = u.id;

  when 'settings.update' then
    if a ? 'matchDurationMs' then
      if s.clock_since is not null or s.clock_accum > 0 then
        perform private.fail('Change the match length between matches (or after Restart Match).');
      end if;
      n := (a ->> 'matchDurationMs')::numeric::int;
      if n < 10000 or n > 3600000 then perform private.fail('Match length must be between 10 s and 60 min.'); end if;
      update public.app_state set duration_ms = n where id = 1;
    end if;
    if a ? 'defaultCheckpoints' then
      n := (a ->> 'defaultCheckpoints')::int;
      if n < 1 or n > 30 then perform private.fail('Checkpoints must be between 1 and 30.'); end if;
      update public.app_state set default_checkpoints = n where id = 1;
    end if;

  else
    perform private.fail(format('Unknown action: %s', kind));
  end case;
end $$;

-- ---------- snapshot (what every page renders) ----------

create function private.attempts_json(p_match bigint, p_team bigint, p_head numeric) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'no', a.attempt_no, 'laps', a.laps, 'partialMs', a.partial_ms,
      'checkpoints', jsonb_array_length(a.laps), 'timeMs', r.run, 'totalMs', r.run + a.partial_ms,
      'scoreMs', r.run - round(p_head * 1000)::bigint, 'reason', a.end_reason, 'edited', a.edited)
    order by a.attempt_no, a.id), '[]')
  from public.attempts a cross join lateral (select private.lap_sum(a.laps) as run) r
  where a.match_id = p_match and a.team_id = p_team and not a.voided
$$;

-- Best attempt: more checkpoints first (capped at the course length), then lower score.
create function private.best_json(p_att jsonb, n int) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(p_att) x
  order by least((x ->> 'checkpoints')::int, n) desc, (x ->> 'scoreMs')::bigint asc
  limit 1
$$;

create function private.side_json(m public.matches, p_side text) returns jsonb language plpgsql stable as $$
declare tid bigint := case when p_side = 'A' then m.team_a else m.team_b end; att jsonb;
begin
  if tid is null then return jsonb_build_object('teamId', null, 'attempts', '[]'::jsonb, 'best', null); end if;
  att := private.attempts_json(m.id, tid, (select headstart from public.teams where id = tid));
  return jsonb_build_object('teamId', tid, 'attempts', att, 'best', private.best_json(att, m.checkpoints));
end $$;

create function private.bteam(tid bigint) returns jsonb language sql stable as $$
  select case when tid is null then null else
    (select jsonb_build_object('id', id, 'name', name, 'seed', seed) from public.teams where id = tid) end
$$;

create function private.bracket_json(s public.app_state) returns jsonb language plpgsql stable as $$
declare
  rounds jsonb := '[]';
  prev jsonb;
  cur jsonb;
  r int;
  i int;
  m public.matches;
  ta bigint;
  tb bigint;
  a_best jsonb;
  b_best jsonb;
begin
  if s.t_size is null then return rounds; end if;
  r := s.t_size;
  while r >= 2 loop
    cur := '[]';
    for i in 0 .. r / 2 - 1 loop
      select * into m from public.matches where round = r and slot = i;
      if found then
        a_best := null; b_best := null;
        if m.status = 'done' then
          a_best := private.side_json(m, 'A') -> 'best';
          b_best := private.side_json(m, 'B') -> 'best';
        end if;
        cur := cur || jsonb_build_object(
          'id', m.id, 'slot', i, 'status', m.status, 'checkpoints', m.checkpoints,
          'live', m.id = s.match_id, 'bye', m.status = 'done' and (m.team_a is null or m.team_b is null),
          'winnerId', m.winner, 'a', private.bteam(m.team_a), 'b', private.bteam(m.team_b),
          'bestA', a_best, 'bestB', b_best);
      else
        -- not created yet: fill in whoever has already won their way here
        ta := (prev -> (2 * i) ->> 'winnerId')::bigint;
        tb := (prev -> (2 * i + 1) ->> 'winnerId')::bigint;
        cur := cur || jsonb_build_object(
          'id', null, 'slot', i, 'status', 'future', 'checkpoints', null, 'live', false, 'bye', false,
          'winnerId', null, 'a', private.bteam(ta), 'b', private.bteam(tb), 'bestA', null, 'bestB', null);
      end if;
    end loop;
    rounds := rounds || jsonb_build_object('round', r,
      'name', case r when 2 then 'The Final' when 4 then 'Semi-finals' when 8 then 'Quarter-finals' else 'Round of ' || r end,
      'matches', cur);
    prev := cur;
    r := r / 2;
  end loop;
  return rounds;
end $$;

create function public.zipit_snapshot() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.app_state;
  m public.matches;
  teams jsonb;
  v_match jsonb := null;
  tour jsonb;
  watches jsonb;
begin
  select * into s from public.app_state where id = 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'headstart', t.headstart, 'seed', t.seed,
      'eliminated', l.round is not null, 'eliminatedRound', l.round,
      'unseeded', s.t_size is not null and not exists (
        select 1 from public.matches x where x.team_a = t.id or x.team_b = t.id))
    order by t.seed, t.id), '[]')
  into teams
  from public.teams t
  left join lateral (
    select x.round from public.matches x
    where x.status = 'done' and x.winner is not null and x.winner <> t.id and (x.team_a = t.id or x.team_b = t.id)
    order by x.round limit 1
  ) l on true;

  if s.match_id is not null then
    select * into m from public.matches where id = s.match_id;
    select jsonb_object_agg(side, jsonb_build_object(
        'status', status, 'laps', laps, 'accum', accum, 'since', since, 'attemptNo', attempt_no))
    into watches from public.live_watches;
    v_match := jsonb_build_object(
      'id', m.id, 'round', m.round, 'slot', m.slot, 'checkpoints', m.checkpoints,
      'matchNo', (select count(*) from public.matches x where x.round = m.round and x.team_a is not null and x.team_b is not null and x.slot <= m.slot),
      'matchCount', (select count(*) from public.matches x where x.round = m.round and x.team_a is not null and x.team_b is not null),
      'sides', jsonb_build_object(
        'A', private.side_json(m, 'A') || jsonb_build_object('watch', watches -> 'A'),
        'B', private.side_json(m, 'B') || jsonb_build_object('watch', watches -> 'B')));
  end if;

  tour := jsonb_build_object('size', s.t_size, 'round', s.t_round, 'view', s.t_view, 'champion', s.t_champion);
  if s.t_size is not null then
    tour := tour || jsonb_build_object(
      'roundOver', not exists (select 1 from public.matches x where x.round = s.t_round and x.status <> 'done'),
      'roundStarted', exists (select 1 from public.matches x where x.round = s.t_round and x.status <> 'pending'
                               and x.team_a is not null and x.team_b is not null));
  end if;

  return jsonb_build_object(
    'schema', 2,                       -- bump when this file changes, so a deploy can be checked from outside
    'version', s.version,
    'serverNow', private.now_ms(),
    'settings', jsonb_build_object('matchDurationMs', s.duration_ms, 'defaultCheckpoints', s.default_checkpoints),
    'teams', teams,
    'tournament', tour,
    'bracket', private.bracket_json(s),
    'match', v_match,
    'clock', jsonb_build_object('accum', s.clock_accum, 'since', s.clock_since, 'over', s.clock_over, 'durationMs', s.duration_ms));
end $$;

-- ---------- public API ----------

-- Every admin change. Returns the new snapshot; errors come back as the exception message.
create function public.zipit_action(p_key text, p_action jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t bigint;
begin
  perform private.check_key(p_key);
  perform 1 from public.app_state where id = 1 for update;   -- one change at a time
  t := private.now_ms();
  perform private.check_expiry(t);
  perform private.do_action(coalesce(p_action, '{}'), t);
  update public.app_state set version = version + 1 where id = 1;
  return public.zipit_snapshot();
end $$;

-- Anyone may call this: it only applies the 10-minute stop if it is due.
create function public.zipit_tick() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.app_state where id = 1 for update;
  if private.check_expiry(private.now_ms()) then
    update public.app_state set version = version + 1 where id = 1;
    return true;
  end if;
  return false;
end $$;

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.zipit_action(text, jsonb), public.zipit_tick(), public.zipit_snapshot() from public;
grant execute on function public.zipit_action(text, jsonb), public.zipit_tick(), public.zipit_snapshot() to anon, authenticated;
