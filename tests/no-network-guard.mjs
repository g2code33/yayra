import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

function blocked(name) {
  return function blockedNetwork() {
    throw new Error(`network disabled for tests: ${name}`);
  };
}
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
tls.connect = blocked('tls.connect');
http.request = blocked('http.request');
http.get = blocked('http.get');
https.request = blocked('https.request');
https.get = blocked('https.get');
if (globalThis.fetch) {
  const localFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input?.url || '');
    // Reading an in-memory Blob or data URL is part of offline rendering, not
    // network access. Keep those paths testable while every remote fetch fails.
    if (/^(?:blob|data):/i.test(url)) return localFetch(input, init);
    throw new Error('network disabled for tests: fetch');
  };
}
