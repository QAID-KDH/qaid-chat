// Apple 서비스센터 실시간 채팅 서버 (멀티 센터 지원)
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

// 센터 목록 제공 API (클라이언트에서 불러감)
app.get('/api/centers', (req, res) => {
  res.json(CENTERS);
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
  if (data.messageHistory.length > MAX_HISTORY) {
    data.messageHistory.shift();
  }
}

// 소켓별 센터 정보 저장
const socketCenter = new Map(); // socketId -> centerName

io.on('connection', (socket) => {
  console.log(`접속: ${socket.id}`);

  // 사용자 입장
  socket.on('join', ({ name, role, center }) => {
    // 유효한 센터인지 검증
    if (!CENTERS.includes(center)) {
      socket.emit('error', '유효하지 않은 센터입니다.');
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
      text: `${role === 'repair' ? '🔧 수리실' : '💬 응대실'} ${name}님이 입장했습니다.`,
      timestamp: new Date().toISOString()
    };
    io.to(center).emit('message', joinMessage);
    addToHistory(center, joinMessage);

    console.log(`[${center}] ${name}(${role}) 입장`);
  });

  // 메시지 수신
  socket.on('message', (text) => {
    const center = socketCenter.get(socket.id);
    if (!center) return;
    const data = getCenterData(center);
    const user = data.users.get(socket.id);
    if (!user || !text || !text.trim()) return;

    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      type: 'chat',
      name: user.name,
      role: user.role,
      text: text.trim(),
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
          text: `${user.role === 'repair' ? '🔧 수리실' : '💬 응대실'} ${user.name}님이 퇴장했습니다.`,
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Qaid 채팅 서버 실행 중: http://localhost:${PORT}`);
  console.log(`📍 지원 센터: ${CENTERS.length}개`);
});
