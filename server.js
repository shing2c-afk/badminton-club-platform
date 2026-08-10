const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 정적 파일 제공 (public 폴더 내 admin.html, tv.html, index.html 배치)
app.use(express.static(path.join(__dirname, 'public')));

// 라우팅 설정
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/tv', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 1. 서버 인메모리 데이터 상태 관리
// ==========================================
let config = {
    ENTRY_TIMEOUT_SEC: 180,       // 입장 대기 제한시간 (3분)
    NANTA_COURT_LIMIT_SEC: 900,   // 난타 코트 제한시간 (15분)
    ADMIN_PASSWORD: '1234'        // 관리자 비밀번호
};

// 코트 기본 데이터 (8개 코트)
let courtsData = [
    { id: 1, type: 'game', isEmpty: true, players: '', note: '' },
    { id: 2, type: 'game', isEmpty: true, players: '', note: '' },
    { id: 3, type: 'game', isEmpty: true, players: '', note: '' },
    { id: 4, type: 'game', isEmpty: true, players: '', note: '' },
    { id: 5, type: 'game', isEmpty: true, players: '', note: '' },
    { 
        id: 6, 
        type: 'nanta', 
        sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
        sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
        note: '' 
    },
    { 
        id: 7, 
        type: 'nanta', 
        sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
        sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
        note: '' 
    },
    { id: 8, type: 'lesson', isEmpty: false, players: '오후 레슨 전용 코트', note: '' }
];

let gameQueue = [];    // 게임 대기 방 목록
let nantaQueue = [];   // 난타 대기 방 목록
let notifications = []; // 회원 이벤트 알림 내역

let slotIdCounter = 1;

// ==========================================
// 2. 유틸리티 및 브로드캐스트 함수
// ==========================================

function broadcastState() {
    io.emit('stateUpdated', {
        config: config,
        courtsData: courtsData,
        gameQueue: gameQueue,
        nantaQueue: nantaQueue,
        notifications: notifications
    });
}

function addNotification(message) {
    const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    notifications.unshift({ message, time: timeStr });
    if (notifications.length > 30) notifications.pop(); // 최대 30개 보존
}

function getValidPlayers(playersArr) {
    return (playersArr || []).filter(p => p && p.trim() !== '');
}

