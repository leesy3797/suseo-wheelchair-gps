import { deviceState, timeAgo } from './device-state.mjs';
const mapElement = document.querySelector("#naver-map");
const messageElement = document.querySelector("#map-message");
const connectionElement = document.querySelector("#map-connection");
const deviceList = document.querySelector("#map-device-list");
const emptyState = document.querySelector("#map-empty");
const deviceCount = document.querySelector("#device-count");
const devices = new Map();
const defaultCenter = { lat: 37.48611, lng: 127.10382 };
let map = null;
let mapSocket = null;
let hasCenteredOnDevice = false;
let mapScriptLoaded = false;
let mapAuthFailed = false;
let mapNamespaceCheckTimeout = null;
let mapScriptLoadTimeout = null;
let mapInitialized = false;

function createWheelchairMarkerIcon(label) {
  const maps = window.naver.maps;
  const content = document.createElement("div");
  content.style.cssText = "display:flex;flex-direction:column;align-items:center;width:190px;min-height:56px;font-family:Arial,sans-serif;pointer-events:none";
  const image = document.createElement("img");
  image.src = "/wheelchair-marker.svg?v=2";
  image.alt = "";
  image.width = 48;
  image.height = 48;
  const caption = document.createElement("span");
  caption.textContent = label;
  caption.style.cssText = "display:block;max-width:184px;margin-top:2px;padding:2px 6px;border:1px solid #1769aa;border-radius:4px;background:#fff;color:#102030;font-size:12px;font-weight:700;line-height:16px;text-align:center;white-space:normal;overflow-wrap:anywhere;box-shadow:0 1px 4px #0005";
  content.append(image, caption);
  return {
    content: content.outerHTML,
    size: new maps.Size(190, 140),
    scaledSize: new maps.Size(190, 140),
    anchor: new maps.Point(95, 48),
  };
}

function setMapMessage(message, visible = true) {
  messageElement.textContent = message;
  messageElement.hidden = !visible;
}

function reportMapError(stage, message, error = null) {
  if (mapNamespaceCheckTimeout !== null) {
    window.clearTimeout(mapNamespaceCheckTimeout);
    mapNamespaceCheckTimeout = null;
  }
  if (mapScriptLoadTimeout !== null) {
    window.clearTimeout(mapScriptLoadTimeout);
    mapScriptLoadTimeout = null;
  }
  const details = {
    stage,
    pageOrigin: window.location.origin,
    scriptLoaded: mapScriptLoaded,
    naverAvailable: Boolean(window.naver),
    mapsAvailable: Boolean(window.naver?.maps),
    mapWidth: mapElement.clientWidth,
    mapHeight: mapElement.clientHeight,
  };
  console.error("Naver Maps initialization failed", details, error || "");
  setMapMessage(message);
}

function handleLocation(payload) {
  if (
    !payload ||
    typeof payload.device_id !== "string" ||
    !Number.isFinite(payload.lat) ||
    !Number.isFinite(payload.lon) ||
    payload.lat < -90 ||
    payload.lat > 90 ||
    payload.lon < -180 ||
    payload.lon > 180 ||
    !Number.isFinite(payload.timestamp)
  ) {
    console.warn("Ignoring malformed location event", payload);
    return;
  }

  const maps = window.naver.maps;
  const position = new maps.LatLng(payload.lat, payload.lon);
  let device = devices.get(payload.device_id);
  if (!device) {
    const marker = new maps.Marker({
      map,
      position,
      title: payload.device_id,
      icon: createWheelchairMarkerIcon(payload.device_name || payload.device_id),
    });
    device = {
      marker,
      name: payload.device_name || payload.device_id,
      lat: payload.lat,
      lon: payload.lon,
      displayLat: payload.lat,
      displayLon: payload.lon,
      animationFrame: null,
    };
    devices.set(payload.device_id, device);
    if (!hasCenteredOnDevice) {
      map.panTo(position);
      hasCenteredOnDevice = true;
    }
  } else {
    const deviceName = payload.device_name || payload.device_id;
    if (device.name !== deviceName) {
      device.name = deviceName;
      device.marker.setIcon(createWheelchairMarkerIcon(deviceName));
    }
    animateDeviceMarker(device, payload.lat, payload.lon);
  }
  device.lat = payload.lat;
  device.lon = payload.lon;
  device.timestamp = payload.timestamp;
  device.online = payload.online;
  device.received_at = payload.received_at;
  device.accuracy_m = payload.accuracy_m;
  device.floor_id = payload.floor_id;
  renderDevices();
}

