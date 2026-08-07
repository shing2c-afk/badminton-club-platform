const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
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
    gameQueue.forEach(slot => {
        const validCount = getValidPlayers(slot.players).length;
        if (validCount === 4) {
            if (!slot.fullAt) {
                slot.fullAt = now;
            }
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            // 시간 초과 시 대기 취소 처리
            if (slot.remainingSeconds === 0) {
                gameQueue = gameQueue.filter(s => s.id !== slot.id);
                addNotification(`⏰ [게임대기] ${slot.players.join(', ')} 팀이 입장 시간 초과로 취소되었습니다.`);
                isUpdated = true;
            }
        } else {
            slot.fullAt = null;
            slot.remainingSeconds = null;
        }
    });

    // B. 난타 대기 방 입장 제한 타이머 체크
    nantaQueue.forEach(slot => {
        const validCount = getValidPlayers(slot.players).length;
        if (validCount === 2) {
            if (!slot.fullAt) {
                slot.fullAt = now;
            }
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            if (slot.remainingSeconds === 0) {
                nantaQueue = nantaQueue.filter(s => s.id !== slot.id);
                addNotification(`⏰ [난타대기] ${slot.players.join(', ')} 팀이 입장 시간 초과로 취소되었습니다.`);
                isUpdated = true;
            }
        } else {
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

    // 관리자 - 환경 설정 변경
    socket.on('updateConfig', (newConfig) => {
        if (newConfig) {
            config.ENTRY_TIMEOUT_SEC = Number(newConfig.ENTRY_TIMEOUT_SEC) || 180;
            config.NANTA_COURT_LIMIT_SEC = Number(newConfig.NANTA_COURT_LIMIT_SEC) || 900;
            if (newConfig.ADMIN_PASSWORD) config.ADMIN_PASSWORD = String(newConfig.ADMIN_PASSWORD);
            broadcastState();
        }
    });

    // 관리자 - 코트 구성 변경
    socket.on('updateCourtsConfig', (newCourtsConfig) => {
        if (Array.isArray(newCourtsConfig)) {
            courtsData = newCourtsConfig.map((court, idx) => {
                const id = idx + 1;
                const type = court.type || 'game';
                if (type === 'nanta') {
                    return {
                        id, type, note: court.note || '',
                        sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                        sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 }
                    };
                } else if (type === 'lesson') {
                    return { id, type, isEmpty: false, players: court.note || '레슨 코트', note: court.note || '' };
                } else {
                    return { id, type: 'game', isEmpty: true, players: '', note: court.note || '' };
                }
            });
            broadcastState();
        }
    });

    // ------------------------------------------
    // 사용자 앱 (`index.html`) 요청 처리
    // ------------------------------------------

    // 방 개설 (게임 4명, 난타 2명)
    socket.on('createSlot', ({ type, user }) => {
        const newSlot = {
            id: 'slot_' + (slotIdCounter++),
            type: type, // 'game' or 'nanta'
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
            
            // 방 전체가 비었으면 방 삭제
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
                // 기존 내 방은 삭제
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
            gameQueue.splice(slotIdx, 1); // 대기목록 제거

            addNotification(`🏸 [코트입장] ${emptyCourt.id}번 코트에 ${emptyCourt.players} 팀이 입장하셨습니다.`);
            broadcastState();
        }
    });

    // 게임 코트 종료
    socket.on('clickEnd', (courtId) => {
        const court = courtsData.find(c => c.id === courtId);
        if (court) {
            addNotification(`🏁 [게임종료] ${court.id}번 코트 경기가 종료되었습니다.`);
            court.isEmpty = true;
            court.players = '';
            broadcastState();
        }
    });

    // 게임 코트 한 게임 더 (재입장)
    socket.on('clickAgain', (courtId) => {
        const court = courtsData.find(c => c.id === courtId);
        if (court && !court.isEmpty) {
            // 해당 참가자들을 게임 대기열 최우선(1순위)으로 다시 등록
            const playersArr = court.players.split(', ');
            const newSlot = {
                id: 'slot_' + (slotIdCounter++),
                type: 'game',
                players: [playersArr[0] || '', playersArr[1] || '', playersArr[2] || '', playersArr[3] || ''],
                createdAt: Date.now(),
                fullAt: null,
                remainingSeconds: null
            };
            gameQueue.unshift(newSlot); // 최우선 배치

            court.isEmpty = true;
            court.players = '';
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

        // 빈 난타 반코트(A면 또는 B면) 탐색
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

    // 난타 종료
    socket.on('clickNantaEnd', ({ courtId, side }) => {
        const court = courtsData.find(c => c.id === courtId);
        if (court && court[side]) {
            court[side] = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            addNotification(`🏁 [난타종료] ${courtId}번 코트 (${side === 'sideA' ? 'A' : 'B'}면) 퇴장 처리되었습니다.`);
            broadcastState();
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ 접속 해제: ${socket.id}`);
    });
});

// ==========================================
// 4. 서버 실행
// ==========================================
server.listen(PORT, () => {
    console.log(`🚀 운정배드민턴클럽 경기 운영 서버 실행 중: http://localhost:${PORT}`);
    console.log(`📱 사용자 화면: http://localhost:${PORT}`);
    console.log(`🖥️  관리자 모드: http://localhost:${PORT}/admin`);
    console.log(`📺 현장 전광판: http://localhost:${PORT}/tv`);
});