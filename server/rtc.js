// Настройки WebRTC для голосового и видеочата: STUN/TURN-серверы для браузеров.
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Список ICE-серверов для пользователя.
 * С TURN_SECRET (coturn --use-auth-secret) выдаются временные учётные данные на сутки:
 * username = "<срок>:<id пользователя>", credential = base64(HMAC-SHA1(secret, username)).
 */
export function iceServersFor(userId) {
  const out = [];
  if (config.stunUrls.length) out.push({ urls: config.stunUrls });
  if (config.turnUrls.length) {
    if (config.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + 24 * 3600}:${userId}`;
      const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
      out.push({ urls: config.turnUrls, username, credential });
    } else if (config.turnUsername) {
      out.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnPassword });
    } else {
      out.push({ urls: config.turnUrls });
    }
  }
  return out;
}
