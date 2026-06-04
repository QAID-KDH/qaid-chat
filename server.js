// Apple 서비스센터 실시간 채팅 서버 (멀티 센터 지원 + 비밀번호 인증)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// JSON 파싱 미들웨어
app.use(express.json());

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

// 센터 목록 (가나다순 + 예비 3개)
const CENTERS = [
  '강릉', '강서', '거제', '고양스타필드', '광주 Apple', '김포 Apple',
  '대구', '목포 Apple', '미아사거리', '별내', '부천', '사상 Apple',
  '세종', '순천 Apple', '신제주 Apple', '안동', '안산',
  '영등포타임스퀘어', '은평', '의정부', '이천', '익산 Apple',
  '전주 Apple', '죽전 Apple', '진주', '평택 Apple', '홍성',
  '예비 1', '예비 2', '예비 3'
];

// 센터별 비밀번호 (환경변수에서 로드)
// 환경변수 CENTER_CODES_JSON 형식: {"강릉":"700351","강서":"700305",...}
let CENTER_CODES = {};
try {
  if (process.env.CENTER_CODES_JSON) {
    CENTER_CODES = JSON.parse(process.env.CENTER_CODES_JSON);
    console.log(`🔒 비밀번호 로드 완료: ${Object.keys(CENTER_CODES).length}개 센터`);
  } else {
    console.warn('⚠️  CENTER_CODES_JSON 환경변수가 없습니다. 모든 로그인이 차단됩니다.');
  }
} catch (err) {
  console.error('❌ CENTER_CODES_JSON 파싱 실패:', err.message);
}

// Rate Limit: IP별 실패 횟수 추적 (3회 실패 시 1분 차단)
const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION = 60 * 1000; // 1분 (밀리초)
const loginAttempts = new Map(); // IP -> { count, lockedUntil }

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.socket.remoteAddress ||
         'unknown';
}

function isLocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    return Math.ceil((record.lockedUntil - Date.now()) / 1000);
  }
  // 차단 시간 지났으면 기록 삭제
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginAttempts.delete(ip);
  }
  return false;
}

function recordFailedAttempt(ip) {
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  record.count++;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION;
    console.log(`🚫 IP ${ip} 차단됨 (${MAX_ATTEMPTS}회 실패) - ${LOCKOUT_DURATION/1000}초간`);
  }
  loginAttempts.set(ip, record);
}

function recordSuccessfulAttempt(ip) {
  loginAttempts.delete(ip); // 성공 시 기록 초기화
}

// 센터 목록 제공 API
app.get('/api/centers', (req, res) => {
  res.json(CENTERS);
});

// 비밀번호 검증 API
app.post('/api/verify', (req, res) => {
  const ip = getClientIP(req);

  // 차단 여부 확인
  const lockSecondsLeft = isLocked(ip);
  if (lockSecondsLeft) {
    return res.status(429).json({
      success: false,
      locked: true,
      secondsLeft: lockSecondsLeft,
      message: `너무 많이 시도했습니다. ${lockSecondsLeft}초 후 다시 시도해주세요.`
    });
  }

  const { center, password } = req.body;

  // 입력값 검증
  if (!center || !password) {
    return res.status(400).json({
      success: false,
      message: '센터와 비밀번호를 모두 입력해주세요.'
    });
  }

  if (!CENTERS.includes(center)) {
    return res.status(400).json({
      success: false,
      message: '유효하지 않은 센터입니다.'
    });
  }

  // 비밀번호 일치 확인
  const expectedCode = CENTER_CODES[center];
  if (!expectedCode) {
    return res.status(500).json({
      success: false,
      message: '센터 비밀번호가 설정되지 않았습니다. 관리자에게 문의하세요.'
    });
  }

  if (String(password) !== String(expectedCode)) {
    recordFailedAttempt(ip);
    const record = loginAttempts.get(ip);
    const attemptsLeft = MAX_ATTEMPTS - record.count;
    return res.status(401).json({
      success: false,
      message: attemptsLeft > 0
        ? `비밀번호가 올바르지 않습니다. (남은 시도: ${attemptsLeft}회)`
        : `${MAX_ATTEMPTS}회 실패. 1분간 로그인이 차단됩니다.`,
      attemptsLeft: Math.max(0, attemptsLeft)
    });
  }

  // 성공
  recordSuccessfulAttempt(ip);
  res.json({ success: true });
});

const MAX_HISTORY = 100;

