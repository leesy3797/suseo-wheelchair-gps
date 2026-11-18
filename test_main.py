import asyncio
import math
import os
import time

os.environ['SUSEO_DB_PATH'] = ':memory:'
import pytest
from pydantic import ValidationError
from starlette.responses import Response
import main as backend

@pytest.fixture(autouse=True)
def isolated_state(monkeypatch):
    db = backend.StateStore(':memory:')
    monkeypatch.setattr(backend, 'store', db)
    monkeypatch.setattr(backend, 'devices', {})
    monkeypatch.setattr(backend, 'active_devices', {})
    monkeypatch.setattr(backend, 'latest_locations', {})
    monkeypatch.setattr(backend, 'calibration', None)
    monkeypatch.setattr(backend, 'ANCHOR_LAT', 37.485)
    monkeypatch.setattr(backend, 'ANCHOR_LON', 127.103)
    yield
    db.db.close()

@pytest.fixture
def emitted(monkeypatch):
    events = []
    async def record(event, payload, **kwargs):
        events.append((event, payload, kwargs))
    monkeypatch.setattr(backend.sio, 'emit', record)
    return events

def run(coroutine):
    return asyncio.run(coroutine)

def register(device='chair-1', sid='socket-1', name='휠체어 01'):
    return run(backend.start_tracking(sid, {'device_id': device, 'device_name': name}))

def location(device='chair-1', timestamp=None, **kwargs):
    return {'device_id': device, 'lat': 37.4851, 'lon': 127.1032,
            'timestamp': timestamp or time.time(), 'accuracy_m': 5, **kwargs}

def test_anchor_and_meter_conversion():
    assert backend.map_coordinates(37.485, 127.103) == pytest.approx((0, 0))
    assert backend.map_coordinates(37.4851, 127.1032) == pytest.approx((111320 * math.cos(math.radians(37.485)) * .0002, 11.132))

def test_shared_rotation_scale_and_offset(emitted):
    result = run(backend.set_calibration('admin', {'lat': 37.485, 'lon': 127.103, 'x': 5, 'z': 10, 'rotation_deg': 90, 'meters_to_model': 2}))
    assert result['ok']
    assert backend.map_coordinates(37.4851, 127.103) == pytest.approx((5 - 22.264, 10))
    assert backend.store.get('calibration')['rotation_deg'] == 90

@pytest.mark.parametrize('changes', [{'lat': 91}, {'lon': -181}, {'lat': float('nan')}, {'timestamp': float('inf')}, {'accuracy_m': -1}, {'device_id': '   '}, {'extra': True}])
def test_invalid_payloads(changes):
    with pytest.raises(ValidationError):
        backend.LocationUpdate.model_validate(location(**changes))

def test_unregistered_location_is_rejected(emitted):
    assert not run(backend.update_location('unknown', location()))['ok']
    assert not backend.devices

def test_multiple_terminals_are_independent(emitted):
    assert register()['ok']
    assert register('chair-2', 'socket-2', '휠체어 02')['ok']
    assert run(backend.update_location('socket-1', location()))['ok']
    assert run(backend.update_location('socket-2', location('chair-2')))['ok']
    assert set(backend.latest_locations) == {'chair-1', 'chair-2'}
    assert backend.devices['chair-1']['floor_id'] is None
    assert backend.devices['chair-2']['device_name'] == '휠체어 02'

def test_duplicate_identity_cannot_overwrite(emitted):
    register()
    assert not register('chair-1', 'other-socket', '다른 휠체어')['ok']
    assert not run(backend.update_location('other-socket', location()))['ok']
    assert backend.devices['chair-1']['device_name'] == '휠체어 01'

def test_new_registration_renames_same_terminal_and_preserves_floor(emitted):
    register()
    settings = {'device_id': 'chair-1', 'device_name': '관리자 이름', 'floor_id': 'station-b1.glb'}
    assert run(backend.set_device('admin', settings))['ok']
    run(backend.disconnect('socket-1'))
    assert register('chair-1', 'socket-2', '예전 앱 이름')['ok']
    run(backend.update_location('socket-2', location(device_name='잘못된 이름')))
    result = backend.device_payload('chair-1')
    assert result['device_name'] == '예전 앱 이름'
    assert result['floor_id'] == 'station-b1.glb'
    assert backend.store.get('devices')['chair-1']['floor_id'] == 'station-b1.glb'

def test_disconnect_retains_latest_position(emitted):
    register()
    run(backend.update_location('socket-1', location()))
    saved = dict(backend.devices['chair-1'])
    run(backend.disconnect('socket-1'))
    assert backend.devices['chair-1'] == saved
    assert not backend.device_payload('chair-1')['online']
    assert backend.store.get('devices')['chair-1']['lat'] == saved['lat']

