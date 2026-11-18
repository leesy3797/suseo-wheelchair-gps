import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceState, timeAgo } from './device-state.mjs';
const device = { online: true, timestamp: 990, received_at: 992, accuracy_m: 5, floor_id: 'station-1f.glb' };
test('state distinguishes offline, stale measurement, unknown floor, and accuracy', () => {
  assert.equal(deviceState(device, true, 1000).key, 'normal');
  assert.equal(deviceState(device, false, 1000).key, 'offline');
  assert.equal(deviceState({ ...device, online: false }, true, 1000).key, 'offline');
  assert.equal(deviceState({ ...device, timestamp: 900 }, true, 1000).label, '위치 갱신 지연');
  assert.equal(deviceState({ ...device, received_at: 900 }, true, 1000).label, '위치 갱신 지연');
  assert.equal(deviceState({ ...device, floor_id: null }, true, 1000).label, '층 지정 필요');
  assert.equal(deviceState({ ...device, accuracy_m: null }, true, 1000).label, '정확도 미확인');
  assert.equal(deviceState({ ...device, accuracy_m: 100 }, true, 1000).label, 'GPS 정확도 낮음');
  assert.equal(deviceState({ ...device, timestamp: null }, true, 1000).label, 'GPS 수신 대기');
});
test('timestamps never pretend an absent measurement is current', () => {
  assert.equal(timeAgo(null, 1000), '아직 수신하지 않았어요');
  assert.equal(timeAgo(990, 1000), '10초 전');
  assert.equal(timeAgo(800, 1000), '3분 전');
});