// 센터별 데이터 저장소
// centerData[centerName] = { messageHistory: [], users: Map() }
const centerData = {};

function getCenterData(centerName) {
  if (!centerData[centerName]) {
    centerData[centerName] = {
      messageHistory: [],
      users: new Map() // socketId -> { name, role }
    };
  }
  return centerData[centerName];
}

function addToHistory(centerName, message) {
  const data = getCenterData(centerName);
  data.messageHistory.push(message);
  // 100개 초과 시 가장 오래된 "텍스트/시스템" 메시지부터 제거 (이미지/파일은 보호)
  if (data.messageHistory.length > MAX_HISTORY) {
    const idx = data.messageHistory.findIndex(m => m.type !== 'image' && m.type !== 'file');
    if (idx !== -1) {
      data.messageHistory.splice(idx, 1); // 가장 오래된 비파일 메시지 제거
    } else {
      data.messageHistory.shift(); // 전부 파일이면 맨 앞 제거 (예외적)
    }
  }
}

// 소켓별 센터 정보 저장
const socketCenter = new Map(); // socketId -> centerName

io.on('connection', (socket) => {
  console.log(`접속: ${socket.id}`);

  // 사용자 입장
  socket.on('join', ({ name, role, center, password }) => {
    // 유효한 센터인지 검증
    if (!CENTERS.includes(center)) {
      socket.emit('error', '유효하지 않은 센터입니다.');
      return;
    }

    // 비밀번호 재검증 (Socket 연결 시점에도 확인)
    const expectedCode = CENTER_CODES[center];
    if (!expectedCode || String(password) !== String(expectedCode)) {
      socket.emit('error', '인증 실패');
      socket.disconnect();
      return;
    }

    // 소켓을 해당 센터 Room에 참여시킴 (핵심: 격리의 기반)
    socket.join(center);
    socketCenter.set(socket.id, center);

    const data = getCenterData(center);
    data.users.set(socket.id, { name, role });

    // 입장한 사용자에게 해당 센터의 메시지 히스토리만 전송
    socket.emit('history', data.messageHistory);

    // 같은 센터 사람들에게만 접속자 목록 전송
    io.to(center).emit('users', Array.from(data.users.values()));

    // 같은 센터 사람들에게만 입장 알림
    const joinMessage = {
      type: 'system',
      text: `${role === 'repair' ? '🔧 수리실' : '💬 고객대기실'} ${name}님이 입장했습니다.`,
      timestamp: new Date().toISOString()
    };
    io.to(center).emit('message', joinMessage);
    addToHistory(center, joinMessage);

    console.log(`[${center}] ${name}(${role}) 입장`);
  });

  // 메시지 수신
  // payload: 문자열(text) 또는 객체 { text, withVoice } 또는 { type:'image', ... } 호환
  socket.on('message', (payload) => {
    const center = socketCenter.get(socket.id);
    if (!center) return;
    const data = getCenterData(center);
    const user = data.users.get(socket.id);
    if (!user) return;

    // ===== 이미지/파일 메시지 처리 =====
    if (payload && typeof payload === 'object' && (payload.type === 'image' || payload.type === 'file')) {
      // Cloudinary URL 검증 (보안: 우리 클라우드 주소만 허용)
      const url = typeof payload.url === 'string' ? payload.url : '';
      if (!url.startsWith('https://res.cloudinary.com/')) {
        socket.emit('error', '유효하지 않은 파일입니다.');
        return;
      }

      const fileMessage = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        type: payload.type, // 'image' 또는 'file'
        name: user.name,
        role: user.role,
        url: url,
        publicId: typeof payload.publicId === 'string' ? payload.publicId : null, // 삭제용
        resourceType: typeof payload.resourceType === 'string' ? payload.resourceType : (payload.type === 'image' ? 'image' : 'raw'), // Cloudinary 삭제용
        fileName: typeof payload.fileName === 'string' ? payload.fileName.slice(0, 150) : '',
        fileType: typeof payload.fileType === 'string' ? payload.fileType : '',
        fileSize: typeof payload.fileSize === 'number' ? payload.fileSize : 0,
        caption: typeof payload.caption === 'string' ? payload.caption.trim().slice(0, 500) : '',
        timestamp: new Date().toISOString()
      };

      addToHistory(center, fileMessage);
      io.to(center).emit('message', fileMessage);
      console.log(`[${center}] ${user.name} ${payload.type === 'image' ? '이미지' : '파일'} 전송: ${fileMessage.fileName}`);
      return;
    }

    // ===== 텍스트 메시지 처리 (기존) =====
    // 하위 호환성: payload가 문자열이면 텍스트 모드로 처리
    let text, withVoice;
    if (typeof payload === 'string') {
      text = payload;
      withVoice = false;
    } else if (payload && typeof payload === 'object') {
      text = payload.text;
      withVoice = payload.withVoice === true;
    } else {
      return;
    }

    if (!text || !text.trim()) return;

    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      type: 'chat',
      name: user.name,
      role: user.role,
      text: text.trim(),
      withVoice: withVoice,  // 음성 알림 여부
      timestamp: new Date().toISOString(),
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null
    };

    addToHistory(center, message);
    // 같은 센터 사람들에게만 전송
    io.to(center).emit('message', message);
  });

  // 메시지 확인(체크박스 클릭) 처리
  socket.on('acknowledge', (messageId) => {
    const center = socketCenter.get(socket.id);
    if (!center) return;
    const data = getCenterData(center);
    const user = data.users.get(socket.id);
    if (!user || user.role !== 'repair') return; // 수리실만 확인 가능

    const msg = data.messageHistory.find(m => m.id === messageId);
    if (msg && !msg.acknowledged) {
      msg.acknowledged = true;
      msg.acknowledgedBy = user.name;
      msg.acknowledgedAt = new Date().toISOString();

      // 같은 센터 사람들에게만 확인 상태 전파
      io.to(center).emit('acknowledged', {
        messageId: msg.id,
        acknowledgedBy: msg.acknowledgedBy,
        acknowledgedAt: msg.acknowledgedAt
      });
    }
  });

  // 메시지 삭제 처리 (본인 메시지만, 음성 반복도 함께 중단)
  socket.on('delete', (messageId) => {
    const center = socketCenter.get(socket.id);
    if (!center) return;
    const data = getCenterData(center);
    const user = data.users.get(socket.id);
    if (!user) return;
    if (!messageId) return;

    const msg = data.messageHistory.find(m => m.id === messageId);
    if (!msg) return;

    // 본인이 보낸 메시지인지 확인 (이름 + 부서 모두 일치)
    if (msg.name !== user.name || msg.role !== user.role) {
      socket.emit('error', '본인이 보낸 메시지만 삭제할 수 있습니다.');
      return;
    }

    // 이미 삭제된 메시지인지 확인
    if (msg.deleted) return;

    // 메시지를 삭제 상태로 표시 (소프트 삭제)
    msg.deleted = true;
    msg.deletedAt = new Date().toISOString();

    // 이미지/파일 메시지면 Cloudinary에서도 삭제 (저장공간 회수)
    if ((msg.type === 'image' || msg.type === 'file') && msg.publicId) {
      deleteFromCloudinary(msg.publicId, msg.resourceType || (msg.type === 'image' ? 'image' : 'raw'));
      msg.url = null; // URL 제거
    } else {
      msg.originalText = msg.text; // 원본 보관 (감사용)
      msg.text = '⊘ 삭제된 메시지입니다.';
    }

    // 같은 센터 사람들에게 삭제 상태 전파
    // (수신측에서 이 ID에 대한 음성 반복도 중단해야 함)
    io.to(center).emit('deleted', {
      messageId: msg.id,
      deletedAt: msg.deletedAt
    });
  });

  // 타이핑 표시
  socket.on('typing', (isTyping) => {
    const center = socketCenter.get(socket.id);
    if (!center) return;
    const data = getCenterData(center);
    const user = data.users.get(socket.id);
    if (!user) return;
    // 같은 센터의 본인 제외 모두에게 전송
    socket.to(center).emit('typing', { name: user.name, role: user.role, isTyping });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const center = socketCenter.get(socket.id);
    if (center) {
      const data = getCenterData(center);
      const user = data.users.get(socket.id);
      if (user) {
        const leaveMessage = {
          type: 'system',
          text: `${user.role === 'repair' ? '🔧 수리실' : '💬 고객대기실'} ${user.name}님이 퇴장했습니다.`,
          timestamp: new Date().toISOString()
        };
        io.to(center).emit('message', leaveMessage);
        addToHistory(center, leaveMessage);
        data.users.delete(socket.id);
        io.to(center).emit('users', Array.from(data.users.values()));
        console.log(`[${center}] ${user.name} 퇴장`);
      }
      socketCenter.delete(socket.id);
    }
    console.log(`연결 해제: ${socket.id}`);
  });
});

