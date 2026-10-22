-- Run once in Supabase SQL Editor. The public anon key is safe in the frontend;
-- sensitive tables cannot be read or modified directly by visitors.
-- Uses PostgreSQL built-in gen_random_uuid(); no extension required.
create table if not exists public.quiz_games (
 id uuid primary key default gen_random_uuid(),
 pin text unique not null,
 phase text not null default 'lobby' check (phase in ('lobby','question','results','finished')),
 question_index integer not null default -1,
 started_at timestamptz,
 created_at timestamptz not null default now()
);
create table if not exists public.quiz_hosts (
 game_id uuid primary key references public.quiz_games(id) on delete cascade,
 token text not null
);
create table if not exists public.quiz_questions (
 id uuid primary key default gen_random_uuid(),
 game_id uuid not null references public.quiz_games(id) on delete cascade,
 position integer not null,
 prompt text not null,
 options jsonb not null,
 correct_index integer not null check (correct_index between 0 and 3),
 seconds integer not null default 20 check (seconds between 5 and 120),
 unique(game_id, position)
);
create table if not exists public.quiz_players (
 id uuid primary key default gen_random_uuid(),
 game_id uuid not null references public.quiz_games(id) on delete cascade,
 nickname text not null,
 token text not null,
 score integer not null default 0,
 joined_at timestamptz not null default now(),
 unique(game_id, nickname)
);
create table if not exists public.quiz_answers (
 id uuid primary key default gen_random_uuid(),
 game_id uuid not null references public.quiz_games(id) on delete cascade,
 player_id uuid not null references public.quiz_players(id) on delete cascade,
 question_id uuid not null references public.quiz_questions(id) on delete cascade,
 choice integer not null,
 points integer not null,
 unique(player_id, question_id)
);
create index if not exists quiz_players_game_idx on public.quiz_players(game_id);
create index if not exists quiz_questions_game_idx on public.quiz_questions(game_id, position);
-- Lock down all underlying tables. Access is exclusively through validated RPCs.
revoke all on public.quiz_games,public.quiz_hosts,public.quiz_questions,public.quiz_players,public.quiz_answers from anon,authenticated;
alter table public.quiz_games enable row level security;
alter table public.quiz_hosts enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_players enable row level security;
alter table public.quiz_answers enable row level security;

create or replace function public.quiz_create(p_questions jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g uuid; p text; tok text; item jsonb; n int:=0;
begin
 if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) < 1 or jsonb_array_length(p_questions) > 30 then raise exception 'Provide 1–30 questions'; end if;
 for item in select value from jsonb_array_elements(p_questions) loop
  if length(trim(coalesce(item->>'prompt',''))) < 4 or jsonb_typeof(item->'options') <> 'array' or jsonb_array_length(item->'options') <> 4 or (item->>'correctIndex')::int not between 0 and 3 or (item->>'seconds')::int not between 5 and 120 then raise exception 'Invalid question'; end if;
  if exists(select 1 from jsonb_array_elements_text(item->'options') o where length(trim(o.value)) < 1) then raise exception 'Empty answer'; end if;
 end loop;
 loop
  p := lpad((floor(random()*1000000))::int::text, 6, '0');
  begin
   insert into public.quiz_games(pin) values(p) returning id into g;
   exit;
  exception when unique_violation then null;
  end;
 end loop;
 tok := gen_random_uuid()::text || gen_random_uuid()::text;
 insert into public.quiz_hosts(game_id,token) values(g,tok);
 for item in select value from jsonb_array_elements(p_questions) loop
  insert into public.quiz_questions(game_id,position,prompt,options,correct_index,seconds)
  values(g,n,trim(item->>'prompt'),item->'options',(item->>'correctIndex')::int,(item->>'seconds')::int);
  n:=n+1;
 end loop;
 return jsonb_build_object('gameId',g,'pin',p,'hostToken',tok);
end $$;