function animateDeviceMarker(device, lat, lon) {
  if (device.animationFrame !== null) {
    window.cancelAnimationFrame(device.animationFrame);
  }
  const startLat = device.displayLat;
  const startLon = device.displayLon;
  let startedAt = null;

  const animate = (now) => {
    if (startedAt === null) startedAt = now;
    const progress = Math.min((now - startedAt) / 750, 1);
    device.displayLat = startLat + (lat - startLat) * progress;
    device.displayLon = startLon + (lon - startLon) * progress;
    device.marker.setPosition(new window.naver.maps.LatLng(device.displayLat, device.displayLon));
    if (progress < 1) {
      device.animationFrame = window.requestAnimationFrame(animate);
    } else {
      device.animationFrame = null;
    }
  };
  device.animationFrame = window.requestAnimationFrame(animate);
}

function renderDevices() {
  deviceList.replaceChildren();
  emptyState.hidden = devices.size > 0;
  deviceCount.textContent = String(devices.size);
  for (const [deviceId, device] of devices) {
    const item = document.createElement("li");
    item.className = "device-row";
    const name = document.createElement("strong");
    name.textContent = device.name;
    const coords = document.createElement("span");
    coords.textContent = `${device.lat.toFixed(6)}, ${device.lon.toFixed(6)}`;
    const received = document.createElement("span");
    const state = deviceState(device, Boolean(mapSocket?.connected));
    received.textContent = `${state.label} · 측정 ${timeAgo(device.timestamp)}`;
    device.marker.setOpacity(state.key === 'offline' ? .4 : 1);
    device.marker.setIcon(createWheelchairMarkerIcon(`${device.name}${state.key === 'normal' ? '' : ` · ${state.label}`}`));
    item.append(name, coords, received);
    deviceList.append(item);
  }
}

function removeDevice(payload) {
  const device = devices.get(payload?.device_id);
  if (device) { device.online = false; renderDevices(); }
}

function connectSocket() {
  const socket = window.io({ transports: ["websocket", "polling"] });
  mapSocket = socket;
  socket.on("connect", () => {
    connectionElement.className = "connection connected";
    connectionElement.lastChild.textContent = "서버 연결됨";
  });
  socket.on("disconnect", () => {
    renderDevices();
    connectionElement.className = "connection disconnected";
    connectionElement.lastChild.textContent = "서버 연결 끊김";
  });
  socket.on("connect_error", (error) => {
    console.error("Naver map Socket.IO connection failed", error);
    connectionElement.className = "connection disconnected";
    connectionElement.lastChild.textContent = "연결 오류";
  });
  socket.on("broadcast_location", handleLocation);
  socket.on("devices_snapshot", (snapshot) => {
    const ids = new Set(snapshot.map((d) => d.device_id));
    for (const [id, device] of devices) if (!ids.has(id)) {
      if (device.animationFrame !== null) cancelAnimationFrame(device.animationFrame);
      device.marker.setMap(null); devices.delete(id);
    }
    snapshot.filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lon)).forEach(handleLocation); renderDevices();
  });
  socket.on("device_disconnected", removeDevice);
  socket.on("location_error", (error) => console.error("Location rejected by server", error));
}