// 헬스체크 (배포 플랫폼용)
app.get('/health', (req, res) => {
  const stats = {};
  Object.keys(centerData).forEach(c => {
    stats[c] = centerData[c].users.size;
  });
  res.json({ status: 'ok', centers: stats });
});

// ==================== 매일 오후 8시 30분 자동 초기화 ====================
// 텍스트 채팅은 매일 비우고, 이미지/파일은 7일간 보관 후 자동 삭제합니다.
// 센터 설정/비밀번호/기능은 그대로 유지합니다.

const IMAGE_RETENTION_DAYS = 7; // 이미지 보관 기간 (일)

let lastResetDate = null; // 같은 날 중복 초기화 방지

// Cloudinary에서 파일 삭제 (7일 지난 파일 정리 + 수동 삭제용)
// API Key/Secret이 환경변수에 있을 때만 작동
// resourceType: 'image'(사진) 또는 'raw'(문서 파일)
async function deleteFromCloudinary(publicId, resourceType) {
  if (!publicId) return;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return; // 설정 없으면 건너뜀 (URL만 만료)

  const rt = (resourceType === 'raw') ? 'raw' : 'image';

  try {
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary 삭제 서명 생성
    const signature = crypto
      .createHash('sha1')
      .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
      .digest('hex');

    const params = new URLSearchParams({
      public_id: publicId,
      timestamp: String(timestamp),
      api_key: apiKey,
      signature: signature
    });

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${rt}/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const result = await res.json();
    if (result.result === 'ok') {
      console.log(`🗑️  Cloudinary 삭제: ${publicId} (${rt})`);
    }
  } catch (err) {
    console.error(`❌ Cloudinary 삭제 실패 (${publicId}):`, err.message);
  }
}

