import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Runs the real PL/pgSQL RPCs in a local PostgreSQL WASM instance.
// Supabase's publication is supplied locally; network delivery is not tested.
const db = new PGlite();
let sql;
const questions = [
  { prompt: 'Which planet is red?', options: ['Mars', 'Earth', 'Venus', 'Neptune'], correctIndex: 0, seconds: 20 },
  { prompt: 'What is two plus two?', options: ['One', 'Two', 'Three', 'Four'], correctIndex: 3, seconds: 20 }
];
async function value(query, args = []) {
  return (await db.query(query, args)).rows[0].result;
}
const createGame = () => value('select public.quiz_create($1::jsonb) as result', [JSON.stringify(questions)]);
const join = (game, name) => value('select public.quiz_join($1,$2) as result', [game.pin, name]);
const next = (game, token = game.hostToken) => value('select public.quiz_next($1,$2) as result', [game.pin, token]);
const state = (game, player) => value('select public.quiz_state($1,$2::uuid,$3,$4) as result',
  [game.pin, player?.playerId ?? null, player?.playerToken ?? null, player ? null : game.hostToken]);
const submit = (game, player, choice, token = player.playerToken) =>
  value('select public.quiz_submit($1,$2::uuid,$3,$4::int) as result', [game.pin, player.playerId, token, choice]);
const expire = (game) => db.query("update public.quiz_games set started_at=clock_timestamp()-interval '21 seconds' where id=$1", [game.gameId]);

before(async () => {
  await db.exec('create role anon; create role authenticated; create publication supabase_realtime;');
  sql = await readFile(new URL('../setup.sql', import.meta.url), 'utf8');
  await db.exec(sql);
});
after(async () => { await db.close(); });

test('50 players can join and player 51 is refused by the database', async () => {
  const game = await createGame();
  const players = await Promise.all(Array.from({ length: 50 }, (_, i) => join(game, `Player ${i + 1}`)));
  assert.equal(new Set(players.map(p => p.playerId)).size, 50);
  await assert.rejects(join(game, 'Player 51'), /Game is full/);
  assert.equal((await state(game)).players.length, 50);
});

test('quiz titles persist for hosts and players, including older clients', async () => {
  const game = await value('select public.quiz_create($1::jsonb,$2) as result',
    [JSON.stringify(questions), '  BKSZM Anniversary Quiz 2026  ']);
  const player = await join(game, 'Title tester');
  assert.equal((await state(game)).title, 'BKSZM Anniversary Quiz 2026');
  assert.equal((await state(game, player)).title, 'BKSZM Anniversary Quiz 2026');
  const legacy = await createGame();
  assert.equal((await state(legacy)).title, 'QuizRoom Live');
  for (const title of [null, '', ' ', 'x'.repeat(121)]) {
    await assert.rejects(value('select public.quiz_create($1::jsonb,$2) as result',
      [JSON.stringify(questions), title]), /Quiz title must/);
  }
});

test('sessions, timer, server scoring, repeated answers and final leaderboard', async () => {
  const game = await createGame();
  await assert.rejects(next(game), /At least one player/);
  const alice = await join(game, 'Alice');
  const bob = await join(game, 'Bob');
  await assert.rejects(join(game, 'Alice'), /Nickname already taken/);
  await assert.rejects(next(game, 'forged-token'), /authorization failed/);
  await next(game);
  await assert.rejects(join(game, 'Late player'), /already started/);
  assert.ok((await state(game)).startedAt);
  const active = await state(game, alice);
  assert.equal(active.phase, 'question');
  assert.equal(active.question.correctIndex, null);
  assert.deepEqual(active.leaderboard, []);
  await assert.rejects(submit(game, alice, 0, 'forged-token'), /Invalid player/);
  await assert.rejects(submit(game, alice, null), /Invalid option/);
  const answer = await submit(game, alice, 0);
  assert.ok(answer.points >= 500 && answer.points <= 1000);
  assert.equal((await submit(game, bob, 1)).points, 0);
  await assert.rejects(submit(game, alice, 0), /already submitted/);
  await assert.rejects(next(game), /Wait for the question timer/);
  await expire(game);
  await next(game);
  const results = await state(game, alice);
  assert.equal(results.question.correctIndex, 0);
  assert.equal(results.leaderboard[0].nickname, 'Alice');
  assert.equal(results.leaderboard[0].score, answer.points);
  await next(game);
  assert.equal((await state(game)).questionIndex, 1);
  await expire(game);
  await assert.rejects(submit(game, alice, 3), /Answer time is over/);
  await next(game);
  await next(game);
  assert.equal((await state(game)).phase, 'finished');
});

test('anonymous visitors cannot read secrets, correct answers, or edit scores', async () => {
  await db.exec('set role anon;');
  try {
    for (const table of ['quiz_hosts', 'quiz_questions', 'quiz_players', 'quiz_answers']) {
      await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
    }
    await assert.rejects(db.query('update public.quiz_players set score=999999'), /permission denied/);
    const game = await createGame();
    await assert.rejects(value('select public.quiz_state($1) as result', [game.pin]), /Invalid player session/);
    await join(game, 'Anonymous guest');
    await next(game);
    assert.equal((await state(game)).phase, 'question');
  } finally {
    await db.exec('reset role;');
  }
});

test('setup can be rerun without deleting existing games', async () => {
  const game = await createGame();
  await join(game, 'Still here');
  await db.exec(sql);
  assert.deepEqual((await state(game)).players, ['Still here']);
});
