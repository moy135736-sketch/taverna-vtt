// Учётные данные TURN: временный логин и HMAC-подпись, совместимые с coturn --use-auth-secret
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.TURN_URLS = 'turn:vtt.example.ru:3478?transport=udp,turn:vtt.example.ru:3478?transport=tcp';
process.env.TURN_SECRET = 'секрет-для-теста';
process.env.STUN_URLS = 'stun:stun.example.org:3478';
process.env.DATA_DIR = process.env.DATA_DIR || (await import('node:os')).tmpdir() + '/taverna-rtc-test';
const { iceServersFor } = await import('../server/rtc.js');

test('STUN и TURN с временным паролем', () => {
  const list = iceServersFor('user42');
  assert.deepEqual(list[0], { urls: ['stun:stun.example.org:3478'] });
  const turn = list[1];
  assert.deepEqual(turn.urls, ['turn:vtt.example.ru:3478?transport=udp', 'turn:vtt.example.ru:3478?transport=tcp']);
  const [exp, user] = turn.username.split(':');
  assert.equal(user, 'user42');
  const left = Number(exp) - Date.now() / 1000;
  assert.ok(left > 23 * 3600 && left <= 24 * 3600 + 1, 'срок — сутки');
  const want = crypto.createHmac('sha1', 'секрет-для-теста').update(turn.username).digest('base64');
  assert.equal(turn.credential, want);
});
