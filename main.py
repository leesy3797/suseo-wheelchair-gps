import json
import math
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import socketio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

ROOT = Path(__file__).resolve().parent
ANCHOR_LAT = float(os.getenv('ANCHOR_LAT', '37.485000'))
ANCHOR_LON = float(os.getenv('ANCHOR_LON', '127.103000'))
MODEL_SCALE = float(os.getenv('MODEL_SCALE', '1'))
NAVER_MAP_CLIENT_ID = os.getenv('NAVER_MAP_CLIENT_ID', '').strip()


def env_csv(name: str, default: str) -> str | list[str]:
    """Return a Socket.IO-compatible origin setting from a comma-separated env var."""
    value = os.getenv(name, default).strip()
    if value == '*':
        return '*'
    return [item.strip() for item in value.split(',') if item.strip()]


SOCKET_CORS_ALLOWED_ORIGINS = env_csv('SOCKET_CORS_ALLOWED_ORIGINS', '*')
TRUSTED_HOSTS = env_csv('TRUSTED_HOSTS', '*')
STATION_TRANSFORM = {
    'lat': float(os.getenv('STATION_ORIGIN_LAT', str(ANCHOR_LAT))),
    'lon': float(os.getenv('STATION_ORIGIN_LON', str(ANCHOR_LON))),
    'x': float(os.getenv('STATION_ORIGIN_X', '0')),
    'z': float(os.getenv('STATION_ORIGIN_Z', '0')),
    'rotation_deg': float(os.getenv('STATION_ROTATION_DEG', '0')),
    'meters_to_model': float(os.getenv('STATION_METERS_TO_MODEL', '1')),
}
FLOORS = {
    'station-1f.glb': '1층', 'station-b1.glb': '지하 1층',
    'station-b2-concourse.glb': '지하 2층 대합실', 'station-b2-platform.glb': '지하 2층 승강장',
}

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False, str_strip_whitespace=True)

class LocationUpdate(StrictModel):
    device_id: str = Field(min_length=1, max_length=100)
    device_name: str | None = Field(default=None, min_length=1, max_length=100)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    timestamp: float = Field(default_factory=time.time, gt=0)
    accuracy_m: float | None = Field(default=None, ge=0)

class TrackingSession(StrictModel):
    device_id: str = Field(min_length=1, max_length=100)
    device_name: str = Field(min_length=1, max_length=100)

class DeviceSettings(StrictModel):
    device_id: str = Field(min_length=1, max_length=100)
    device_name: str = Field(min_length=1, max_length=100)
    floor_id: str | None = None

