export function deviceState(device, connected = true, now = Date.now() / 1000) {
  if (!connected) return { key: 'offline', label: '서버 연결 끊김' };
  if (!device.online) return { key: 'offline', label: '연결 끊김' };
  if (!Number.isFinite(device.timestamp)) return { key: 'warning', label: 'GPS 수신 대기' };
  if (now - device.timestamp > 30 || now - (device.received_at || 0) > 30) return { key: 'warning', label: '위치 갱신 지연' };
  if (device.accuracy_m == null) return { key: 'warning', label: '정확도 미확인' };
  if (device.accuracy_m > 30) return { key: 'warning', label: 'GPS 정확도 낮음' };
  if (!device.floor_id) return { key: 'warning', label: '층 지정 필요' };
  return { key: 'normal', label: '위치 수신 정상' };
}
export function timeAgo(timestamp, now = Date.now() / 1000) {
  if (!Number.isFinite(timestamp)) return '아직 수신하지 않았어요';
  const seconds = Math.max(0, Math.floor(now - timestamp));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}
export const floorNames = {
  'station-1f.glb': '1층', 'station-b1.glb': '지하 1층',
  'station-b2-concourse.glb': '지하 2층 대합실', 'station-b2-platform.glb': '지하 2층 승강장',
};
