// ==========================
// 1. 필수 모듈 불러오기
// ==========================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// ==========================
// 2. 서버 및 미들웨어 초기화
// ==========================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ==========================
// 3. 데이터베이스(SQLite) 연결 및 초기화
// ==========================
const dbPath = path.resolve(__dirname, 'badminton.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 데이터베이스 연결 실패:', err.message);
    } else {
        console.log('✅ SQLite 데이터베이스(badminton.db) 연결 성공');
        initDatabase();
        insertDefaultDummyData(); 
    }
});

function initDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS regular_members (
            id TEXT PRIMARY KEY,
            type TEXT,
            username TEXT UNIQUE,
            password TEXT,
            name TEXT,
            gender TEXT,
            birthDate TEXT,
            ageGroup TEXT,
            grade TEXT,
            phone TEXT,
            address TEXT,
            joinedAt TEXT
        )
    `, (err) => {
        if (!err) {
            checkAndInsertDefaultData();
        }
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS daily_guests (
            id TEXT PRIMARY KEY,
            type TEXT,
            name TEXT,
            phone TEXT,
            address TEXT,
            visitedAt TEXT
        )
    `);
}

function checkAndInsertDefaultData() {
    db.get(`SELECT COUNT(*) as count FROM regular_members`, (err, row) => {
        if (row && row.count === 0) {
            console.log('📦 정회원 데이터가 없어 기본 더미 데이터를 삽입합니다.');
            const stmt = db.prepare(`INSERT INTO regular_members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            
            const grades = ['초심', 'D조', 'C조', 'B조', 'A조', 'S조'];
            const genders = ['남', '여'];
            const ageGroups = ['20대', '30대', '40대', '50대'];
            const addresses = ['경기도 파주시'];

            stmt.run("reg_admin", "regular", "admin", "admin123", "관리자", "남", "1975-01-01", "50대", "A조", "010-0000-0000", "경기도 파주시", "2023-01-01");

            for (let i = 1; i <= 50; i++) {
                const padNum = String(i).padStart(2, '0');
                stmt.run(
                    `reg_${padNum}`,
                    'regular',
                    `user${i}`,
                    '1234',
                    `회원${padNum}`,
                    genders[i % genders.length],
                    '1985-05-15',
                    ageGroups[i % ageGroups.length],
                    grades[i % grades.length],
                    `010-1111-${padNum}${padNum}`,
                    addresses[0],
                    '2026-01-01'
                );
            }
            stmt.finalize();
            console.log('✨ 기본 정회원 더미 데이터 50명 + 관리자 적재 완료');
        }
    });
}

// 더미 데이터 삽입용 함수 더미 정의 (에러 방지용)
function insertDefaultDummyData() {}

// 정적 파일 및 라우팅 설정
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/tv', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ==========================
// 정회원 목록 조회 API (로그인 화면 드롭다운용)
// ==========================
app.get('/api/members', (req, res) => {
    // 💡 핵심 수정: SELECT 문에 username을 추가하여 함께 가져옵니다.
    db.all(`SELECT id, username, name, gender, ageGroup, grade, address FROM regular_members`, (err, rows) => {
        if (err) {
            console.error('❌ 회원 목록 조회 실패:', err.message);
            res.status(500).json({ error: '데이터베이스 조회 실패' });
        } else {
            res.json(rows);
        }
    });
});

// ==========================
// 로그인 처리 API (누락되었던 핵심 기능)
// ==========================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    // 데이터베이스에서 아이디(username)로 회원 조회
    db.get(`SELECT * FROM regular_members WHERE username = ?`, [username], (err, user) => {
        if (err) {
            console.error('❌ 로그인 DB 조회 에러:', err.message);
            return res.status(500).json({ success: false, message: '서버 에러가 발생했습니다.' });
        }

        if (!user) {
            return res.json({ success: false, message: '존재하지 않는 회원 아이디입니다.' });
        }

        // 입력한 비밀번호와 DB에 저장된 비밀번호 비교
        if (user.password === password) {
            // 보안을 위해 비밀번호 필드는 제외하고 유저 정보 전송
            const { password: _, ...userInfo } = user;
            res.json({ success: true, user: userInfo });
        } else {
            res.json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    });
});
// ==========================================
// 4. 인메모리 데이터 상태 관리
// ==========================================
let config = {
    ENTRY_TIMEOUT_SEC: 180,       // 입장 대기 제한시간 (3분)
    NANTA_COURT_LIMIT_SEC: 900,   // 난타 코트 제한시간 (15분)
    ADMIN_PASSWORD: '1234'        // 관리자 비밀번호
};

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

let gameQueue = []; 
let nantaQueue = []; 
let notifications = []; 
let slotIdCounter = 1;

// ==========================================
// 5. 유틸리티 및 브로드캐스트 함수
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
    if (notifications.length > 30) notifications.pop();
}

function getValidPlayers(playersArr) {
    return (playersArr || []).filter(p => p && p.trim() !== '');
}

// 1초마다 타이머 및 제한시간 체크
setInterval(() => {
    const now = Date.now();

    // A. 게임 대기 방 입장 제한 타이머 체크
    const emptyGameCourtsCount = courtsData.filter(c => c.type === 'game' && c.isEmpty).length;
    let activeTimerCount = 0;

    gameQueue.forEach((slot) => {
        const validCount = getValidPlayers(slot.players).length;
        
        if (validCount === 4 && activeTimerCount < emptyGameCourtsCount) {
            activeTimerCount++;
            
            if (!slot.fullAt) {
                slot.fullAt = now;
            }
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            if (slot.remainingSeconds === 0) {
                const targetIdx = gameQueue.findIndex(s => s.id === slot.id);
                if (targetIdx !== -1) {
                    const expiredTeam = gameQueue.splice(targetIdx, 1)[0];
                    expiredTeam.fullAt = null;
                    expiredTeam.remainingSeconds = null;
                    gameQueue.push(expiredTeam);

                    addNotification(`⏰ [게임대기] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열 맨 뒤로 이동되었습니다.`);
                }
            }
        } else {
            slot.fullAt = null;
            slot.remainingSeconds = null;
        }
    });

    // B. 난타 대기 방 입장 제한 타이머 체크
    let emptyNantaSlotsCount = 0;
    courtsData.forEach(court => {
        if (court.type === 'nanta') {
            if (court.isEmpty) {
                emptyNantaSlotsCount += 2;
            } else {
                if (court.sideA && court.sideA.isEmpty) emptyNantaSlotsCount++;
                if (court.sideB && court.sideB.isEmpty) emptyNantaSlotsCount++;
            }
        }
    });

    let activeNantaTimerCount = 0;
    nantaQueue.forEach(slot => {
        const validCount = getValidPlayers(slot.players).length;
        
        if (validCount === 2 && activeNantaTimerCount < emptyNantaSlotsCount) {
            activeNantaTimerCount++;
            
            if (!slot.fullAt) {
                slot.fullAt = now;
            }
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            if (slot.remainingSeconds === 0) {
                const index = nantaQueue.findIndex(s => s.id === slot.id);
                if (index !== -1) {
                    const expiredTeam = nantaQueue.splice(index, 1)[0];
                    expiredTeam.fullAt = null;
                    expiredTeam.remainingSeconds = null;
                    nantaQueue.push(expiredTeam);

                    addNotification(`⏰ [난타대기] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열 맨 뒤로 이동되었습니다.`);
                }
            }
        } else {
            slot.fullAt = null;
            slot.remainingSeconds = null;
        }
    });
    
    // C. 난타 코트 잔여시간 체크
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

                        const isBothEmpty = (!court.sideA || court.sideA.isEmpty) && (!court.sideB || court.sideB.isEmpty);
                        if (isBothEmpty && court.nextType && court.nextType !== 'nanta') {
                            const applyType = court.nextType;
                            court.type = applyType;
                            court.isEmpty = (applyType !== 'lesson');
                            court.players = (applyType === 'lesson') ? (court.note || '레슨 코트') : '';
                            delete court.sideA;
                            delete court.sideB;
                        }
                    }
                }
            });
        }
    });

    broadcastState();
}, 1000);

// ==========================================
// 6. Socket.IO 이벤트 핸들링 (통합 및 괄호 구조 정상화)
// ==========================================
io.on('connection', (socket) => {
    socket.lastActiveTime = Date.now();

    socket.onAny(() => {
        socket.lastActiveTime = Date.now();
    });

    socket.emit('stateUpdated', {
        config: config,
        courtsData: courtsData,
        gameQueue: gameQueue,
        nantaQueue: nantaQueue,
        notifications: notifications
    });

    socket.on('verifyAdminPassword', (inputPw, callback) => {
        if (typeof callback === 'function') {
            if (inputPw === config.ADMIN_PASSWORD) {
                callback({ success: true });
            } else {
                callback({ success: false });
            }
        }
    });

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

    socket.on('updateCourtsConfig', (newCourtsConfig) => {
        try {
            if (!Array.isArray(newCourtsConfig)) return;

            courtsData = newCourtsConfig.map((court, idx) => {
                const id = idx + 1;
                const targetType = court ? (court.type || 'game') : 'game';
                const targetNote = court ? (court.note || '') : '';
                const existingCourt = courtsData.find(c => c.id === id);

                const isGameActive = existingCourt && existingCourt.type === 'game' && !existingCourt.isEmpty && existingCourt.players && existingCourt.players.trim() !== '';
                const isNantaActive = existingCourt && existingCourt.type === 'nanta' && ((existingCourt.sideA && !existingCourt.sideA.isEmpty) || (existingCourt.sideB && !existingCourt.sideB.isEmpty));
                const isInUse = isGameActive || isNantaActive;

                if (!isInUse) {
                    if (targetType === 'nanta') {
                        return { 
                            id, type: 'nanta', nextType: 'nanta', note: targetNote,
                            sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                            sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 } 
                        };
                    } else if (targetType === 'lesson') {
                        return { 
                            id, type: 'lesson', nextType: 'lesson', isEmpty: false, 
                            players: targetNote || '레슨 코트', note: targetNote 
                        };
                    } else {
                        return { 
                            id, type: 'game', nextType: 'game', isEmpty: true, 
                            players: '', note: targetNote 
                        };
                    }
                }

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

    // 방 개설 검사 요청
    socket.on('createSlot', ({ type, userId, user }) => {
        const existingGameSlot = gameQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const existingNantaSlot = nantaQueue.find(slot => slot.userIds && slot.userIds.includes(userId));

        const targetType = type; 
        const sameSlot = targetType === 'game' ? existingGameSlot : existingNantaSlot;
        const oppositeSlot = targetType === 'game' ? existingNantaSlot : existingGameSlot;

        if (sameSlot) {
            socket.emit('alertMessage', `이미 ${targetType === 'game' ? '게임' : '난타'} 대기 방에 참여 중이거나 개설한 상태입니다.`);
            return;
        }

        if (oppositeSlot) {
            socket.emit('confirmCrossSlot', { type: targetType, userId, user });
            return;
        }

        socket.emit('confirmFirstSlot', { type: targetType, userId, user });
    });

    socket.on('forceCreateSlot', ({ type, userId, user }) => {
        const existingGameSlot = gameQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const existingNantaSlot = nantaQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const sameSlot = type === 'game' ? existingGameSlot : existingNantaSlot;
        
        if (sameSlot) {
            socket.emit('alertMessage', `이미 ${type === 'game' ? '게임' : '난타'} 대기 방에 참여 중이거나 개설한 상태입니다.`);
            return;
        }

        createNewSlotDirectly(type, userId, user);
    });

    socket.on('joinPlayer', ({ type, slotId, index, name }) => {
        const queue = type === 'game' ? gameQueue : nantaQueue;
        const slot = queue.find(s => s.id === slotId);
        
        if (slot && index >= 0 && index < slot.players.length) {
            slot.players[index] = name;
            addNotification(`👤 [참가] ${name} 님이 대기 방에 입장하셨습니다.`);
            broadcastState();
        }
    });

    function createNewSlotDirectly(type, userId, user) {
        const myName = user.split(' / ')[0].trim();

        const newSlot = {
            id: 'slot_' + (slotIdCounter++),
            type: type,
            players: type === 'game' ? [user, '', '', ''] : [user, '', ''],
            userIds: [userId], 
            createdAt: Date.now(),
            fullAt: null,
            remainingSeconds: null
        };

        if (type === 'game') gameQueue.push(newSlot);
        else nantaQueue.push(newSlot);

        addNotification(`📢 [방 개설] 새로운 ${type === 'game' ? '게임' : '난타'} 방이 개설되었습니다 (${myName}).`);
        broadcastState();
    }

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

    socket.on('adminForceExit', ({ targetType, targetId, index }) => {
        try {
            if (targetType === 'gameQueue' || targetType === 'nantaQueue') {
                const queue = targetType === 'gameQueue' ? gameQueue : nantaQueue;
                const slot = queue.find(s => s.id === targetId);
                if (slot && slot.players[index] !== undefined) {
                    const kickedName = slot.players[index];
                    slot.players[index] = '';
                    
                    if (getValidPlayers(slot.players).length === 0) {
                        const qIndex = queue.findIndex(s => s.id === targetId);
                        if (qIndex !== -1) queue.splice(qIndex, 1);
                    }
                    
                    addNotification(`⚠️ [관리자 강제퇴장] ${kickedName} 님이 대기 방에서 강제 퇴장되었습니다.`);
                    broadcastState();
                }
            } 
            else if (targetType === 'court') {
                const court = courtsData.find(c => c.id === targetId);
                if (court) {
                    if (court.type === 'game') {
                        court.isEmpty = true;
                        court.players = '';
                        court.startTime = null;
                        court.remainingSeconds = 0;
                        addNotification(`⚠️ [관리자 강제퇴장] 게임 코트(${court.id}번)가 강제 종료 및 비워졌습니다.`);
                    } else if (court.type === 'nanta') {
                        if (index === 'A' && court.sideA) {
                            court.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                        } else if (index === 'B' && court.sideB) {
                            court.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                        }
                        addNotification(`⚠️ [관리자 강제퇴장] 난타 코트(${court.id}번 - ${index}면)가 강제 비워졌습니다.`);
                    }
                    broadcastState();
                }
            }
        } catch (err) {
            console.error('관리자 강제 퇴장 처리 에러:', err);
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
            court.isEmpty = (applyType !== 'lesson');
            court.players = (applyType === 'lesson') ? (court.note || '레슨 코트') : '';
            delete court.sideA;
            delete court.sideB;
            
            broadcastState();
        }
    });

    // 게임 코트 한 게임 더
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
            court.isEmpty = (applyType !== 'lesson');
            court.players = (applyType === 'lesson') ? (court.note || '레슨 코트') : '';
            delete court.sideA;
            delete court.sideB;
            
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

    // 난타 코트 종료
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
                court.isEmpty = (applyType !== 'lesson');
                court.players = (applyType === 'lesson') ? (court.note || '레슨 코트') : '';
                delete court.sideA;
                delete court.sideB;
            }

            broadcastState();
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ 접속 해제: ${socket.id}`);
    });
});

// ==========================
// 7. 서버 실행
// ==========================
server.listen(PORT, () => {
    console.log(`🚀 배드민턴 클럽 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});