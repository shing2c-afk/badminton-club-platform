const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));
app.use(express.json());

// 1. 관리자 설정값 (내부적으로는 초 단위 관리)
let globalConfig = {
    ENTRY_TIMEOUT_SEC: 180,       // 기본 3분 (180초)
    NANTA_COURT_LIMIT_SEC: 900,   // 기본 15분 (900초)
    ENABLE_ALERT: true,
    ADMIN_PASSWORD: '1234'        // 관리자 비밀번호 (기본값)
};

// 2. 전체 공유 데이터 (초기 코트 설정: vacatedAt을 0으로 설정하여 초기 배정 시 id 순서대로 배정)
let courtsData = [
    { id: 1, type: 'game', label: '게임 코트', isEmpty: true, players: '', vacatedAt: 0 },
    { id: 2, type: 'game', label: '게임 코트', isEmpty: true, players: '', vacatedAt: 0 },
    { id: 3, type: 'game', label: '게임 코트', isEmpty: true, players: '', vacatedAt: 0 },
    { id: 4, type: 'game', label: '게임 코트', isEmpty: true, players: '', vacatedAt: 0 },
    { id: 5, type: 'game', label: '게임 코트', isEmpty: true, players: '', vacatedAt: 0 },
    { 
        id: 6, type: 'nanta', label: '난타 코트', 
        sideA: { isEmpty: true, players: '', remainingSeconds: 0, vacatedAt: 0 },
        sideB: { isEmpty: true, players: '', remainingSeconds: 0, vacatedAt: 0 }
    },
    { 
        id: 7, type: 'nanta', label: '난타 코트', 
        sideA: { isEmpty: true, players: '', remainingSeconds: 0, vacatedAt: 0 },
        sideB: { isEmpty: true, players: '', remainingSeconds: 0, vacatedAt: 0 }
    },
    { id: 8, type: 'lesson', label: '레슨 코트', isEmpty: false, players: '코치 전용 레슨 코트' }
];

let gameQueue = [];
let nantaQueue = [];

// 회원별 이벤트 알림 내역 저장용 배열
let eventNotifications = [];

// 전체 디바이스로 최신 상태 방송
function broadcastState() {
    io.emit('stateUpdated', {
        config: globalConfig,
        courtsData: courtsData,
        gameQueue: gameQueue,
        nantaQueue: nantaQueue,
        notifications: eventNotifications
    });
}