function clearAllChats() {
  let clearedCenters = 0;
  let keptFiles = 0;
  const now = Date.now();
  const retentionMs = IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  Object.keys(centerData).forEach(centerName => {
    const data = centerData[centerName];

    // 이미지/파일 중 7일 안 지난 것만 남기고, 나머지(텍스트 + 7일 지난 파일)는 제거
    const kept = [];
    data.messageHistory.forEach(msg => {
      if ((msg.type === 'image' || msg.type === 'file') && !msg.deleted) {
        const age = now - new Date(msg.timestamp).getTime();
        if (age < retentionMs) {
          // 7일 안 지난 파일 → 유지
          kept.push(msg);
          keptFiles++;
        } else {
          // 7일 지난 파일 → Cloudinary에서도 삭제
          deleteFromCloudinary(msg.publicId, msg.resourceType || (msg.type === 'image' ? 'image' : 'raw'));
        }
      }
      // 텍스트/시스템 메시지, 삭제된 메시지는 kept에 안 넣음 = 제거됨
    });

    data.messageHistory = kept;
    clearedCenters++;

    // 현재 접속 중인 사용자들에게 갱신된 기록 전송 (파일만 남은 상태)
    io.to(centerName).emit('history', kept);
  });

  const nowStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`🧹 [자동 초기화] ${nowStr} - ${clearedCenters}개 센터 텍스트 초기화 완료 (보관 중인 파일: ${keptFiles}개)`);
}

// 1분마다 한국 시간을 확인하여 오후 8시 30분에 초기화
function checkAutoReset() {
  // 한국 시간(KST, UTC+9) 계산
  const now = new Date();
  const kstString = now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' });
  const kst = new Date(kstString);

  const hour = kst.getHours();
  const minute = kst.getMinutes();
  const today = `${kst.getFullYear()}-${kst.getMonth() + 1}-${kst.getDate()}`;

  // 오후 8시 30분(20:30~20:34)이고, 오늘 아직 초기화 안 했으면 실행
  // (1분마다 체크하므로 20시 30분에 확실히 걸림)
  if (hour === 20 && minute >= 30 && minute < 35 && lastResetDate !== today) {
    lastResetDate = today;
    clearAllChats();
  }
}

// 60초(1분)마다 시간 체크
setInterval(checkAutoReset, 60 * 1000);

console.log('⏰ 자동 초기화 설정됨: 매일 오후 8시 30분 (한국 시간) 채팅 초기화');

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Qaid 채팅 서버 실행 중: http://localhost:${PORT}`);
  console.log(`📍 지원 센터: ${CENTERS.length}개`);
});
