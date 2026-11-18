import { deviceState } from './device-state.mjs';

const defaultCenter = { lat: 37.48611, lon: 127.10382 };
function icon(maps, name, state) {
  const root = document.createElement('div'); root.className = `naver-terminal-marker ${state.key}`;
  const image = document.createElement('img'); image.src = '/wheelchair-marker.svg?v=2'; image.alt = '';
  const label = document.createElement('span'); label.textContent = state.key === 'normal' ? name : `${name} · ${state.label}`;
  root.append(image, label);
  return { content: root.outerHTML, size: new maps.Size(150, 78), anchor: new maps.Point(75, 34) };
}
export function createNaverTerminalMap(element, messageElement) {
  let maps, map, expandedMap, connected = false, config;
  const devices = new Map(); const compactMarkers = new Map(); const expandedMarkers = new Map();
  const message = (text, shown = true) => { messageElement.textContent = text; messageElement.hidden = !shown; };
  function firstPosition() { const device = [...devices.values()].find((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon)); return device ? { lat: device.lat, lon: device.lon } : (config?.station_transform || defaultCenter); }
  function paintOn(targetMap, targetMarkers, device) { if (!targetMap || !Number.isFinite(device.lat) || !Number.isFinite(device.lon)) return; const state = deviceState(device, connected); const position = new maps.LatLng(device.lat, device.lon); let marker = targetMarkers.get(device.device_id); if (!marker) { marker = new maps.Marker({ map: targetMap, position, title: device.device_name, icon: icon(maps, device.device_name, state) }); targetMarkers.set(device.device_id, marker); } else { marker.setPosition(position); marker.setTitle(device.device_name); marker.setIcon(icon(maps, device.device_name, state)); } }
  function paint(device) { paintOn(map, compactMarkers, device); paintOn(expandedMap, expandedMarkers, device); }
  function load(clientId) { return new Promise((resolve, reject) => { if (window.naver?.maps) return resolve(); const script = document.createElement('script'); script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?${new URLSearchParams({ ncpKeyId: clientId })}`; script.async = true; script.onload = resolve; script.onerror = () => reject(new Error('네이버 지도 스크립트를 불러오지 못했습니다.')); document.head.append(script); }); }
  (async () => { try { const response = await fetch('/api/config', { cache: 'no-store' }); if (!response.ok) throw new Error('서버 설정을 읽지 못했습니다.'); config = await response.json(); if (!config.naver_map_client_id) { message('Naver Maps Client ID가 설정되지 않았습니다.'); return; } window.navermap_authFailure = () => message('네이버 지도 인증에 실패했습니다. Client ID의 웹 서비스 URL을 확인해주세요.'); await load(config.naver_map_client_id); maps = window.naver?.maps; if (!maps) throw new Error('네이버 지도 기능을 준비하지 못했습니다.'); const origin = config.station_transform || defaultCenter; map = new maps.Map(element, { center: new maps.LatLng(origin.lat, origin.lon), zoom: 17, minZoom: 7, zoomControl: true, zoomControlOptions: { position: maps.Position.TOP_RIGHT }, mapDataControl: false }); requestAnimationFrame(() => map?.refresh?.()); message('', false); for (const device of devices.values()) paint(device); } catch (error) { console.error('Naver map initialization failed', error); message(`${error.message} 실외 지도는 사용할 수 없습니다.`); } })();
  return {
    update(device) { devices.set(device.device_id, { ...device }); paint(device); },
    remove(id) { devices.delete(id); for (const [markerSet] of [[compactMarkers], [expandedMarkers]]) { const marker = markerSet.get(id); marker?.setMap(null); markerSet.delete(id); } },
    setConnected(value) { connected = value; for (const device of devices.values()) paint(device); },
    focus(device) { if (!map || !Number.isFinite(device.lat) || !Number.isFinite(device.lon)) return false; const position = new maps.LatLng(device.lat, device.lon); map.panTo(position); expandedMap?.panTo(position); return true; },
    recenter() { if (!map) return; const center = firstPosition(); const position = new maps.LatLng(center.lat, center.lon); map.panTo(position); expandedMap?.panTo(position); map.refresh?.(); expandedMap?.refresh?.(); },
    openExpanded(expandedElement) { if (!maps) return false; const center = firstPosition(); if (!expandedMap) expandedMap = new maps.Map(expandedElement, { center: new maps.LatLng(center.lat, center.lon), zoom: 17, minZoom: 7, zoomControl: true, zoomControlOptions: { position: maps.Position.TOP_RIGHT }, mapDataControl: false }); else expandedMap.setCenter(new maps.LatLng(center.lat, center.lon)); for (const device of devices.values()) paintOn(expandedMap, expandedMarkers, device); requestAnimationFrame(() => expandedMap?.refresh?.()); return true; },
  };
}