create or replace function public.quiz_join(p_pin text,p_nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.quiz_games%rowtype; pl uuid; tok text;
begin
 select * into g from public.quiz_games where pin=p_pin;
 if not found then raise exception 'Game not found'; end if;
 if g.phase<>'lobby' then raise exception 'This game has already started'; end if;
 if length(trim(coalesce(p_nickname,''))) not between 2 and 24 then raise exception 'Nickname must be 2–24 characters'; end if;
 perform pg_advisory_xact_lock(hashtext(g.id::text));
 if (select count(*) from public.quiz_players where game_id=g.id)>=50 then raise exception 'Game is full (50 players maximum)'; end if;
 tok:=gen_random_uuid()::text || gen_random_uuid()::text;
 insert into public.quiz_players(game_id,nickname,token) values(g.id,trim(p_nickname),tok) returning id into pl;
 -- Trigger a game change so everyone refreshes the lobby.
 update public.quiz_games set started_at=null where id=g.id;
 return jsonb_build_object('gameId',g.id,'playerId',pl,'playerToken',tok,'pin',g.pin);
exception when unique_violation then raise exception 'Nickname already taken';
end $$;

create or replace function public.quiz_state(p_pin text,p_player_id uuid default null,p_player_token text default null,p_host_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.quiz_games%rowtype; q public.quiz_questions%rowtype; qcount int; players jsonb; leaderboard jsonb; ans jsonb; mine jsonb; is_host boolean;
begin
 select * into g from public.quiz_games where pin=p_pin;
 if not found then raise exception 'Game not found'; end if;
 is_host:=exists(select 1 from public.quiz_hosts where game_id=g.id and token=p_host_token);
 if not is_host and not exists(select 1 from public.quiz_players where game_id=g.id and id=p_player_id and token=p_player_token) then raise exception 'Invalid player session'; end if;
 select count(*) into qcount from public.quiz_questions where game_id=g.id;
 select coalesce(jsonb_agg(nickname order by joined_at), '[]'::jsonb) into players from public.quiz_players where game_id=g.id;
 select coalesce(jsonb_agg(jsonb_build_object('nickname',nickname,'score',score) order by score desc,joined_at),'[]'::jsonb) into leaderboard from public.quiz_players where game_id=g.id;
 select * into q from public.quiz_questions where game_id=g.id and position=g.question_index;
 select coalesce(jsonb_agg(jsonb_build_object('choice',choice,'count',cnt)),'[]'::jsonb) into ans from (select choice,count(*) cnt from public.quiz_answers where question_id=q.id group by choice) a;
 if p_player_id is not null then select jsonb_build_object('choice',a.choice,'points',a.points) into mine from public.quiz_answers a join public.quiz_players pl on pl.id=a.player_id where a.question_id=q.id and a.player_id=p_player_id and pl.token=p_player_token; end if;
 return jsonb_build_object('pin',g.pin,'phase',g.phase,'questionIndex',g.question_index,'questionCount',qcount,'startedAt',g.started_at,'players',players,'leaderboard',case when g.phase in ('results','finished') or is_host then leaderboard else '[]'::jsonb end,'isHost',is_host,'myAnswer',mine,
 'question',case when q.id is null then null else jsonb_build_object('prompt',q.prompt,'options',q.options,'seconds',q.seconds,'correctIndex',case when g.phase in ('results','finished') then to_jsonb(q.correct_index) else 'null'::jsonb end,'answerCounts',case when g.phase='results' then ans else '[]'::jsonb end) end);
end $$;

create or replace function public.quiz_submit(p_pin text,p_player_id uuid,p_player_token text,p_choice int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.quiz_games%rowtype; q public.quiz_questions%rowtype; secs numeric; pts int;
begin
 select * into g from public.quiz_games where pin=p_pin for update;
 if not found or g.phase<>'question' then raise exception 'Question is not active'; end if;
 if not exists(select 1 from public.quiz_players where id=p_player_id and token=p_player_token and game_id=g.id) then raise exception 'Invalid player'; end if;
 select * into q from public.quiz_questions where game_id=g.id and position=g.question_index;
 secs:=extract(epoch from clock_timestamp()-g.started_at);
 if secs>q.seconds or secs<0 then raise exception 'Answer time is over'; end if;
 if p_choice not between 0 and 3 then raise exception 'Invalid option'; end if;
 pts:=case when p_choice=q.correct_index then greatest(500,round(1000*(1-secs/(q.seconds*2)))::int) else 0 end;
 insert into public.quiz_answers(game_id,player_id,question_id,choice,points) values(g.id,p_player_id,q.id,p_choice,pts);
 update public.quiz_players set score=score+pts where id=p_player_id;
 return jsonb_build_object('points',pts);
exception when unique_violation then raise exception 'Answer already submitted';
end $$;

create or replace function public.quiz_next(p_pin text,p_host_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.quiz_games%rowtype; n int; duration int;
begin
 select * into g from public.quiz_games where pin=p_pin for update;
 if not found or not exists(select 1 from public.quiz_hosts where game_id=g.id and token=p_host_token) then raise exception 'Host authorization failed'; end if;
 select count(*) into n from public.quiz_questions where game_id=g.id;
 if g.phase='lobby' then
  if not exists(select 1 from public.quiz_players where game_id=g.id) then raise exception 'At least one player must join'; end if;
  update public.quiz_games set phase='question',question_index=0,started_at=clock_timestamp() where id=g.id;
 elsif g.phase='question' then
  select seconds into duration from public.quiz_questions where game_id=g.id and position=g.question_index;
  if clock_timestamp()<g.started_at+make_interval(secs=>duration) then raise exception 'Wait for the question timer to end'; end if;
  update public.quiz_games set phase='results' where id=g.id;
 elsif g.phase='results' then
  if g.question_index+1>=n then update public.quiz_games set phase='finished' where id=g.id;
  else update public.quiz_games set phase='question',question_index=g.question_index+1,started_at=clock_timestamp() where id=g.id; end if;
 else raise exception 'Game has finished';
 end if;
 return jsonb_build_object('ok',true);
end $$;

revoke all on function public.quiz_create(jsonb),public.quiz_join(text,text),public.quiz_state(text,uuid,text,text),public.quiz_submit(text,uuid,text,int),public.quiz_next(text,text) from public;
grant execute on function public.quiz_create(jsonb),public.quiz_join(text,text),public.quiz_state(text,uuid,text,text),public.quiz_submit(text,uuid,text,int),public.quiz_next(text,text) to anon,authenticated;
-- Supabase Realtime needs a SELECT policy on quiz_games. This table contains
-- ONLY public game metadata: never secrets or answers.
grant select on public.quiz_games to anon,authenticated;
create policy "Public game events" on public.quiz_games for select to anon,authenticated using(true);
do $$ begin alter publication supabase_realtime add table public.quiz_games; exception when duplicate_object then null; end $$;
