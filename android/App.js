import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { LOCATION_TASK, SERVER_URL, loadSettings, saveSettings, subscribe, transport } from './terminal';

const FLOORS = { 'station-1f.glb': '1층', 'station-b1.glb': '지하 1층', 'station-b2-concourse.glb': '지하 2층 대합실', 'station-b2-platform.glb': '지하 2층 승강장' };
const MAP_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>*{box-sizing:border-box}html,body,#map{width:100%;height:100%;margin:0}body{font-family:Arial,sans-serif;background:#f5f6f8}.message{position:absolute;z-index:2;top:10px;left:10px;right:10px;padding:9px 12px;border:1px solid #e5e8eb;border-radius:9px;background:#ffffffed;color:#6b7684;font-size:12px;line-height:1.5}.message:empty{display:none}</style></head><body><div id="map"></div><div id="message" class="message">네이버 지도를 준비하고 있어요.</div><script>
const message = (text) => { document.getElementById('message').textContent = text; window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'map-message', text })); };
let map, marker, maps;
function showLocation(data) {
  if (!map || !Number.isFinite(data.lat) || !Number.isFinite(data.lon)) return;
  const position = new maps.LatLng(data.lat, data.lon);
  if (!marker) marker = new maps.Marker({ map, position, title: data.name || '휠체어', icon: { content: '<div style="font-size:30px;line-height:32px">♿</div>', anchor: new maps.Point(16, 16) } });
  else { marker.setPosition(position); marker.setTitle(data.name || '휠체어'); }
  map.panTo(position);
  document.getElementById('message').textContent = '';
}
function receiveLocation(event) { try { const data = JSON.parse(event.data); if (data.type === 'location') showLocation(data); } catch (error) { message('현재 위치를 지도에 표시하지 못했어요.'); } }
window.addEventListener('message', receiveLocation);
document.addEventListener('message', receiveLocation);
async function init() {
  try {
    const response = await fetch('${SERVER_URL}/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('지도 설정을 불러오지 못했어요.');
    const config = await response.json();
    if (!config.naver_map_client_id) return message('네이버 지도 Client ID가 설정되지 않았어요.');
    window.navermap_authFailure = () => message('네이버 지도 인증에 실패했어요. 도메인 설정을 확인해주세요.');
    const script = document.createElement('script');
    script.src = 'https://oapi.map.naver.com/openapi/v3/maps.js?' + new URLSearchParams({ ncpKeyId: config.naver_map_client_id });
    script.onerror = () => message('네이버 지도를 불러오지 못했어요.');
    script.onload = () => {
      maps = window.naver.maps;
      const origin = config.station_transform || { lat: 37.485, lon: 127.103 };
      map = new maps.Map(document.getElementById('map'), { center: new maps.LatLng(origin.lat, origin.lon), zoom: 16, zoomControl: true });
      message('위치 전송을 시작하면 현재 위치가 표시됩니다.');
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'map-ready' }));
    };
    document.head.appendChild(script);
  } catch (error) { message(error.message || '네이버 지도를 준비하지 못했어요.'); }
}
init();
</script></body></html>`;
function Button({ title, onPress, secondary = false, disabled = false }) {
  return <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, secondary && styles.secondary, disabled && { opacity: .5 }]}><Text style={[styles.buttonText, secondary && { color: '#4e5968' }]}>{title}</Text></TouchableOpacity>;
}
export default function App() {
  const [settings, setSettings] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [status, setStatus] = useState({});
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [mapMessage, setMapMessage] = useState('네이버 지도를 준비하고 있어요.');
  const [background, setBackground] = useState(false);
  const [now, setNow] = useState(Date.now());
  const watcher = useRef(null);
  const mapRef = useRef(null);
  const mapLoaded = useRef(false);
  const latestLocation = useRef(null);
  const busyRef = useRef(false);
  const settingsRef = useRef(null);
  const mounted = useRef(true);

  async function start(current) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage('');
    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== 'granted') throw new Error('위치 권한을 허용해주세요. 설정에서 정밀 위치도 켜주세요.');
      const bg = await Location.requestBackgroundPermissionsAsync();
      const active = { ...current, enabled: true };
      await saveSettings(active); settingsRef.current = active; setSettings(active);
      transport.start(active);
      watcher.current?.remove(); watcher.current = null;
      const existingTask = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
      if (bg.status === 'granted') {
        try {
          if (!existingTask) await Location.startLocationUpdatesAsync(LOCATION_TASK, {
            accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 0,
            foregroundService: { notificationTitle: '휠체어 단말기 위치 전송 중', notificationBody: '수서역 관리자에게 위치를 전달하고 있어요.', notificationColor: '#3182f6', killServiceOnDestroy: false },
            pausesUpdatesAutomatically: false,
          });
          setBackground(true);
        } catch (backgroundError) {
          // Expo Go has its own Android manifest and cannot include this app's
          // foreground-service permission. Keep preview usable in the foreground.
          setBackground(false);
          watcher.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 0 }, (location) => transport.offer(location));
          setMessage('현재 앱 화면이 열려 있는 동안 위치를 전송합니다. 백그라운드 전송은 설치형 APK에서 사용할 수 있어요.');
        }
      } else {
        if (existingTask) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
        setBackground(false);
        watcher.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 0 }, (location) => transport.offer(location));
        setMessage('백그라운드 권한이 없어 앱을 보고 있을 때만 위치를 전송합니다.');
      }
      setTracking(true);
      // Do not block startup while waiting for the first GPS fix indoors.
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).then((location) => {
        if (transport.enabled) transport.offer(location);
      }).catch(() => { if (mounted.current) setMessage('GPS를 기다리고 있어요. 위치 서비스와 주변 수신 환경을 확인해주세요.'); });
    } catch (error) {
      transport.stop(); watcher.current?.remove(); watcher.current = null;
      const stopped = { ...current, enabled: false };
      await saveSettings(stopped).then(() => { settingsRef.current = stopped; setSettings(stopped); }).catch(() => {});
      await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).then((running) => running && Location.stopLocationUpdatesAsync(LOCATION_TASK)).catch(() => {});
      setTracking(false); setBackground(false); setMessage(error.message);
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function stop() {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true);
    try {
      // Persist the stop before disconnecting so background callbacks cannot restart it.
      const stopped = { ...settingsRef.current, enabled: false };
      await saveSettings(stopped); settingsRef.current = stopped; setSettings(stopped);
      transport.stop(); watcher.current?.remove(); watcher.current = null;
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      setTracking(false); setBackground(false); setMessage('위치 전송을 일시 중지했어요.');
      return true;
    } catch (error) { setMessage(`중지 상태를 확인해주세요: ${error.message}`); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribe((value) => { if (mounted.current) setStatus(value); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    loadSettings().then(async (value) => {
      if (!mounted.current) return;
      settingsRef.current = value; setSettings(value); setNameDraft(value.device_name);
      if (value.configured) await start(value); // Each manual app launch resumes location sharing.
    }).catch((error) => setMessage(`설정을 읽지 못했어요: ${error.message}`));
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && settingsRef.current?.enabled && transport.enabled) {
        if (!transport.socket?.connected) transport.socket?.connect();
        Location.getLastKnownPositionAsync().then((location) => { if (location) transport.offer(location); }).catch(() => {});
      }
    });
    return () => { mounted.current = false; unsubscribe(); clearInterval(timer); subscription.remove(); };
  }, []);
  async function saveName() {
    const deviceName = nameDraft.trim();
    if (!deviceName) { setMessage('휠체어 이름을 입력해주세요.'); return; }
    try {
      const next = { ...settingsRef.current, device_name: deviceName, configured: true };
      await saveSettings(next);
      settingsRef.current = next; setSettings(next); setNameDraft(deviceName); setMessage('휠체어 이름을 저장했어요.');
      if (tracking) transport.start(next);
    } catch (error) { setMessage(`휠체어 이름을 저장하지 못했어요: ${error.message}`); }
  }
  function updateMapLocation(location, name = settingsRef.current?.device_name) {
    const coords = location?.coords;
    if (!mapLoaded.current || !Number.isFinite(coords?.latitude) || !Number.isFinite(coords?.longitude)) return;
    const payload = JSON.stringify({ type: 'location', lat: coords.latitude, lon: coords.longitude, name }).replace(/</g, '\\u003c');
    mapRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(payload)}}));true;`);
  }
  useEffect(() => {
    latestLocation.current = status.location;
    updateMapLocation(status.location);
  }, [status.location, settings?.device_name]);
  const age = status.location ? Math.max(0, Math.floor((now - status.location.timestamp) / 1000)) : null;
  const receiving = tracking && status.connection === 'connected' && age !== null && age <= 30 && status.last_sent && now / 1000 - status.last_sent <= 30;
  const isCurrentDevice = Boolean(status.device && settings && status.device.device_id === settings.device_id);
  const floor = isCurrentDevice ? FLOORS[status.device.floor_id] : null;
  const accuracy = status.location?.coords?.accuracy;
  return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" backgroundColor="#f5f6f8" /><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <View style={styles.header}><View style={styles.brandIcon}><Text style={{ color: '#fff', fontSize: 28 }}>♿</Text></View><Text style={styles.brand}>수서역 휠체어 단말기</Text></View>
    <Text style={styles.eyebrow}>WHEELCHAIR TERMINAL</Text>
    <Text style={styles.title}>{receiving ? '위치를 전달하고 있어요' : tracking ? '위치를 확인하고 있어요' : '휠체어와 함께, 안심 이동'}</Text>
    <Text style={styles.subtitle}>휠체어 이름을 설정하고 현재 위치를 확인하세요.</Text>
    <View style={styles.card}>
      <Text style={styles.label}>휠체어 이름</Text>
      <TextInput accessibilityLabel="휠체어 이름" style={styles.input} value={nameDraft} onChangeText={setNameDraft} placeholder="예: 수서 휠체어 01" placeholderTextColor="#b0b8c1" autoCorrect={false} maxLength={100} returnKeyType="done" onSubmitEditing={saveName} />
      <Button title="휠체어 이름 저장" onPress={saveName} disabled={busy} />
    </View>
    <View style={styles.mapCard}>
      <Text style={styles.sectionTitle}>이 기기의 실시간 위치</Text>
      <View style={styles.mapFrame}>
        <WebView
          ref={mapRef}
          source={{ html: MAP_HTML, baseUrl: SERVER_URL }}
          originWhitelist={[SERVER_URL, 'about:blank']}
          javaScriptEnabled
          domStorageEnabled
          onLoadEnd={() => { mapLoaded.current = true; updateMapLocation(latestLocation.current); }}
          onError={() => setMapMessage('지도를 불러오지 못했어요. 네트워크를 확인해주세요.')}
          onHttpError={(event) => setMapMessage(`지도 서버 응답 오류 (${event.nativeEvent.statusCode})`)}
          onMessage={(event) => {
            try {
              const data = JSON.parse(event.nativeEvent.data);
              if (data.type === 'map-message') setMapMessage(data.text);
              if (data.type === 'map-ready') { mapLoaded.current = true; updateMapLocation(latestLocation.current); }
            } catch (error) { setMapMessage(`지도 응답을 읽지 못했어요: ${error.message}`); }
          }}
          style={styles.map}
        />
        {!!mapMessage && <View pointerEvents="none" style={styles.mapOverlay}><Text style={styles.mapOverlayText}>{mapMessage}</Text></View>}
      </View>
    </View>
    <View style={styles.statusCard}>
      <View style={styles.statusHeader}><View style={[styles.dot, !receiving && { backgroundColor: tracking && status.connection === 'error' ? '#e05b62' : '#b0b8c1' }]} /><Text style={styles.statusTitle}>{receiving ? '위치 전송 중' : tracking ? status.connection === 'error' ? '연결 확인 필요' : '연결 · GPS 확인 중' : '전송 일시 중지'}</Text></View>
      <Text style={styles.heroMessage}>{tracking ? status.message : settings?.configured ? '앱을 실행하면 위치 전송을 시작해요.' : '휠체어 이름을 저장한 뒤 위치 전송을 시작하세요.'}</Text>
      <View style={styles.infoRow}><Text style={styles.infoLabel}>현재 층</Text><Text style={styles.infoValue}>{floor || '관리자 지정 대기'}</Text></View>
      <View style={styles.divider} />
      <View style={styles.infoRow}><Text style={styles.infoLabel}>위도 · 경도</Text><Text style={styles.infoValue}>{status.location ? `${status.location.coords.latitude.toFixed(6)}, ${status.location.coords.longitude.toFixed(6)}` : '측정 대기'}</Text></View>
      <View style={styles.divider} />
      <View style={styles.infoRow}><Text style={styles.infoLabel}>GPS 정확도</Text><Text style={[styles.infoValue, accuracy > 30 && { color: '#b66a09' }]}>{Number.isFinite(accuracy) && accuracy >= 0 ? `약 ${Math.round(accuracy)}m` : '측정 대기'}</Text></View>
      <View style={styles.divider} />
      <View style={styles.infoRow}><Text style={styles.infoLabel}>최근 위치 측정</Text><Text style={styles.infoValue}>{age === null ? '수신 대기' : `${age}초 전`}</Text></View>
      <View style={styles.divider} />
      <View style={styles.infoRow}><Text style={styles.infoLabel}>백그라운드 전송</Text><Text style={styles.infoValue}>{background && tracking ? '사용 중' : '사용 안 함'}</Text></View>
    </View>
    {!!message && <Text accessibilityRole="alert" style={styles.notice}>{message}</Text>}
    {busy ? <ActivityIndicator color="#3182f6" style={{ margin: 24 }} /> : settings && <Button title={tracking ? '위치 전송 일시 중지' : '위치 전송 시작'} secondary={tracking} disabled={!settings.configured} onPress={() => tracking ? stop() : start(settingsRef.current)} />}
    {!settings?.configured && <Text style={styles.note}>먼저 휠체어 이름을 저장해주세요.</Text>}
    <Text style={styles.note}>층은 자동으로 판별되지 않아요. 층이 바뀌면 관리자에게 알려주세요.</Text>
    <Text style={styles.footer}>SUSEO STATION · ACCESSIBILITY</Text>
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f6f8' }, container: { padding: 22, paddingTop: 18, paddingBottom: 32, width: '100%', maxWidth: 620, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 28 }, brandIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: '#3182f6', alignItems: 'center', justifyContent: 'center' }, brand: { flex: 1, fontSize: 15, fontWeight: '700', color: '#333d4b' },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: '#8b95a1', fontWeight: '700', marginBottom: 8 }, title: { fontSize: 26, color: '#191f28', fontWeight: '800', letterSpacing: -.6, lineHeight: 36 }, subtitle: { fontSize: 14, color: '#6b7684', lineHeight: 22, marginTop: 8, marginBottom: 16 },
  card: { padding: 18, backgroundColor: '#fff', borderRadius: 20, marginBottom: 14 }, label: { fontSize: 12, color: '#6b7684', marginBottom: 8 }, input: { backgroundColor: '#f5f6f8', borderWidth: 1, borderColor: '#e5e8eb', borderRadius: 12, padding: 13, fontSize: 15, color: '#333d4b', minHeight: 48 },
  button: { backgroundColor: '#3182f6', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 10 }, secondary: { backgroundColor: '#e9edf2' }, buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' }, note: { color: '#8b95a1', fontSize: 12, lineHeight: 20, marginTop: 12 }, notice: { backgroundColor: '#fff4e5', color: '#9c6216', fontSize: 12, lineHeight: 21, padding: 16, borderRadius: 12, marginVertical: 10 },
  mapCard: { padding: 16, backgroundColor: '#fff', borderRadius: 20, marginBottom: 14 }, sectionTitle: { fontSize: 14, color: '#333d4b', fontWeight: '700', marginBottom: 12 }, mapFrame: { height: 300, overflow: 'hidden', borderRadius: 14, backgroundColor: '#e9edf0' }, map: { flex: 1, backgroundColor: 'transparent' }, mapOverlay: { position: 'absolute', top: 10, left: 10, right: 10, padding: 9, borderRadius: 9, backgroundColor: '#ffffffed' }, mapOverlayText: { color: '#6b7684', fontSize: 12, lineHeight: 17 },
  statusCard: { padding: 18, backgroundColor: '#fff', borderRadius: 20, marginBottom: 14 }, statusHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 }, statusTitle: { color: '#333d4b', fontSize: 14, fontWeight: '700' }, dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#3182f6' }, heroMessage: { marginTop: 9, marginBottom: 10, fontSize: 12, color: '#8b95a1', lineHeight: 19 }, infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 10 }, infoLabel: { fontSize: 12, color: '#8b95a1' }, infoValue: { fontSize: 12, color: '#333d4b', fontWeight: '600', flexShrink: 1, textAlign: 'right' }, divider: { height: 1, backgroundColor: '#f2f4f6' },
  footer: { textAlign: 'center', color: '#b0b8c1', fontSize: 9, letterSpacing: 1.6, marginTop: 26 },
});