// 1초마다 타이머 및 제한시간 체크
setInterval(() => {
    const now = Date.now();
    let isUpdated = false;

   // A. 게임 대기 방 입장 제한 타이머 체크
    // 1. 현재 사용 가능한 빈 게임 코트의 개수 파악
    const emptyGameCourtsCount = courtsData.filter(c => c.type === 'game' && c.isEmpty).length;
    
    // 2. 인원이 4명 꽉 찬 슬롯들 중에서 앞에서부터 빈 코트 개수만큼만 타이머를 돌리기 위한 카운터
    let activeTimerCount = 0;

    gameQueue.forEach((slot) => {
        const validCount = getValidPlayers(slot.players).length;
        
        // 인원이 4명이 채워져 있고, 아직 빈 코트 허용 개수만큼 타이머가 할당되지 않았다면!
        if (validCount === 4 && activeTimerCount < emptyGameCourtsCount) {
            activeTimerCount++; // 타이머 할당 개수 증가
            
            if (!slot.fullAt) {
                slot.fullAt = now;
            }
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            if (slot.remainingSeconds === 0) {
                const targetIdx = gameQueue.findIndex(s => s.id === slot.id);
                if (targetIdx !== -1) {
                    const expiredTeam = gameQueue.splice(targetIdx, 1)[0];
                    
                    // 시간 초기화 후 맨 뒤로 배치
                    expiredTeam.fullAt = null;
                    expiredTeam.remainingSeconds = null;
                    gameQueue.push(expiredTeam);

                    addNotification(`⏰ [게임대기] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열 맨 뒤로 이동되었습니다.`);
                    isUpdated = true;
                }
            }
        } else {
            // 4명이 아니거나, 이미 빈 코트 수만큼 앞서서 타이머가 다 차서 밀려난 4인 팀은 타이머 초기화 (대기 유지)
            slot.fullAt = null;
            slot.remainingSeconds = null;
        }
    });

   // B. 난타 대기 방 입장 제한 타이머 체크
    // 1. 현재 사용 가능한 빈 난타 코트(또는 반코트)의 총 개수 파악
    // (프로젝트의 난타 코트 구조에 맞춰 빈 코트 또는 빈 면의 개수를 세는 로직을 사용합니다)
    // 예시: type이 'nanta'이면서 isEmpty이거나, 혹은 A/B 반코트가 비어있는 총 개수를 계산
    let emptyNantaSlotsCount = 0;
    courtsData.forEach(court => {
        if (court.type === 'nanta') {
            if (court.isEmpty) {
                emptyNantaSlotsCount += 2; // 난타 코트 통째로 비어있으면 반코트 2개 분량
            } else {
                if (court.sideA && court.sideA.isEmpty) emptyNantaSlotsCount++;
                if (court.sideB && court.sideB.isEmpty) emptyNantaSlotsCount++;
            }
        }
    });

    // 2. 앞에서부터 빈 난타 코트(면) 개수까지만 타이머를 돌리기 위한 카운터
    let activeNantaTimerCount = 0;

    nantaQueue.forEach(slot => {
        const validCount = getValidPlayers(slot.players).length;
        
        // 인원이 2명이 채워져 있고, 아직 빈 난타 코트(면) 허용 개수만큼 타이머가 할당되지 않았다면!
        if (validCount === 2 && activeNantaTimerCount < emptyNantaSlotsCount) {
            activeNantaTimerCount++; // 타이머 할당 개수 증가
            
            if (!slot.fullAt) {
                slot.fullAt = now;
            }
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            if (slot.remainingSeconds === 0) {
                const index = nantaQueue.findIndex(s => s.id === slot.id);
                if (index !== -1) {
                    const expiredTeam = nantaQueue.splice(index, 1)[0];
                    
                    // 시간 초기화 후 맨 뒤로 배치
                    expiredTeam.fullAt = null;
                    expiredTeam.remainingSeconds = null;
                    nantaQueue.push(expiredTeam);

                    addNotification(`⏰ [난타대기] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열 맨 뒤로 이동되었습니다.`);
                    isUpdated = true;
                }
            }
        } else {
            // 인원이 부족하거나, 빈 난타 코트 수보다 순위가 밀려서 타이머 허용치를 초과한 팀은 초기화
            slot.fullAt = null;
            slot.remainingSeconds = null;
        }
    });
    
   // C. 난타 코트 잔여시간 (A/B 반코트) 체크
courtsData.forEach(court => {
    if (court.type === 'nanta') {
        ['sideA', 'sideB'].forEach(side => {
            if (court[side] && !court[side].isEmpty && court[side].startTime) {
                const elapsed = Math.floor((now - court[side].startTime) / 1000);
                court[side].remainingSeconds = Math.max(0, config.NANTA_COURT_LIMIT_SEC - elapsed);

                if (court[side].remainingSeconds === 0) {
                    const exitedPlayers = court[side].players;
                    court[side] = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                    addNotification(`🔔 [난타종료] ${court.id}번 코트 (${side === 'sideA' ? 'A' : 'B'}면)${exitedPlayers} 난타 시간이 종료되었습니다.`);
                    isUpdated = true;

                    // [추가] 양쪽 다 비었는지 확인 후 nextType으로 자동 전환
                    const isBothEmpty = (!court.sideA || court.sideA.isEmpty) && (!court.sideB || court.sideB.isEmpty);
                    if (isBothEmpty && court.nextType && court.nextType !== 'nanta') {
                        const applyType = court.nextType;
                        court.type = applyType;

                        if (applyType === 'lesson') {
                            court.isEmpty = false;
                            court.players = court.note || '레슨 코트';
                            delete court.sideA;
                            delete court.sideB;
                        } else {
                            court.isEmpty = true;
                            court.players = '';
                            delete court.sideA;
                            delete court.sideB;
                        }
                        court.nextType = applyType;
                    }
                }
            }
        });
    }
});

    // 초 단위 실시간 전송 (타이머 동기화)
    broadcastState();
}, 1000);

