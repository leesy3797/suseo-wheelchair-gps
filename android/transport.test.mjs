import test from 'node:test';
import assert from 'node:assert/strict';
import { LocationTransport } from './transport.mjs';
class FakeSocket {
  connected = false;
  handlers = new Map();
  calls = [];
  on(event, callback) { this.handlers.set(event, callback); }
  timeout() { return this; }
  emit(event, data, callback) { this.calls.push({ event, data, callback }); }
  connect() { this.connected = true; this.handlers.get('connect')?.(); }
  disconnect() { this.connected = false; this.handlers.get('disconnect')?.(); }
  removeAllListeners() { this.handlers.clear(); }
}
const settings = { device_id: 'chair-1', device_name: '휠체어 01', server_url: 'https://test.example' };
const position = (timestamp) => ({ coords: { latitude: 37, longitude: 127, accuracy: 5 }, timestamp });
function setup() {
  const socket = new FakeSocket();
  const transport = new LocationTransport(() => socket);
  transport.start(settings);
  return { socket, transport };
}
test('never sends location before successful session registration', () => {
  const { socket, transport } = setup();
  transport.offer(position(1000));
  assert.deepEqual(socket.calls.map((c) => c.event), ['start_tracking']);
  socket.calls[0].callback(null, { ok: true });
  assert.equal(socket.calls[1].event, 'update_location');
  assert.equal(socket.calls[1].data.accuracy_m, 5);
  transport.stop();
});
test('keeps the newest measurement while disconnected and re-registers first', () => {
  const { socket, transport } = setup();
  socket.calls[0].callback(null, { ok: true });
  socket.disconnect();
  transport.offer(position(2000)); transport.offer(position(3000));
  socket.connect();
  assert.equal(socket.calls.at(-1).event, 'start_tracking');
  socket.calls.at(-1).callback(null, { ok: true });
  assert.equal(socket.calls.at(-1).data.timestamp, 3);
  transport.stop();
});
test('deduplicates foreground/background readings and serializes delivery', () => {
  const { socket, transport } = setup();
  socket.calls[0].callback(null, { ok: true });
  transport.offer(position(1000)); transport.offer(position(1000)); transport.offer(position(3000)); transport.offer(position(2000));
  assert.equal(socket.calls.filter((c) => c.event === 'update_location').length, 1);
  socket.calls[1].callback(null, { ok: true });
  assert.equal(socket.calls[2].data.timestamp, 3);
  socket.calls[2].callback(null, { ok: true });
  transport.offer(position(2000));
  assert.equal(socket.calls.length, 3);
  transport.stop();
});
test('a late registration acknowledgement cannot restart a stopped terminal', () => {
  const { socket, transport } = setup();
  const acknowledge = socket.calls[0].callback;
  transport.offer(position(1000)); transport.stop();
  acknowledge(null, { ok: true });
  assert.equal(socket.calls.length, 1);
  assert.equal(transport.enabled, false);
});
test('repeated background task startup reuses the existing connection', () => {
  const { socket, transport } = setup();
  transport.start({ ...settings });
  assert.equal(socket.calls.length, 1);
  transport.stop();
});
import { validServerOrigin } from './transport.mjs';
test('server origins validate on React Native without unsupported URL getters', () => {
  for (const url of ['https://example.ngrok-free.app', 'http://10.0.2.2:8000', 'http://localhost:8000', 'http://[::1]:8000']) assert.equal(validServerOrigin(url), true, url);
  for (const url of ['', 'file:///tmp/server', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?key=value', 'http://localhost:99999', 'http://localhost:0', 'https://bad host']) assert.equal(validServerOrigin(url), false, url);
});
test('background task completion waits for a location receipt', async () => {
  const { socket, transport } = setup();
  transport.offer(position(1000));
  const completion = transport.waitForDelivery();
  socket.calls[0].callback(null, { ok: true });
  socket.calls[1].callback(null, { ok: true, received_at: 1 });
  assert.equal(await completion, true);
  assert.equal(await transport.waitForDelivery(), true);
  transport.stop();
});
test('background task waiting is bounded while offline', async () => {
  const { transport } = setup();
  transport.offer(position(1000));
  assert.equal(await transport.waitForDelivery(5), false);
  transport.stop();
});
test('stopping resolves pending background waits without claiming delivery', async () => {
  const { transport } = setup();
  transport.offer(position(1000));
  const completion = transport.waitForDelivery();
  transport.stop();
  assert.equal(await completion, false);
});
test('a rejected duplicate identity never transmits its location', () => {
  const { socket, transport } = setup();
  transport.offer(position(1000));
  socket.calls[0].callback(null, { ok: false, message: '중복 ID' });
  assert.equal(socket.calls.length, 1);
  assert.equal(transport.registered, false);
  transport.stop();
});
