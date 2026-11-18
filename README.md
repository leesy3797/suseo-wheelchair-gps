# 수서역 휠체어 실시간 관제

여러 휠체어에 부착된 **휠체어 단말기(안드로이드 태블릿)**의 GPS 위치를 수집하고, 관리자가 수서역 전체 층의 2D 디지털트윈 도면에서 각 휠체어를 확인하는 프로젝트입니다.

## 구현된 동작

- FastAPI / Socket.IO 서버와 2D 디지털트윈 관리자 대시보드
- GLB 원본을 정사영으로 렌더링한 1층·지하 1층·지하 2층 대합실·승강장 층별 도면
- 태블릿 앱 수동 실행 → 저장된 설정으로 자동 단말기 등록 → 위치 전송
- 단말기 ID 자동 생성·영구 저장 또는 태블릿에서 관리 번호 직접 입력
- 관리자 화면에서 휠체어 이름과 현재 층 지정·변경
- 중복 ID 동시 연결 거부, 재연결 시 재등록 후 최신 위치 전송
- 단말기별 이름·층·마지막 위치와 고정 좌표 변환값을 SQLite에 저장
- 오프라인 휠체어는 마지막 위치를 회색으로 유지하며, 관리자가 목록에서 삭제 가능
- GPS 수신 대기, 30초 이상 위치 지연, 30m 초과 정확도, 층 미지정 표시
- 실외 위치 비교를 위한 네이버 지도와 브라우저 기반 웹 테스트 단말기

층은 자동 판별하지 않습니다. 처음 등록한 단말기는 **층 미지정**으로 목록에 나타나며, 관리자가 층을 지정한 뒤 3D 마커를 표시합니다. 표시 층 필터를 바꿔도 휠체어에 지정된 층은 바뀌지 않습니다.

## 서버 실행

Python 3.10 이상을 사용합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

- 통합 2D 관리자 화면: `http://localhost:8000`
- 웹 테스트 단말기: `https://<서버 호스트>/tracker.html`
- 상태 확인: `/api/health`
- 지도 설정: `/api/config`

Three.js와 Socket.IO 웹 클라이언트를 CDN에서 불러오므로 브라우저 인터넷 연결이 필요합니다.

루트 `.env` 설정 예시:

```dotenv
NAVER_MAP_CLIENT_ID=발급받은_Client_ID
ANCHOR_LAT=37.485000
ANCHOR_LON=127.103000
MODEL_SCALE=1
```

네이버 지도는 선택 기능입니다. Client ID가 없어도 2D 관리자 화면과 태블릿 앱의 위치 전송은 사용할 수 있습니다. Naver Cloud에서 실제 웹 서비스 호스트를 허용하고 Dynamic Map을 활성화하세요. 비밀 키는 브라우저 설정에 사용하지 않습니다. `.env` 변경 후 서버를 재시작하세요.

`monitoring.sqlite3`는 최초 실행 시 생성되며 Git에서 제외됩니다. `SUSEO_DB_PATH`로 저장 경로를 지정할 수 있습니다. 데이터베이스는 최신 위치만 보관하고 이동 이력을 누적하지 않습니다. 서버 재시작 후 저장된 단말기는 오프라인으로 표시되며, 태블릿이 다시 등록하면 연결 상태가 갱신됩니다. 이 버전은 메모리에 연결 상태를 관리하므로 **Uvicorn 단일 워커**로 실행합니다.

## 안드로이드 태블릿 앱

```powershell
cd android
npm install
npx expo start
```

앱은 `https://suseo-wheelchair-gps.duckdns.org` 서버에 연결하며 서버 주소와 자동 생성 단말기 ID는 앱 화면에 표시하지 않습니다. 최초 실행 시 휠체어 이름을 입력·저장한 뒤 위치 전송을 시작하세요. ID는 기기에 자동 생성·저장되며 앱 업데이트 후에도 유지됩니다. 같은 기기에서 이름을 바꾸면 동일 단말기의 이름만 갱신되고 층 설정은 유지됩니다. 휠체어 이름 아래에는 네이버 지도와 현재 위치가 표시됩니다.

다음 앱 실행부터 위치 권한을 확인하고 자동 전송합니다. 태블릿 부팅 시 앱을 자동 실행하는 기능은 넣지 않았습니다. 앱 내에서 전송을 일시 중지해도 다음 수동 앱 실행 시 다시 전송합니다. 앱에서 위치 권한을 변경하려면 Android 설정에서 해당 앱의 권한을 여세요.

백그라운드 위치 전송은 Expo Go가 아니라 개발·배포 빌드로 검증합니다.

```powershell
npx eas-cli build --platform android --profile preview
```

위치 권한과 백그라운드 위치 권한을 허용하세요. 백그라운드 권한을 거부하면 앱 전경에서만 전송합니다. 백그라운드 권한이 있을 때는 별도의 전경 watcher를 중복 실행하지 않습니다. 네트워크 단절 중에는 최신 측정 한 건만 유지하고, 재연결·세션 승인 후 전송합니다. OS가 프로세스를 종료하거나 사용자가 강제 중지한 경우의 지속 동작은 기기에서 확인해야 합니다. 새 APK를 기존 앱 위에 업데이트 설치하면 저장된 단말기 ID와 이름이 유지됩니다.

iOS 설정은 기존대로 유지하지만 이 개발의 주 대상은 안드로이드 태블릿입니다.

## 관리자 사용 순서

