'use strict';

function relayPort(env = process.env) {
  const raw = env.GLIDER_PORT || env.RELAY_PORT || '19988';
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== String(raw).trim()) {
    throw new Error(`Invalid relay port "${raw}" (expected an integer from 1 to 65535)`);
  }
  return port;
}

function relayHttpUrl(env = process.env) {
  return env.RELAY_HTTP || `http://127.0.0.1:${relayPort(env)}`;
}

function relayWebSocketUrl(env = process.env) {
  return env.RELAY_URL || `ws://127.0.0.1:${relayPort(env)}/cdp`;
}

module.exports = {
  relayHttpUrl,
  relayPort,
  relayWebSocketUrl,
};
