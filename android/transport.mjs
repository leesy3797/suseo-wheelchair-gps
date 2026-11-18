// Connection/session state is shared by foreground and background location tasks.
// React Native 0.74's URL getters are incomplete; validate origins without them.
export function validServerOrigin(value) {
  const match = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::([0-9]{1,5}))?$/i.exec(value);
  return Boolean(match && (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535)));
}
export class LocationTransport {
  constructor(createSocket, notify = () => {}) {
    this.createSocket = createSocket;
    this.notify = notify;
    this.socket = null;
    this.settings = null;
    this.latest = null;
    this.lastTimestamp = 0;
    this.registered = false;
    this.enabled = false;
    this.inFlight = false;
    this.generation = 0;
    this.retryTimer = null;
    this.waiters = new Set();
    this.deliveredTimestamp = 0;
  }
  start(settings) {
    if (this.enabled && JSON.stringify(settings) === JSON.stringify(this.settings)) return;
    this.stop();
    this.enabled = true;
    this.settings = settings;
    this.notify({ connection: 'pending', message: '서버에 연결하고 있어요.', location: null, last_sent: null, device: null });
    const socket = this.createSocket(settings.server_url);
    this.socket = socket;
    socket.on('connect', () => this.register());
    socket.on('disconnect', () => {
      clearTimeout(this.retryTimer);
      this.registered = false; this.inFlight = false; this.generation++;
      this.notify({ connection: 'offline', message: '서버와 다시 연결하고 있어요.' });
    });
    socket.on('connect_error', () => this.notify({ connection: 'offline', message: '서버 연결을 확인해주세요. 자동으로 다시 연결합니다.' }));
    socket.on('location_error', (error) => this.notify({ connection: 'error', message: error.message || '위치 전송을 확인해주세요.' }));
    socket.on('device_updated', (device) => {
      if (device.device_id === this.settings?.device_id) this.notify({ device });
    });
    socket.connect();
  }
  register() {
    if (!this.enabled || !this.socket?.connected) return;
    clearTimeout(this.retryTimer);
    const socket = this.socket, generation = ++this.generation;
    this.registered = false;
    this.notify({ connection: 'pending', message: '단말기를 등록하고 있어요.' });
    socket.timeout(6000).emit('start_tracking', {
      device_id: this.settings.device_id, device_name: this.settings.device_name,
    }, (error, result) => {
      if (generation !== this.generation || !this.enabled || !socket.connected) return;
      if (error || !result?.ok) {
        this.notify({ connection: 'error', message: result?.message || '단말기 등록을 다시 시도하고 있어요.' });
        this.retryTimer = setTimeout(() => this.register(), 8000);
        return;
      }
      this.registered = true;
      this.notify({ connection: 'connected', message: 'GPS 위치를 기다리고 있어요.', device: result.device });
      this.flush();
    });
  }
  offer(location) {
    if (!this.enabled || !Number.isFinite(location?.coords?.latitude) || !Number.isFinite(location?.coords?.longitude)) return;
    const payload = {
      device_id: this.settings.device_id,
      lat: location.coords.latitude, lon: location.coords.longitude,
      timestamp: (location.timestamp || Date.now()) / 1000,
      accuracy_m: Number.isFinite(location.coords.accuracy) && location.coords.accuracy >= 0 ? location.coords.accuracy : null,
    };
    if (payload.timestamp <= this.lastTimestamp) return;
    this.lastTimestamp = payload.timestamp;
    this.latest = payload;
    this.notify({ location });
    this.flush();
  }
  flush() {
    if (!this.enabled || !this.registered || !this.socket?.connected || !this.latest || this.inFlight) return;
    const payload = this.latest, generation = this.generation;
    this.inFlight = true;
    this.socket.timeout(6000).emit('update_location', payload, (error, result) => {
      if (generation !== this.generation || !this.enabled) return;
      this.inFlight = false;
      if (error || !result?.ok) {
        this.notify({ connection: 'error', message: result?.message || '위치 전송을 다시 시도하고 있어요.' });
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.flush(), 5000);
        return;
      }
      if (this.latest === payload) this.latest = null;
      this.deliveredTimestamp = Math.max(this.deliveredTimestamp, payload.timestamp);
      for (const waiter of [...this.waiters]) if (waiter.timestamp <= this.deliveredTimestamp) waiter.finish(true);
      this.notify({ connection: 'connected', message: '위치를 안전하게 전달하고 있어요.', last_sent: result.received_at || Date.now() / 1000 });
      if (this.latest) this.flush();
    });
  }
  waitForDelivery(timeoutMs = 15000) {
    const timestamp = this.lastTimestamp;
    if (!this.enabled || !timestamp) return Promise.resolve(false);
    if (this.deliveredTimestamp >= timestamp) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { timestamp, finish: (delivered) => {
        clearTimeout(timer); this.waiters.delete(waiter); resolve(delivered);
      } };
      const timer = setTimeout(() => waiter.finish(false), timeoutMs);
      this.waiters.add(waiter);
    });
  }
  stop() {
    this.enabled = false; this.registered = false; this.inFlight = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    for (const waiter of [...this.waiters]) waiter.finish(false);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null; this.latest = null; this.lastTimestamp = 0;
    this.deliveredTimestamp = 0;
  }
}
