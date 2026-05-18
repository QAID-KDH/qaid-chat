# 🍎 Apple 서비스센터 실시간 채팅

수리실(Mac OS, 외부망)과 응대실(Windows, 내부망) 간의 실시간 텍스트 커뮤니케이션 웹 프로그램입니다.

## 기능

- ✅ 실시간 양방향 채팅 (Socket.IO)
- ✅ 전체 채팅방 (수리실 + 모든 응대실)
- ✅ 접속자 목록 실시간 표시
- ✅ 입력 중 표시 (typing indicator)
- ✅ 메시지 히스토리 (최근 100개)
- ✅ 부서별 색상 구분 (수리실 주황 / 응대실 초록)
- ✅ 다크 모드 디자인
- ✅ 모바일 반응형

## 구성

- **백엔드**: Node.js + Express + Socket.IO
- **프론트엔드**: HTML/CSS/JS (별도 빌드 불필요)
- **배포**: 외부 클라우드 서버 (양쪽 네트워크 환경에서 모두 접속 가능)

---

## 🚀 로컬 테스트

```bash
# 1. 의존성 설치
npm install

# 2. 서버 실행
npm start

# 3. 브라우저에서 접속
# http://localhost:3000
```

---

## ☁️ 무료 클라우드 배포 (권장)

수리실(외부망)과 응대실(내부망) 양쪽에서 접속 가능하도록 **외부 클라우드 서버에 배포**합니다.

### 옵션 1: Render.com (가장 쉬움, 무료)

1. https://render.com 가입
2. 이 프로젝트를 GitHub에 업로드
3. Render 대시보드 → **New Web Service** → GitHub 리포지토리 연결
4. 설정:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. 배포 완료 후 `https://your-app.onrender.com` 같은 주소 발급
6. 수리실/응대실 모두 이 주소로 접속

### 옵션 2: Railway.app

1. https://railway.app 가입
2. **New Project → Deploy from GitHub repo**
3. 자동으로 Node.js 감지 후 배포
4. **Settings → Networking → Generate Domain** 클릭
5. 발급된 주소로 접속

### 옵션 3: Fly.io

```bash
# Fly CLI 설치 후
fly launch
fly deploy
```

---

## 💻 사용 방법

1. 배포된 URL을 모든 PC에서 브라우저로 접속
2. 이름 입력 + 부서 선택 (수리실 / 응대실)
3. **입장하기** 클릭
4. 채팅창에서 실시간 대화

---

## 🔒 보안 권장사항 (운영 환경)

기본 코드는 데모용입니다. 실제 운영 시 다음을 추가하세요:

1. **HTTPS 사용**: Render/Railway는 자동 제공
2. **간단한 비밀번호 인증** 추가
3. **IP 화이트리스트** (응대실 내부망 IP만 허용)
4. **메시지 영구 저장**: SQLite/PostgreSQL 추가
5. **CORS 제한**: `origin: '*'` 을 실제 도메인으로 변경

---

## 📁 파일 구조

```
repair-chat/
├── package.json       # 의존성
├── server.js          # Node.js 서버 (Socket.IO)
├── public/
│   └── index.html     # 클라이언트 (UI + 채팅 로직)
└── README.md          # 이 문서
```