// ==========================================
// 3. Socket.IO 이벤트 핸들링
// ==========================================
io.on('connection', (socket) => {
    // 초기 접속 시 전달
    socket.emit('stateUpdated', {
        config: config,
        courtsData: courtsData,
        gameQueue: gameQueue,
        nantaQueue: nantaQueue,
        notifications: notifications
    });

    // 비밀번호 검증
    socket.on('verifyAdminPassword', (inputPw, callback) => {
        if (typeof callback === 'function') {
            if (inputPw === config.ADMIN_PASSWORD) {
                callback({ success: true });
            } else {
                callback({ success: false });
            }
        }
    });

  // 환경 설정 변경 저장
    socket.on('updateConfig', (newConfig) => {
        try {
            if (newConfig) {
                if (newConfig.ENTRY_TIMEOUT_SEC !== undefined) config.ENTRY_TIMEOUT_SEC = newConfig.ENTRY_TIMEOUT_SEC;
                if (newConfig.NANTA_COURT_LIMIT_SEC !== undefined) config.NANTA_COURT_LIMIT_SEC = newConfig.NANTA_COURT_LIMIT_SEC;
                if (newConfig.ADMIN_PASSWORD !== undefined && newConfig.ADMIN_PASSWORD.trim() !== '') {
                    config.ADMIN_PASSWORD = newConfig.ADMIN_PASSWORD;
                }
            }
            broadcastState();
        } catch (err) {
            console.error('환경 설정 변경 에러:', err);
        }
    });

    // 관리자 비밀번호 변경
    socket.on('updatePassword', (newPassword) => {
        try {
            if (newPassword) {
                config.ADMIN_PASSWORD = newPassword; 
            }
            broadcastState();
        } catch (err) {
            console.error('비밀번호 변경 에러:', err);
        }
    });

 // 관리자 - 코트 구성 변경
    socket.on('updateCourtsConfig', (newCourtsConfig) => {
        try {
            if (!Array.isArray(newCourtsConfig)) return;

            courtsData = newCourtsConfig.map((court, idx) => {
                const id = idx + 1;
                const targetType = court ? (court.type || 'game') : 'game';
                const targetNote = court ? (court.note || '') : '';
                
                const existingCourt = courtsData.find(c => c.id === id);

                // 1. 일반 게임 코트가 사용 중인지 확인
                const isGameActive = existingCourt && 
                    existingCourt.type === 'game' && 
                    !existingCourt.isEmpty && 
                    existingCourt.players && 
                    existingCourt.players.trim() !== '';

                // 2. 난타 코트의 A면 또는 B면에 플레이어가 있는지 확인
                const isNantaActive = existingCourt && 
                    existingCourt.type === 'nanta' && 
                    ((existingCourt.sideA && !existingCourt.sideA.isEmpty) || 
                     (existingCourt.sideB && !existingCourt.sideB.isEmpty));

                // 둘 중 하나라도 사용 중이라면 즉시 변경하면 안 됨!
                const isInUse = isGameActive || isNantaActive;

                // 사용 중이 아니라면 (레슨 코트, 빈 게임 코트, 빈 난타 코트 등) 즉시 변경 적용
                if (!isInUse) {
                    if (targetType === 'nanta') {
                        return { 
                            id, 
                            type: 'nanta', 
                            nextType: 'nanta', 
                            note: targetNote,
                            sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                            sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 } 
                        };
                    } else if (targetType === 'lesson') {
                        return { 
                            id, 
                            type: 'lesson', 
                            nextType: 'lesson', 
                            isEmpty: false, 
                            players: targetNote || '레슨 코트', 
                            note: targetNote 
                        };
                    } else {
                        return { 
                            id, 
                            type: 'game', 
                            nextType: 'game', 
                            isEmpty: true, 
                            players: '', 
                            note: targetNote 
                        };
                    }
                }

                // 현재 플레이어가 게임/난타 중인 코트라면 다음 종료 시점에 바뀌도록 nextType에 예약
                return {
                    ...existingCourt,
                    nextType: targetType,
                    note: targetNote
                };
            });
            broadcastState();
        } catch (err) {
            console.error('코트 설정 변경 에러:', err);
        }
    });

    // 방 개설 (게임 4명, 난타 2명)
    socket.on('createSlot', ({ type, user }) => {
        const newSlot = {
            id: 'slot_' + (slotIdCounter++),
            type: type,
            players: type === 'game' ? [user, '', '', ''] : [user, ''],
            createdAt: Date.now(),
            fullAt: null,
            remainingSeconds: null
        };

        if (type === 'game') gameQueue.push(newSlot);
        else nantaQueue.push(newSlot);

        addNotification(`📢 [방 개설] 새로운 ${type === 'game' ? '게임' : '난타'} 방이 개설되었습니다 (${user}).`);
        broadcastState();
    });

    // 슬롯에 플레이어 참가
    socket.on('joinPlayer', ({ type, slotId, index, name }) => {
        const queue = type === 'game' ? gameQueue : nantaQueue;
        const slot = queue.find(s => s.id === slotId);
        if (slot && index >= 0 && index < slot.players.length) {
            slot.players[index] = name;
            addNotification(`👤 [참가] ${name} 님이 대기 방에 입장하셨습니다.`);
            broadcastState();
        }
    });

    // 플레이어 퇴장/제거
    socket.on('exitPlayer', ({ type, slotId, index }) => {
        const queue = type === 'game' ? gameQueue : nantaQueue;
        const slotIdx = queue.findIndex(s => s.id === slotId);

        if (slotIdx !== -1) {
            const slot = queue[slotIdx];
            slot.players[index] = '';
            
            if (getValidPlayers(slot.players).length === 0) {
                queue.splice(slotIdx, 1);
            }
            broadcastState();
        }
    });

    // 게임 방 통합
    socket.on('mergeSlot', ({ mySlotId, targetSlotId }) => {
        const mySlot = gameQueue.find(s => s.id === mySlotId);
        const targetSlot = gameQueue.find(s => s.id === targetSlotId);

        if (mySlot && targetSlot) {
            const myPlayers = getValidPlayers(mySlot.players);
            const targetPlayers = getValidPlayers(targetSlot.players);

            if (myPlayers.length + targetPlayers.length <= 4) {
                const combined = [...targetPlayers, ...myPlayers];
                targetSlot.players = [
                    combined[0] || '',
                    combined[1] || '',
                    combined[2] || '',
                    combined[3] || ''
                ];
                gameQueue = gameQueue.filter(s => s.id !== mySlotId);
                addNotification(`🤝 [방 통합] 대기 팀이 하나로 통합되었습니다.`);
                broadcastState();
            }
        }
    });

    // 게임 코트 입장
    socket.on('enterGameCourt', (slotId) => {
        const slotIdx = gameQueue.findIndex(s => s.id === slotId);
        if (slotIdx === -1) return;

        const slot = gameQueue[slotIdx];
        const emptyCourt = courtsData.find(c => c.type === 'game' && c.isEmpty);

        if (emptyCourt) {
            emptyCourt.isEmpty = false;
            emptyCourt.players = getValidPlayers(slot.players).join(', ');
            gameQueue.splice(slotIdx, 1);

            addNotification(`🏸 [코트입장] ${emptyCourt.id}번 코트에 ${emptyCourt.players} 팀이 입장하셨습니다.`);
            broadcastState();
        }
    });

    // 게임 코트 종료
    socket.on('endGameCourt', (courtId) => {
        const court = courtsData.find(c => c.id === courtId);
        if (court) {
            addNotification(`🏁 [게임종료] ${court.id}번 코트 경기가 종료되었습니다.`);
            
            const applyType = court.nextType || court.type || 'game';
            court.type = applyType;

            if (applyType === 'nanta') {
                court.isEmpty = true;
                court.players = '';
                court.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                court.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            } else if (applyType === 'lesson') {
                court.isEmpty = false;
                court.players = court.note || '레슨 코트';
                delete court.sideA;
                delete court.sideB;
            } else {
                court.isEmpty = true;
                court.players = '';
                delete court.sideA;
                delete court.sideB;
            }
            
            broadcastState();
        }
    });

    // 게임 코트 한 게임 더 (재입장)
    socket.on('againGameCourt', (courtId) => {
        const court = courtsData.find(c => c.id === courtId);
        if (court && !court.isEmpty && court.type === 'game') {
            const playersArr = court.players ? court.players.split(', ') : [];
            const newSlot = {
                id: 'slot_' + (slotIdCounter++),
                type: 'game',
                players: [playersArr[0] || '', playersArr[1] || '', playersArr[2] || '', playersArr[3] || ''],
                createdAt: Date.now(),
                fullAt: null,
                remainingSeconds: null
            };
            gameQueue.push(newSlot);
            
            const applyType = court.nextType || court.type || 'game';
            court.type = applyType;

            if (applyType === 'nanta') {
                court.isEmpty = true;
                court.players = '';
                court.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                court.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            } else if (applyType === 'lesson') {
                court.isEmpty = false;
                court.players = court.note || '레슨 코트';
                delete court.sideA;
                delete court.sideB;
            } else {
                court.isEmpty = true;
                court.players = '';
                delete court.sideA;
                delete court.sideB;
            }
            
            addNotification(`🔄 [한 게임 더] ${court.id}번 코트 팀이 연승/재대기를 신청하셨습니다.`);
            broadcastState();
        }
    });

    // 난타 코트 입장
    socket.on('enterNantaCourt', (slotId) => {
        const slotIdx = nantaQueue.findIndex(s => s.id === slotId);
        if (slotIdx === -1) return;

        const slot = nantaQueue[slotIdx];
        const validPlayers = getValidPlayers(slot.players).join(', ');

        for (let court of courtsData) {
            if (court.type === 'nanta') {
                if (court.sideA && court.sideA.isEmpty) {
                    court.sideA = {
                        isEmpty: false,
                        players: validPlayers,
                        startTime: Date.now(),
                        remainingSeconds: config.NANTA_COURT_LIMIT_SEC
                    };
                    nantaQueue.splice(slotIdx, 1);
                    addNotification(`🏸 [난타입장] ${court.id}번 코트 (A면)에 ${validPlayers} 입장!`);
                    broadcastState();
                    return;
                } else if (court.sideB && court.sideB.isEmpty) {
                    court.sideB = {
                        isEmpty: false,
                        players: validPlayers,
                        startTime: Date.now(),
                        remainingSeconds: config.NANTA_COURT_LIMIT_SEC
                    };
                    nantaQueue.splice(slotIdx, 1);
                    addNotification(`🏸 [난타입장] ${court.id}번 코트 (B면)에 ${validPlayers} 입장!`);
                    broadcastState();
                    return;
                }
            }
        }
    });

    // 난타 코트 종료 (사이드별 또는 전체 종료)
    socket.on('endNantaCourt', ({ courtId, side }) => {
        const court = courtsData.find(c => c.id === courtId);
        if (court && court.type === 'nanta') {
            const sideKey = side === 'A' || side === 'sideA' ? 'sideA' : 'sideB';
            
            if (court[sideKey]) {
                court[sideKey] = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            }

            addNotification(`🏁 [난타종료] ${court.id}번 코트 ${sideKey === 'sideA' ? 'A' : 'B'}사이드 난타가 종료되었습니다.`);

            const isBothEmpty = (!court.sideA || court.sideA.isEmpty) && (!court.sideB || court.sideB.isEmpty);

            if (isBothEmpty && court.nextType && court.nextType !== 'nanta') {
                const applyType = court.nextType;
                court.type = applyType;

                if (applyType === 'lesson') {
                    court.isEmpty = false;
                    court.players = court.note || '레슨 코트';
                    delete court.sideA;
                    delete court.sideB;
                } else {
                    court.isEmpty = true;
                    court.players = '';
                    delete court.sideA;
                    delete court.sideB;
                }
            }

            broadcastState();
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ 접속 해제: ${socket.id}`);
    });
});

// server.js 파일 하단에 추가

// JSON 파싱 미들웨어가 없다면 상단 근처에 추가 확인: app.use(express.json());

// 더미 회원 데이터 (badminton.db 연동 전 테스트용)
const dummyUsers = [
  { id: "user1", name: "김민턴", role: "member", club: "파주 클럽" },
  { id: "user2", name: "이민턴", role: "member", club: "운정 클럽" },
  { id: "admin", name: "관리자", role: "admin", club: "운영진" }
];

// 1. 더미 회원 목록 반환 API
app.get('/api/users/dummy', (req, res) => {
  res.json({ success: true, users: dummyUsers });
});

// server.js 하단 로그인 API
app.post('/api/login', (req, res) => {
  // body 데이터 유효성 검사
  const username = req.body?.username;
  const password = req.body?.password;

  if (!username) {
    return res.status(400).json({ success: false, message: "아이디를 입력해주세요." });
  }

  const user = dummyUsers.find(u => u.id === username);

  if (user) {
    res.json({ success: true, message: "로그인 성공", user });
  } else {
    res.status(401).json({ success: false, message: "존재하지 않는 회원 아이디입니다." });
  }
});

// ==========================
// 4. 서버 실행
// ==========================
server.listen(PORT, () => {
    console.log(`🚀 운정배드민턴클럽 경기 운영 서버 실행 중: http://localhost:${PORT}`);
    console.log(`📱 사용자 화면: http://localhost:${PORT}`);
    console.log(`🖥️ 관리자 모드: http://localhost:${PORT}/admin`);
    console.log(`📺 현장 전광판: http://localhost:${PORT}/tv`);
});