1. 서버를 실행하고 앱에서 휠체어 이름을 저장한 뒤 위치 전송을 시작합니다.
2. 관리자 대시보드의 단말기 목록에서 **설정**을 선택합니다.
3. 휠체어 이름과 실제 현재 층을 저장합니다.
4. **도면 보기**를 누르면 해당 층 도면과 휠체어 위치로 이동합니다.
5. 휠체어가 다른 층으로 이동하면 관리자가 층을 변경합니다.

회색 마커는 마지막 확인 위치이며 현재 위치를 보장하지 않습니다. 서버 연결이 끊긴 관리자 화면도 마커를 회색으로 바꾸고 서버 연결 끊김을 표시합니다. 측정 시각과 서버 수신 시각을 함께 표시해 과거 GPS 데이터가 새 위치처럼 보이지 않게 합니다.

## 고정 좌표 변환

GLB 원본의 위치·축척을 유지합니다. `MODEL_SCALE` 기본값은 `1`입니다. 최종 관리자 화면에는 보정 기능을 노출하지 않습니다. 현장 검증 후 `.env`의 `STATION_ORIGIN_*`, `STATION_ROTATION_DEG`, `STATION_METERS_TO_MODEL`을 고정해 서버를 재시작합니다.

- 기준점: 실제 GPS에 대응하는 모델의 X/Z
- 방향: 미터 단위 동/북 좌표를 X/Z 평면에서 회전시키는 각도, -180~180°
- 축척: 실제 1m에 대응하는 모델 단위, 기본 1


방향 0°는 모델의 +X가 동쪽, +Z가 북쪽인 경우입니다. 한 점만으로 올바른 방향·축척을 자동 추정하지 않으므로, 실제 대응 지점 두 곳 이상을 비교해 설정값을 검증하세요. GLB 자체의 층 정렬 오류는 원본 모델에서 수정해야 합니다.

## 통신 이벤트

| 이벤트 | 방향 | 역할 |
|---|---|---|
| `start_tracking` | 단말기 → 서버 | ID·초기 이름 등록, 승인 응답 |
| `update_location` | 단말기 → 서버 | GPS 측정·정확도 전송, 수신 응답 |
| `stop_tracking` | 단말기 → 서버 | 공유 세션 종료 |
| `devices_snapshot` | 서버 → 클라이언트 | 위치가 없는 단말기와 오프라인 단말기도 포함한 전체 목록 |
| `device_updated` | 서버 → 클라이언트 | 이름·층·연결 상태·최신 위치 |
| `broadcast_location` | 서버 → 클라이언트 | 위치가 있는 단말기의 좌표, 기존 지도 호환용 |
| `device_disconnected` | 서버 → 클라이언트 | 오프라인 전환, 위치는 유지 |
| `set_device` | 관리자 → 서버 | 이름·층 변경 |
| `remove_device` | 관리자 → 서버 | 연결이 끊긴 단말기의 현재 기록 삭제 |

위치 데이터:

```json
{
  "device_id": "suseo-chair-01",
  "lat": 37.48512,
  "lon": 127.10345,
  "timestamp": 1793750000.5,
  "accuracy_m": 8
}
```

서버가 수신 시각 `received_at`, 관리자 이름, `floor_id`, 변환한 `x`, `z`, `online`을 추가합니다. 이미 받은 측정 시각 이하의 데이터는 무시하고, 서버보다 60초 이상 미래인 데이터와 비정상 수치는 거부합니다.

## 검증

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q -p no:cacheprovider
node --test android/transport.test.mjs dashboard/device-state.test.mjs
cd android
npx expo export --platform android --output-dir dist --no-minify
```

테스트는 단말기별 독립성, 세션 등록, 중복 ID, 관리자 설정 유지, 오프라인 보존, 과거·미래 측정 처리, 공통 보정, 재시작 복원, 실제 HTTP/Socket.IO 통신과 전송 재연결 순서를 검증합니다. 임시 데이터베이스를 사용하며 운영 DB를 변경하지 않습니다.

## 현장 확인과 운영 범위

태블릿 모델·Android 버전, 인터넷 연결, 현장 GPS 수신 상태는 아직 확인되지 않았습니다. 지하에서 GPS가 수신되지 않거나 오차가 크면 코드 보정만으로 정확한 실내 위치를 만들 수 없으므로 추가 실내 측위 방식의 검토가 필요합니다.

현재 인증·역할별 접근 제어는 없습니다. 관리자 변경 이벤트도 연결된 클라이언트에서 호출할 수 있습니다. 운영망에 공개하기 전에는 단말기 인증과 관리자 권한 구분을 별도로 구현해야 합니다. ngrok은 개발 서버 연결 시험 용도이며 기본 실행 명령은 `ngrok http 8000`입니다.

기술 참고: [Expo 위치 API](https://docs.expo.dev/versions/latest/sdk/location/), [Expo 파일 저장 API](https://docs.expo.dev/versions/v55.0.0/sdk/filesystem-legacy/). 이 저장소는 Expo SDK 51에 맞는 설치된 API를 사용합니다.

## AWS 운영 배포

ngrok 대신 AWS EC2에서 상시 운영하는 절차와 Nginx·HTTPS·Socket.IO 설정은
[AWS_DEPLOYMENT.md](AWS_DEPLOYMENT.md)를 참고하세요. 운영 배포에서는
`SOCKET_CORS_ALLOWED_ORIGINS`, `TRUSTED_HOSTS`, `SUSEO_DB_PATH`를 반드시 설정하고,
Android 앱의 고정 서버 주소도 새 HTTPS 도메인에 맞춰 빌드해야 합니다.
