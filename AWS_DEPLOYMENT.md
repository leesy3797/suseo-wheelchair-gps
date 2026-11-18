# AWS EC2 운영 배포 안내

이 프로젝트는 한 대의 Ubuntu EC2 인스턴스에서 FastAPI, Socket.IO, SQLite,
관리자 대시보드를 함께 실행하는 구조로 준비되어 있다. Nginx가 외부 HTTPS
요청과 WebSocket을 받아 내부의 Uvicorn(`127.0.0.1:8000`)으로 전달한다.

> 운영 주소는 `suseo-wheelchair-gps.duckdns.org`로 정해져 있다.

## 시작 전에 사용자가 준비할 것

1. AWS 계정을 만들고 **Billing > Budgets**에서 월 예산 알림을 만든다.
   처음에는 USD 1과 USD 5에 이메일 알림을 권장한다.
2. DuckDNS 주소 `suseo-wheelchair-gps.duckdns.org`를 사용한다.
   iOS와 Android 위치 단말기는 HTTPS 주소를 사용해야 한다.
3. EC2 콘솔에서 서울 리전(`ap-northeast-2`)의 Ubuntu LTS 인스턴스를 만든다.
   인스턴스 선택 화면에서 계정에 표시되는 **Free tier eligible** 항목을 고른다.
4. 보안 그룹 인바운드 규칙을 다음처럼 설정한다.

   | 포트 | 소스 | 용도 |
   | --- | --- | --- |
   | 22 (SSH) | 내 공인 IP만 | 서버 관리 |
   | 80 (HTTP) | `0.0.0.0/0` | HTTPS 인증서 발급 및 HTTP 리디렉션 |
   | 443 (HTTPS) | `0.0.0.0/0` | 대시보드·태블릿 앱 |

   **8000 포트는 외부에 열지 않는다.**
5. 고정 주소가 필요하면 Elastic IP를 만들고 EC2에 연결한 뒤, 도메인의 A 레코드를
   그 주소로 연결한다. DNS 전파 후에 다음 설치를 진행한다.

AWS의 무료 혜택은 계정 생성 시점과 사용량에 따라 달라진다. 특히 공인 IPv4는
일반적으로 시간당 과금 항목이므로 Free Tier/크레딧 사용량과 예산 알림을 계속
확인한다. 이 문서는 비용이 0원임을 보장하지 않는다.

## EC2에서 최초 1회 설치

프로젝트를 `/opt/suseo-wheelchair-gps`에 업로드 또는 Git으로 내려받은 뒤 아래를
실행한다. 이 문서는 Ubuntu LTS의 기본 사용자 `ubuntu` 기준이다.

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip nginx certbot python3-certbot-nginx
sudo mkdir -p /opt/suseo-wheelchair-gps/data
sudo chown -R ubuntu:ubuntu /opt/suseo-wheelchair-gps

cd /opt/suseo-wheelchair-gps
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
cp deploy/aws.env.example .env
chmod 600 .env
```

`.env`에서 최소한 다음 항목을 실제 값으로 바꾼다.

```dotenv
NAVER_MAP_CLIENT_ID=실제_네이버_클라이언트_ID
SUSEO_DB_PATH=/opt/suseo-wheelchair-gps/data/monitoring.sqlite3
SOCKET_CORS_ALLOWED_ORIGINS=http://suseo-wheelchair-gps.duckdns.org,https://suseo-wheelchair-gps.duckdns.org
TRUSTED_HOSTS=suseo-wheelchair-gps.duckdns.org,localhost,127.0.0.1
```

네이버 클라우드 콘솔의 지도 API 웹 서비스 URL 허용 목록에도
`https://suseo-wheelchair-gps.duckdns.org`을 추가한다.

## 서버·Nginx·HTTPS 활성화

```bash
sudo cp deploy/suseo-wheelchair.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now suseo-wheelchair

sudo cp deploy/nginx-suseo-wheelchair.conf /etc/nginx/conf.d/suseo-wheelchair.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d suseo-wheelchair-gps.duckdns.org
```

정상 여부는 다음 주소에서 확인한다.

```text
https://suseo-wheelchair-gps.duckdns.org/api/health
```

정상 응답은 `{"status":"ok"}`이다. 서비스 로그는 다음으로 확인한다.

```bash
sudo journalctl -u suseo-wheelchair -f
```

## 단말기 전환

각 Android/iOS 단말기 앱의 **서버 주소**를 기존 ngrok 주소 대신
`https://suseo-wheelchair-gps.duckdns.org`으로 저장한 뒤 위치 전송을 다시 시작한다. 단말기에
기존 주소가 저장돼 있으면 새 APK를 설치해도 자동으로 바뀌지 않으므로, 설정
화면에서 직접 바꿔야 한다.

## 업데이트 방법

새 코드를 서버에 반영한 뒤 다음을 실행한다.

```bash
cd /opt/suseo-wheelchair-gps
.venv/bin/python -m pip install -r requirements.txt
sudo systemctl restart suseo-wheelchair
```

SQLite 파일은 `data/monitoring.sqlite3`에 보관된다. 코드 업데이트 전에 이 파일을
별도 안전한 위치로 복사해 백업한다.