function initializeMap() {
  const maps = window.naver?.maps;
  if (!maps) {
    reportMapError(
      "maps-not-ready",
      "Naver 지도 기능이 준비되지 않았습니다. 잠시 후 다시 시도하거나 Console의 'Naver Maps initialization failed' 항목을 확인하세요.",
    );
    return;
  }

  if (mapInitialized) return;

  try {
    if (mapElement.clientWidth === 0 || mapElement.clientHeight === 0) {
      reportMapError(
        "map-container-size",
        "지도 영역의 크기를 확인할 수 없습니다. 페이지를 새로고침한 뒤에도 계속되면 Console 오류를 확인하세요.",
      );
      return;
    }

    map = new maps.Map(mapElement, {
      center: new maps.LatLng(defaultCenter.lat, defaultCenter.lng),
      zoom: 16,
      minZoom: 7,
      zoomControl: true,
      zoomControlOptions: { position: maps.Position.TOP_RIGHT },
      mapDataControl: false,
    });
    mapInitialized = true;
    if (mapNamespaceCheckTimeout !== null) {
      window.clearTimeout(mapNamespaceCheckTimeout);
      mapNamespaceCheckTimeout = null;
    }
    setMapMessage("", false);
    connectSocket();
  } catch (error) {
    reportMapError(
      "map-construction",
      `Naver 지도 객체를 만들지 못했습니다: ${error.message || error}. Console에서 자세한 오류를 확인하세요.`,
      error,
    );
  }
}

function waitForNaverMaps(deadline = Date.now() + 5000) {
  if (mapAuthFailed || mapInitialized) return;
  if (window.naver?.maps) {
    initializeMap();
    return;
  }

  if (Date.now() >= deadline) {
    reportMapError(
      "maps-namespace-timeout",
      "Naver 지도 스크립트는 내려받았지만 지도 기능이 준비되지 않았습니다. 인증 오류와 Network 탭의 maps.js 응답을 확인하세요.",
    );
    return;
  }
  mapNamespaceCheckTimeout = window.setTimeout(() => waitForNaverMaps(deadline), 100);
}

window.navermap_authFailure = () => {
  mapAuthFailed = true;
  reportMapError(
    "authentication",
    "Naver 지도 인증에 실패했습니다. Console의 Naver 오류 코드와 메시지를 확인하세요. Client ID, Dynamic Map 이용 설정, Web 서비스 URL을 점검해야 합니다.",
  );
};

async function loadNaverMap() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`서버 설정 요청 실패: HTTP ${response.status}`);
    const config = await response.json();
    if (!config.naver_map_client_id) {
      setMapMessage("Naver 지도 Client ID가 설정되지 않았습니다. 서버 실행 전 NAVER_MAP_CLIENT_ID 환경 변수를 설정하세요.");
      return;
    }

    const script = document.createElement("script");
    const params = new URLSearchParams({
      ncpKeyId: config.naver_map_client_id,
    });
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?${params}`;
    script.async = true;
    script.onload = () => {
      if (mapScriptLoadTimeout !== null) {
        window.clearTimeout(mapScriptLoadTimeout);
        mapScriptLoadTimeout = null;
      }
      mapScriptLoaded = true;
      if (mapAuthFailed) return;
      waitForNaverMaps();
    };
    script.onerror = () => {
      if (mapScriptLoadTimeout !== null) {
        window.clearTimeout(mapScriptLoadTimeout);
        mapScriptLoadTimeout = null;
      }
      reportMapError(
        "script-load",
        "Naver 지도 스크립트를 불러오지 못했습니다. Network 탭에서 maps.js 요청 상태를 확인하세요.",
      );
    };
    mapScriptLoadTimeout = window.setTimeout(() => {
      mapScriptLoadTimeout = null;
      reportMapError(
        "script-load-timeout",
        "Naver 지도 스크립트 응답을 기다리는 시간이 초과되었습니다. 인터넷 연결과 Network 탭의 maps.js 요청을 확인하세요.",
      );
    }, 15000);
    document.head.append(script);
  } catch (error) {
    reportMapError(
      "configuration",
      `Naver 지도 설정을 읽지 못했습니다: ${error.message}. /api/config 응답과 Console을 확인하세요.`,
      error,
    );
  }
}

document.querySelector("#recenter-map").addEventListener("click", () => {
  if (!map) return;
  const firstDevice = devices.values().next().value;
  if (firstDevice) {
    map.panTo(new window.naver.maps.LatLng(firstDevice.lat, firstDevice.lon));
    return;
  }
  map.panTo(new window.naver.maps.LatLng(defaultCenter.lat, defaultCenter.lng));
});

setInterval(() => { if (map) renderDevices(); }, 1000);
loadNaverMap();