function addNotification(msg) {
    const newNoti = {
        id: Date.now(),
        message: msg,
        time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
    eventNotifications.unshift(newNoti);
    if (eventNotifications.length > 30) eventNotifications.pop(); // 최근 30개 유지
}

// 1초 단위 서버 타이머
setInterval(() => {
    let needUpdate = false;

    // 난타 코트 타이머 차감
    courtsData.forEach(court => {
        if (court.type === 'nanta') {
            ['sideA', 'sideB'].forEach(side => {
                if (court[side] && !court[side].isEmpty && court[side].remainingSeconds > 0) {
                    court[side].remainingSeconds--;
                    needUpdate = true;
                    if (court[side].remainingSeconds === 0) {
                        court[side].isEmpty = true;
                        court[side].players = '';
                        court[side].vacatedAt = Date.now();
                        const alertMsg = `📢 ${court.id}번 코트 [${side === 'sideA' ? 'A' : 'B'} 반코트] 난타 제한시간이 종료되었습니다.`;
                        io.emit('toastAlert', alertMsg);
                        addNotification(alertMsg);
                    }
                }
            });
        }
    });

    // 게임 대기줄 타이머 차감
    const emptyGameCount = courtsData.filter(c => c.type === 'game' && c.isEmpty).length;
    let activeGameQuota = emptyGameCount;

    for (let i = 0; i < gameQueue.length; i++) {
        const slot = gameQueue[i];
        const validCount = slot.players.filter(p => p && p.trim() !== '').length;

        if (validCount === 4 && activeGameQuota > 0) {
            activeGameQuota--;
            if (slot.remainingSeconds === null) {
                slot.remainingSeconds = globalConfig.ENTRY_TIMEOUT_SEC;
                needUpdate = true;
            } else if (slot.remainingSeconds > 0) {
                slot.remainingSeconds--;
                needUpdate = true;
            } else if (slot.remainingSeconds <= 0) {
                const timeoutMsg = `⏰ [게임 ${i + 1}순위] 입장 제한시간 초과로 맨 뒤 순위로 이동했습니다.`;
                if (globalConfig.ENABLE_ALERT) {
                    io.emit('toastAlert', timeoutMsg);
                    addNotification(timeoutMsg);
                }
                slot.remainingSeconds = null;
                const timeoutSlot = gameQueue.splice(i, 1)[0];
                gameQueue.push(timeoutSlot);
                needUpdate = true;
                break;
            }
        } else {
            if (slot.remainingSeconds !== null) {
                slot.remainingSeconds = null;
                needUpdate = true;
            }
        }
    }

    // 난타 대기줄 타이머 차감
    let emptyNantaCount = 0;
    courtsData.forEach(c => {
        if (c.type === 'nanta') {
            if (c.sideA && c.sideA.isEmpty) emptyNantaCount += 1;
            if (c.sideB && c.sideB.isEmpty) emptyNantaCount += 1;
        }
    });
    let activeNantaQuota = emptyNantaCount;

    for (let i = 0; i < nantaQueue.length; i++) {
        const slot = nantaQueue[i];
        const validCount = slot.players.filter(p => p && p.trim() !== '').length;

        if (validCount === 2 && activeNantaQuota > 0) {
            activeNantaQuota--;
            if (slot.remainingSeconds === null) {
                slot.remainingSeconds = globalConfig.ENTRY_TIMEOUT_SEC;
                needUpdate = true;
            } else if (slot.remainingSeconds > 0) {
                slot.remainingSeconds--;
                needUpdate = true;
            } else if (slot.remainingSeconds <= 0) {
                const timeoutMsg = `⏰ [난타 ${i + 1}순위] 입장 제한시간 초과로 맨 뒤 순위로 이동했습니다.`;
                if (globalConfig.ENABLE_ALERT) {
                    io.emit('toastAlert', timeoutMsg);
                    addNotification(timeoutMsg);
                }
                slot.remainingSeconds = null;
                const timeoutSlot = nantaQueue.splice(i, 1)[0];
                nantaQueue.push(timeoutSlot);
                needUpdate = true;
                break;
            }
        } else {
            if (slot.remainingSeconds !== null) {
                slot.remainingSeconds = null;
                needUpdate = true;
            }
        }
    }

    if (needUpdate) {
        broadcastState();
    }
}, 1000);

// 소켓 연결 이벤트 처리
io.on('connection', (socket) => {
    socket.emit('initConfig', globalConfig);
    socket.emit('stateUpdated', {
        config: globalConfig,
        courtsData: courtsData,
        gameQueue: gameQueue,
        nantaQueue: nantaQueue,
        notifications: eventNotifications
    });

    socket.on('verifyAdminPassword', (pw, callback) => {
        if (pw === globalConfig.ADMIN_PASSWORD) {
            callback({ success: true });
        } else {
            callback({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    });

    // 1. 환경 설정 업데이트 (타이머 분/초, 비밀번호 등)
    socket.on('updateConfig', (newConfig) => {
        if (!newConfig) return;

        if (newConfig.ENTRY_TIMEOUT_SEC !== undefined && !isNaN(newConfig.ENTRY_TIMEOUT_SEC)) {
            newConfig.ENTRY_TIMEOUT_SEC = parseInt(newConfig.ENTRY_TIMEOUT_SEC, 10);
        }
        if (newConfig.NANTA_COURT_LIMIT_SEC !== undefined && !isNaN(newConfig.NANTA_COURT_LIMIT_SEC)) {
            newConfig.NANTA_COURT_LIMIT_SEC = parseInt(newConfig.NANTA_COURT_LIMIT_SEC, 10);
        }

        globalConfig = { ...globalConfig, ...newConfig };
        broadcastState();
    });

    // 2. 코트 구성 정보 (게임/난타/레슨 코트 종류 및 문구) 업데이트
    socket.on('updateCourtsConfig', (newCourtsList) => {
        if (!Array.isArray(newCourtsList)) return;

        let updatedCourts = [];

        newCourtsList.forEach((item, idx) => {
            const courtId = idx + 1;
            const existing = courtsData.find(c => c.id === courtId);

            if (item.type === 'game') {
                updatedCourts.push({
                    id: courtId,
                    type: 'game',
                    label: '게임 코트',
                    isEmpty: existing && existing.type === 'game' ? existing.isEmpty : true,
                    players: existing && existing.type === 'game' ? existing.players : '',
                    vacatedAt: existing ? existing.vacatedAt : 0
                });
            } else if (item.type === 'nanta') {
                const sideA = (existing && existing.type === 'nanta' && existing.sideA) 
                    ? existing.sideA 
                    : { isEmpty: true, players: '', remainingSeconds: 0, vacatedAt: 0 };
                const sideB = (existing && existing.type === 'nanta' && existing.sideB) 
                    ? existing.sideB 
                    : { isEmpty: true, players: '', remainingSeconds: 0, vacatedAt: 0 };

                updatedCourts.push({
                    id: courtId,
                    type: 'nanta',
                    label: '난타 코트',
                    sideA: sideA,
                    sideB: sideB
                });
            } else if (item.type === 'lesson') {
                updatedCourts.push({
                    id: courtId,
                    type: 'lesson',
                    label: '레슨 코트',
                    isEmpty: false,
                    players: item.note || (existing && existing.type === 'lesson' ? existing.players : '코치 전용 레슨 코트')
                });
            }
        });

        courtsData = updatedCourts;
        broadcastState();
    });

    socket.on('createSlot', (data) => {
        const newSlot = {
            id: (data.type === 'game' ? 'g_' : 'n_') + Date.now(),
            type: data.type,
            players: data.type === 'game' ? [data.user, '', '', ''] : [data.user, ''],
            remainingSeconds: null
        };

        if (data.type === 'game') {
            gameQueue.push(newSlot);
        } else {
            nantaQueue.push(newSlot);
        }
        broadcastState();
    });

    socket.on('joinPlayer', (data) => {
        const queue = data.type === 'game' ? gameQueue : nantaQueue;
        const slot = queue.find(s => s.id === data.slotId);
        if (slot) {
            slot.players[data.index] = data.name;
            broadcastState();
        }
    });

    socket.on('exitPlayer', (data) => {
        const queue = data.type === 'game' ? gameQueue : nantaQueue;
        const slotIndex = queue.findIndex(s => s.id === data.slotId);
        if (slotIndex !== -1) {
            const slot = queue[slotIndex];
            slot.players[data.index] = '';

            const valid = slot.players.filter(p => p && p.trim() !== '');
            if (valid.length === 0) {
                queue.splice(slotIndex, 1);
            } else {
                const max = data.type === 'game' ? 4 : 2;
                while (valid.length < max) valid.push('');
                slot.players = valid;
            }
            broadcastState();
        }
    });

    socket.on('mergeSlot', (data) => {
        const myIndex = gameQueue.findIndex(s => s.id === data.mySlotId);
        const targetIndex = gameQueue.findIndex(s => s.id === data.targetSlotId);

        if (myIndex !== -1 && targetIndex !== -1) {
            const mySlot = gameQueue[myIndex];
            const targetSlot = gameQueue[targetIndex];

            const myPlayers = mySlot.players.filter(p => p && p.trim() !== '');
            const targetPlayers = targetSlot.players.filter(p => p && p.trim() !== '');

            const merged = [...myPlayers, ...targetPlayers];
            const finalPlayers = merged.slice(0, 4);
            while (finalPlayers.length < 4) finalPlayers.push('');

            mySlot.players = finalPlayers;
            gameQueue.splice(targetIndex, 1);

            broadcastState();
        }
    });

    // 🎯 게임 코트 배정 (1. 비워진 시간 순 정렬 -> 2. 시간이 같으면 코트 ID 작은 순 정렬)
    socket.on('enterGameCourt', (slotId) => {
        const emptyCourts = courtsData.filter(c => c.type === 'game' && c.isEmpty);
        if (emptyCourts.length === 0) return;

        const readySlots = gameQueue.filter(s => {
            const valid = s.players.filter(p => p && p.trim() !== '');
            return valid.length === 4;
        });

        const allowedSlots = readySlots.slice(0, emptyCourts.length);
        const targetSlot = allowedSlots.find(s => s.id === slotId);

        if (!targetSlot) return;

        const valid = targetSlot.players.filter(p => p && p.trim() !== '');

        // 정렬 조건: vacatedAt(비워진 시간) 오름차순, 비워진 시간이 같으면 id(코트 번호) 오름차순
        emptyCourts.sort((a, b) => {
            if (a.vacatedAt === b.vacatedAt) {
                return a.id - b.id; // 코트 번호 1, 2, 3... 순서
            }
            return a.vacatedAt - b.vacatedAt; // 먼저 비워진 코트 순서
        });

        const targetCourt = emptyCourts[0];

        targetCourt.isEmpty = false;
        targetCourt.players =`${valid[0]}, ${valid[1]}, ${valid[2]}, ${valid[3]}`;

        const targetIndex = gameQueue.findIndex(s => s.id === slotId);
        if (targetIndex !== -1) {
            gameQueue.splice(targetIndex, 1);
        }

        broadcastState();
    });

    // 🎯 난타 코트 배정 (1. 비워진 시간 순 정렬 -> 2. 시간이 같으면 코트 ID/SideA 우선 정렬)
    socket.on('enterNantaCourt', (slotId) => {
        let emptySides = [];
        courtsData.forEach(c => {
            if (c.type === 'nanta') {
                if (c.sideA.isEmpty) emptySides.push({ court: c, side: 'sideA', vacatedAt: c.sideA.vacatedAt });
                if (c.sideB.isEmpty) emptySides.push({ court: c, side: 'sideB', vacatedAt: c.sideB.vacatedAt });
            }
        });

        if (emptySides.length === 0) return;

        const readySlots = nantaQueue.filter(s => {
            const valid = s.players.filter(p => p && p.trim() !== '');
            return valid.length === 2;
        });

        const allowedSlots = readySlots.slice(0, emptySides.length);
        const targetSlot = allowedSlots.find(s => s.id === slotId);

        if (!targetSlot) return;

        const valid = targetSlot.players.filter(p => p && p.trim() !== '');

        // 정렬 조건: vacatedAt(비워진 시간) 오름차순, 비워진 시간이 같으면 코트 ID 오름차순 및 sideA 우선
        emptySides.sort((a, b) => {
            if (a.vacatedAt === b.vacatedAt) {
                if (a.court.id === b.court.id) {
                    return a.side === 'sideA' ? -1 : 1; // 동일 코트라면 sideA 우선
                }
                return a.court.id - b.court.id; // 코트 번호 순서
            }
            return a.vacatedAt - b.vacatedAt; // 먼저 비워진 코트 순서
        });

        const oldest = emptySides[0];

        oldest.court[oldest.side].isEmpty = false;
        oldest.court[oldest.side].players = valid.join(', ');
        oldest.court[oldest.side].remainingSeconds = globalConfig.NANTA_COURT_LIMIT_SEC;

        const targetIndex = nantaQueue.findIndex(s => s.id === slotId);
        if (targetIndex !== -1) {
            nantaQueue.splice(targetIndex, 1);
        }

        broadcastState();
    });

    socket.on('clickAgain', (courtId) => {
        const target = courtsData.find(c => c.id === courtId);
        if (!target || target.isEmpty) return;

        const rawPlayers = target.players.replace(/<br>/g, ', ').split(',');
        const playerList = rawPlayers.map(p => p.trim()).filter(p => p !== '');

        target.isEmpty = true;
        target.players = '';
        target.vacatedAt = Date.now();

        while (playerList.length < 4) playerList.push('');

        gameQueue.push({
            id: 'g_' + Date.now(),
            type: 'game',
            players: playerList,
            remainingSeconds: null
        });

        broadcastState();
    });

    socket.on('clickEnd', (courtId) => {
        const target = courtsData.find(c => c.id === courtId);
        if (target) {
            target.isEmpty = true;
            target.players = '';
            target.vacatedAt = Date.now();
            broadcastState();
        }
    });

    socket.on('clickNantaEnd', (data) => {
        const { courtId, side } = data;
        const target = courtsData.find(c => c.id === courtId && c.type === 'nanta');
        
        if (target && target[side]) {
            target[side].isEmpty = true;
            target[side].players = '';
            target[side].remainingSeconds = 0;
            target[side].vacatedAt = Date.now();
            broadcastState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`배드민턴 클럽 실시간 통합 서버 실행 중: http://localhost:${PORT}`);
});