def test_offline_terminal_can_be_removed_but_connected_one_cannot(emitted):
    register()
    assert not run(backend.delete_device('admin', {'device_id': 'chair-1'}))['ok']
    run(backend.disconnect('socket-1'))
    assert run(backend.delete_device('admin', {'device_id': 'chair-1'}))['ok']
    assert 'chair-1' not in backend.devices
    assert any(event == 'device_removed' and data['device_id'] == 'chair-1' for event, data, _ in emitted)

def test_out_of_order_or_duplicate_location_does_not_replace_latest(emitted):
    register()
    run(backend.update_location('socket-1', location(timestamp=200)))
    result = run(backend.update_location('socket-1', location(timestamp=100, lat=38)))
    assert result['ignored']
    assert backend.devices['chair-1']['timestamp'] == 200
    assert backend.devices['chair-1']['lat'] == 37.4851

def test_future_location_is_rejected(emitted):
    register()
    assert not run(backend.update_location('socket-1', location(timestamp=time.time() + 3600)))['ok']

def test_unknown_floor_rejected(emitted):
    register()
    assert not run(backend.set_device('admin', {'device_id': 'chair-1', 'device_name': 'name', 'floor_id': '3F'}))['ok']
    assert backend.devices['chair-1']['floor_id'] is None

def test_invalid_calibration_does_not_replace_saved_value(emitted):
    run(backend.set_calibration('admin', {'lat': 37, 'lon': 127, 'x': 1, 'z': 2}))
    assert not run(backend.set_calibration('admin', {'lat': 37, 'lon': 127, 'x': 1, 'z': 2, 'meters_to_model': 0}))['ok']
    assert backend.calibration['x'] == 1

def test_new_viewer_receives_offline_and_unlocated_devices(emitted):
    register()
    run(backend.disconnect('socket-1'))
    emitted.clear()
    run(backend.connect('viewer', {}))
    snapshot = next(data for event, data, _ in emitted if event == 'devices_snapshot')
    assert snapshot[0]['online'] is False
    assert snapshot[0]['lat'] is None

def test_restart_restores_state_without_live_connection(tmp_path, monkeypatch, emitted):
    store = backend.StateStore(str(tmp_path / 'state.sqlite3'))
    monkeypatch.setattr(backend, 'store', store)
    register()
    run(backend.update_location('socket-1', location()))
    store.db.close()
    restored = backend.StateStore(str(tmp_path / 'state.sqlite3'))
    monkeypatch.setattr(backend, 'devices', restored.get('devices'))
    monkeypatch.setattr(backend, 'active_devices', {})
    assert backend.device_payload('chair-1')['online'] is False
    assert backend.device_payload('chair-1')['lat'] == 37.4851
    restored.db.close()

def test_config_is_not_cached_and_has_shared_settings():
    response = Response()
    result = run(backend.config(response))
    assert len(result['floors']) == 4
    assert 'station_transform' in result
    assert response.headers['Cache-Control'].startswith('no-store')

def test_real_socket_multi_terminal_and_admin_workflow():
    import socket
    import aiohttp
    import socketio
    import uvicorn
    async def scenario():
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(backend.app, log_level='error', lifespan='off'))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        clients = [socketio.AsyncClient() for _ in range(3)]
        try:
            for _ in range(100):
                if server.started: break
                if task.done(): await task
                await asyncio.sleep(.02)
            url = f'http://127.0.0.1:{port}'
            async with aiohttp.ClientSession() as http:
                async with http.get(url + '/') as response:
                    assert response.status == 200
                    assert '휠체어 위치를 층별 도면에서 확인하세요.' in await response.text()
                async with http.get(url + '/api/config') as response:
                    assert len((await response.json())['floors']) == 4
            one, two, admin = clients
            updates = []
            admin.on('device_updated', lambda data: updates.append(data))
            for client in clients: await client.connect(url, transports=['websocket'])
            for client, key in [(one, 'chair-1'), (two, 'chair-2')]:
                assert (await client.call('start_tracking', {'device_id': key, 'device_name': key}))['ok']
                assert (await client.call('update_location', location(key)))['ok']
            assert (await admin.call('set_device', {'device_id': 'chair-1', 'device_name': '수서 01', 'floor_id': 'station-b2-platform.glb'}))['ok']
            await one.disconnect()
            for _ in range(100):
                if any(d['device_id'] == 'chair-1' and not d['online'] for d in updates): break
                await asyncio.sleep(.01)
            assert any(d['device_id'] == 'chair-1' and not d['online'] and d['floor_id'] == 'station-b2-platform.glb' for d in updates)
            assert backend.device_payload('chair-2')['online']
        finally:
            for client in clients:
                if client.connected: await client.disconnect()
            server.should_exit = True
            await task
    run(scenario())