class Calibration(StrictModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    x: float
    z: float
    rotation_deg: float = Field(default=0, ge=-180, le=180)
    meters_to_model: float = Field(default=1, gt=0, le=1000)

class StateStore:
    """Retains only latest records and shared calibration, never movement history."""
    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.db.commit()

    def get(self, key: str, default: Any = None) -> Any:
        row = self.db.execute('SELECT value FROM state WHERE key = ?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, key: str, value: Any) -> None:
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO state VALUES (?, ?)', (key, json.dumps(value, allow_nan=False)))

store = StateStore(os.getenv('SUSEO_DB_PATH', str(ROOT / 'monitoring.sqlite3')))
devices: dict[str, dict[str, Any]] = store.get('devices', {})
# A saved transform remains usable during the migration. New deployments should set
# the STATION_* environment variables and do not expose calibration in the UI.
calibration: dict[str, Any] | None = store.get('calibration') or STATION_TRANSFORM
active_devices: dict[str, dict[str, str]] = {}
latest_locations = {key: value for key, value in devices.items() if value.get('lat') is not None}

def map_coordinates(lat: float, lon: float) -> tuple[float, float]:
    origin = calibration or {'lat': ANCHOR_LAT, 'lon': ANCHOR_LON, 'x': 0, 'z': 0}
    east = (lon - origin['lon']) * 111_320 * math.cos(math.radians(origin['lat']))
    north = (lat - origin['lat']) * 111_320
    angle = math.radians(origin.get('rotation_deg', 0))
    scale = origin.get('meters_to_model', 1)
    return (
        origin['x'] + scale * (east * math.cos(angle) - north * math.sin(angle)),
        origin['z'] + scale * (east * math.sin(angle) + north * math.cos(angle)),
    )

def create_broadcast_payload(location: LocationUpdate) -> dict[str, Any]:
    x, z = map_coordinates(location.lat, location.lon)
    return {**location.model_dump(), 'device_name': location.device_name or location.device_id, 'x': x, 'z': z}

def device_payload(device_id: str) -> dict[str, Any]:
    result = dict(devices[device_id])
    result['online'] = bool(active_devices.get(device_id))
    if result.get('lat') is not None:
        result['x'], result['z'] = map_coordinates(result['lat'], result['lon'])
    return result

def persist() -> None:
    store.put('devices', devices)

fastapi_app = FastAPI(title='수서역 휠체어 관제 API')
if TRUSTED_HOSTS != '*':
    fastapi_app.add_middleware(TrustedHostMiddleware, allowed_hosts=TRUSTED_HOSTS)
sio = socketio.AsyncServer(
    async_mode='asgi', cors_allowed_origins=SOCKET_CORS_ALLOWED_ORIGINS,
    logger=False, engineio_logger=False,
)

async def publish_device(device_id: str) -> None:
    payload = device_payload(device_id)
    await sio.emit('device_updated', payload)
    if payload.get('lat') is not None:
        await sio.emit('broadcast_location', payload)

async def remove_tracking_session(device_id: str, sid: str) -> bool:
    sessions = active_devices.get(device_id)
    if not sessions or sid not in sessions:
        return False
    sessions.pop(sid)
    if not sessions:
        active_devices.pop(device_id, None)
        await sio.emit('device_disconnected', {'device_id': device_id})
    await publish_device(device_id)
    return True


async def remove_device(device_id: str) -> bool:
    if device_id not in devices or active_devices.get(device_id):
        return False
    devices.pop(device_id, None)
    latest_locations.pop(device_id, None)
    persist()
    await sio.emit('device_removed', {'device_id': device_id})
    return True

@fastapi_app.get('/api/health')
async def health() -> dict[str, str]:
    return {'status': 'ok'}

@fastapi_app.get('/api/config')
async def config(response: Response) -> dict[str, Any]:
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    return {
        'anchor_lat': ANCHOR_LAT, 'anchor_lon': ANCHOR_LON,
        'model_scale': MODEL_SCALE, 'naver_map_client_id': NAVER_MAP_CLIENT_ID,
        'station_transform': calibration,
        'station_transform_configured': calibration != STATION_TRANSFORM or any(
            key in os.environ for key in ('STATION_ORIGIN_LAT', 'STATION_ORIGIN_LON', 'STATION_ORIGIN_X', 'STATION_ORIGIN_Z')
        ),
        'floors': FLOORS,
        'stale_after_seconds': 30, 'poor_accuracy_m': 30,
    }

@fastapi_app.put('/api/devices/{device_id}')
async def update_device_http(device_id: str, settings: DeviceSettings) -> dict[str, Any]:
    """HTTP fallback for management actions when a Socket.IO acknowledgement is unavailable."""
    if device_id != settings.device_id:
        raise HTTPException(status_code=400, detail='단말기 ID가 일치하지 않습니다.')
    result = await set_device('http', settings.model_dump())
    if not result['ok']:
        raise HTTPException(status_code=400, detail=result['message'])
    return result

@fastapi_app.delete('/api/devices/{device_id}')
async def delete_device_http(device_id: str) -> dict[str, Any]:
    result = await delete_device('http', {'device_id': device_id})
    if not result['ok']:
        raise HTTPException(status_code=400, detail=result['message'])
    return result

# POST endpoints are kept alongside PUT/DELETE for reverse proxies that reject
# non-POST browser requests before they reach the application.
@fastapi_app.post('/api/devices/{device_id}/settings')
async def update_device_http_post(device_id: str, settings: DeviceSettings) -> dict[str, Any]:
    return await update_device_http(device_id, settings)

@fastapi_app.post('/api/devices/{device_id}/remove')
async def delete_device_http_post(device_id: str) -> dict[str, Any]:
    return await delete_device_http(device_id)

@sio.event
async def connect(sid: str, environ: dict[str, Any], auth: Any = None) -> None:
    await sio.emit('devices_snapshot', [device_payload(key) for key in devices], to=sid)
    await sio.emit('calibration_updated', calibration, to=sid)
    for key in latest_locations:
        await sio.emit('broadcast_location', device_payload(key), to=sid)

@sio.event
async def disconnect(sid: str, reason: Any = None) -> None:
    for key in [key for key, sessions in active_devices.items() if sid in sessions]:
        await remove_tracking_session(key, sid)

async def reject(sid: str, message: str) -> dict[str, Any]:
    await sio.emit('location_error', {'message': message}, to=sid)
    return {'ok': False, 'message': message}

@sio.on('start_tracking')
async def start_tracking(sid: str, data: Any) -> dict[str, Any]:
    try:
        session = TrackingSession.model_validate(data)
    except ValidationError:
        return await reject(sid, '단말기 ID와 이름을 확인해주세요.')
    owners = active_devices.get(session.device_id, {})
    if owners and sid not in owners:
        return await reject(sid, '같은 단말기 ID가 이미 연결되어 있습니다. 다른 ID를 입력해주세요.')
    for key in [key for key, sessions in active_devices.items() if sid in sessions and key != session.device_id]:
        await remove_tracking_session(key, sid)
    active_devices.setdefault(session.device_id, {})[sid] = session.device_name
    if session.device_id not in devices:
        devices[session.device_id] = {
            'device_id': session.device_id, 'device_name': session.device_name,
            'floor_id': None, 'lat': None, 'lon': None, 'timestamp': None,
            'received_at': None, 'accuracy_m': None,
        }
    else:
        # A name is the mutable label of one physical terminal, never a new record.
        devices[session.device_id]['device_name'] = session.device_name
    persist()
    await publish_device(session.device_id)
    return {'ok': True, 'device': device_payload(session.device_id)}

@sio.on('stop_tracking')
async def stop_tracking(sid: str, data: Any) -> dict[str, bool]:
    key = data.get('device_id') if isinstance(data, dict) else None
    return {'ok': await remove_tracking_session(key, sid) if isinstance(key, str) else False}

@sio.on('update_location')
async def update_location(sid: str, data: Any) -> dict[str, Any]:
    try:
        location = LocationUpdate.model_validate(data)
    except ValidationError:
        return await reject(sid, '위치 데이터 형식이 올바르지 않습니다.')
    if sid not in active_devices.get(location.device_id, {}):
        return await reject(sid, '위치 전송 전에 단말기를 등록해주세요.')
    previous = devices[location.device_id]
    if location.timestamp > time.time() + 60:
        return await reject(sid, '단말기 시간을 확인해주세요.')
    if previous.get('timestamp') is not None and location.timestamp <= previous['timestamp']:
        return {'ok': True, 'ignored': True, 'received_at': previous['received_at']}
    payload = create_broadcast_payload(location)
    payload.update(device_name=previous['device_name'], floor_id=previous['floor_id'], received_at=time.time())
    devices[location.device_id] = payload
    latest_locations[location.device_id] = payload
    persist()
    await publish_device(location.device_id)
    return {'ok': True, 'received_at': payload['received_at']}

@sio.on('set_device')
async def set_device(sid: str, data: Any) -> dict[str, Any]:
    try:
        settings = DeviceSettings.model_validate(data)
    except ValidationError:
        return {'ok': False, 'message': '이름과 층을 확인해주세요.'}
    if settings.device_id not in devices:
        return {'ok': False, 'message': '등록되지 않은 단말기입니다.'}
    if settings.floor_id is not None and settings.floor_id not in FLOORS:
        return {'ok': False, 'message': '지원하지 않는 층입니다.'}
    devices[settings.device_id].update(device_name=settings.device_name, floor_id=settings.floor_id)
    persist()
    await publish_device(settings.device_id)
    return {'ok': True}


@sio.on('remove_device')
async def delete_device(sid: str, data: Any) -> dict[str, Any]:
    device_id = data.get('device_id') if isinstance(data, dict) else None
    if not isinstance(device_id, str):
        return {'ok': False, 'message': '단말기 ID를 확인해주세요.'}
    if active_devices.get(device_id):
        return {'ok': False, 'message': '연결 중인 단말기는 삭제할 수 없습니다.'}
    if not await remove_device(device_id):
        return {'ok': False, 'message': '삭제할 단말기를 찾지 못했습니다.'}
    return {'ok': True}

@sio.on('set_calibration')
async def set_calibration(sid: str, data: Any) -> dict[str, Any]:
    global calibration
    try:
        calibration = Calibration.model_validate(data).model_dump() if data is not None else None
    except ValidationError:
        return {'ok': False, 'message': '보정값을 확인해주세요.'}
    store.put('calibration', calibration)
    await sio.emit('calibration_updated', calibration)
    for key in devices:
        await publish_device(key)
    return {'ok': True}

if (ROOT / 'models').is_dir():
    fastapi_app.mount('/models', StaticFiles(directory=ROOT / 'models'), name='models')
if (ROOT / 'dashboard').is_dir():
    fastapi_app.mount('/', StaticFiles(directory=ROOT / 'dashboard', html=True), name='dashboard')
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
