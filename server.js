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

// 정회원 목록 조회 API
app.get('/api/members', (req, res) => {
    db.all(`SELECT id, username, name, gender, ageGroup, grade, address FROM regular_members`, (err, rows) => {
        if (err) {
            console.error('❌ 회원 목록 조회 실패:', err.message);
            res.status(500).json({ error: '데이터베이스 조회 실패' });
        } else {
            res.json(rows);
        }
    });
});

// 로그인 처리 API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get(`SELECT * FROM regular_members WHERE username = ?`, [username], (err, user) => {
        if (err) {
            console.error('❌ 로그인 DB 조회 에러:', err.message);
            return res.status(500).json({ success: false, message: '서버 에러가 발생했습니다.' });
        }

        if (!user) {
            return res.json({ success: false, message: '존재하지 않는 회원 아이디입니다.' });
        }

        if (user.password === password) {
            const { password: _, ...userInfo } = user;
            res.json({ success: true, user: userInfo });
        } else {
            res.json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    });
});

// 🧹 [궁극의 완벽 청소 및 방 폭파 함수] 유저명, 고유ID, 별칭 모두 검사하여 찌꺼기 방을 흔적없이 폭파
function cleanupUser(usernameOrObj) {
    if (!usernameOrObj) return;

    let targetKeyword = '';
    if (typeof usernameOrObj === 'string') {
        targetKeyword = usernameOrObj.split('/')[0].trim();
    } else if (typeof usernameOrObj === 'object' && usernameOrObj.username) {
        targetKeyword = usernameOrObj.username;
    }

    if (!targetKeyword) return;

    let altKeyword = targetKeyword;
    if (targetKeyword.startsWith('user')) {
        const num = targetKeyword.replace('user', '');
        altKeyword = `회원${num.padStart(2, '0')}`;
    }
    
    // DB에서 해당 유저의 고유 ID(reg_01 등)도 미리 찾아내어 완벽 차단
    db.get(`SELECT id FROM regular_members WHERE username = ?`, [targetKeyword], (err, row) => {
        const uniqueRegId = row ? row.id : null;

        // 1. 게임 대기열(gameQueue) 정리 및 빈 방 폭파
        if (typeof gameQueue !== 'undefined') {
            const validGameQueue = gameQueue.filter(slot => {
                // userIds 배열에서 매칭되는 아이디/고유ID 전면 제거
                if (slot.userIds) {
                    slot.userIds = slot.userIds.filter(id => {
                        return id !== targetKeyword && 
                               id !== altKeyword && 
                               id !== uniqueRegId && 
                               !id.includes(targetKeyword) && 
                               !id.includes(altKeyword);
                    });
                }
                
                // players 배열에서 플레이어 이름 제거
                if (slot.players) {
                    slot.players = slot.players.map(p => {
                        if (!p) return '';
                        if (p.includes(targetKeyword) || (altKeyword && p.includes(altKeyword))) {
                            return '';
                        }
                        return p;
                    });
                }
                
                // 남은 유효 인원 및 유효 ID 재확인
                const hasValidPlayers = slot.players && slot.players.some(p => {
                    if (!p) return false;
                    const trimmed = String(p).trim();
                    return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null';
                });
                
                const hasValidIds = slot.userIds && slot.userIds.some(id => {
                    if (!id) return false;
                    const trimmed = String(id).trim();
                    return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null';
                });

                // 💥 플레이어도 없고 개설자 ID도 비어있으면 게임방 완전 폭파!
                if (!hasValidPlayers && !hasValidIds) {
                    console.log(`💥 [빈 게임방 폭파 완료] 남은 인원/ID가 없어 게임방이 삭제됩니다.`);
                    return false; 
                }

                return true;
            });

            gameQueue.length = 0;
            gameQueue.push(...validGameQueue);
        }

        // 2. 난타 대기열(nantaQueue) 정리 및 빈 방 폭파
        if (typeof nantaQueue !== 'undefined') {
            const validNantaQueue = nantaQueue.filter(slot => {
                if (slot.userIds) {
                    slot.userIds = slot.userIds.filter(id => {
                        return id !== targetKeyword && 
                               id !== altKeyword && 
                               id !== uniqueRegId && 
                               !id.includes(targetKeyword) && 
                               !id.includes(altKeyword);
                    });
                }
                
                if (slot.players) {
                    slot.players = slot.players.map(p => {
                        if (!p) return '';
                        if (p.includes(targetKeyword) || (altKeyword && p.includes(altKeyword))) {
                            return '';
                        }
                        return p;
                    });
                }

                const hasRemainingPlayers = slot.players && slot.players.some(p => {
                    if (!p) return false;
                    const trimmed = String(p).trim();
                    return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null';
                });
                
                const hasRemainingIds = slot.userIds && slot.userIds.some(id => {
                    if (!id) return false;
                    const trimmed = String(id).trim();
                    return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null';
                });
                
                // 💥 플레이어도 없고 개설자 ID도 비어있으면 난타방 완전 폭파!
                if (!hasRemainingPlayers && !hasRemainingIds) {
                    console.log(`💥 [빈 난타방 폭파 완료] 남은 인원/ID가 없어 난타방이 삭제됩니다.`);
                    return false; 
                }
                
                return true;
            });

            nantaQueue.length = 0;
            nantaQueue.push(...validNantaQueue);
        }

        console.log(`✨ [청소 완료] 키워드 "${targetKeyword}" 관련 모든 슬롯 데이터 및 찌꺼기 방이 정리되었습니다.`);
        
        if (typeof broadcastState === 'function') {
            broadcastState();
        }
    });
}

// 로그아웃 API
app.post('/api/logout', (req, res) => {
    const { username } = req.body;
    console.log(`🧹 [로그아웃 요청 수신] 유저: ${username}의 대기/방 참여 상태 정리 중...`);
    if (username) {
        cleanupUser(username);
    }
    res.json({ success: true });
});

// 관리자 모드: 강제 퇴장 및 방 강제 종료 API
app.post('/api/admin/kick-user', (req, res) => {
    const { targetUsername } = req.body;

    if (!targetUsername) {
        return res.status(400).json({ success: false, message: '퇴장시킬 회원 아이디가 없습니다.' });
    }

    cleanupUser(targetUsername);

    console.log(`🚨 [관리자 강제 퇴장] 회원 [${targetUsername}]님이 강제 퇴장 및 정리되었습니다.`);
    res.json({ success: true, message: `${targetUsername}님을 강제 퇴장시켰습니다.` });
});

app.post('/api/admin/delete-room', (req, res) => {
    const { roomType, roomId } = req.body;

    if (!roomType || roomId === undefined) {
        return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    }

    if (roomType === 'game' && typeof gameQueue !== 'undefined') {
        gameQueue = gameQueue.filter(slot => slot.id !== roomId && slot.slotId !== roomId);
        console.log(`💥 [관리자 게임방 강제 종료] 게임방(${roomId})이 삭제되었습니다.`);
    } else if (roomType === 'nanta' && typeof nantaQueue !== 'undefined') {
        nantaQueue = nantaQueue.filter(slot => slot.id !== roomId && slot.slotId !== roomId);
        console.log(`💥 [관리자 난타방 강제 종료] 난타방(${roomId})이 삭제되었습니다.`);
    } else {
        return res.json({ success: false, message: '존재하지 않는 방이거나 타입 오류입니다.' });
    }

    if (typeof broadcastState === 'function') {
        broadcastState();
    }

    res.json({ success: true, message: '해당 방이 강제 종료되었습니다.' });
});

app.post('/api/admin/clear-court', (req, res) => {
    const { courtId, side } = req.body;

    if (courtId === undefined) {
        return res.status(400).json({ success: false, message: '코트 번호가 지정되지 않았습니다.' });
    }

    const targetCourt = courtsData.find(c => c.id === Number(courtId));

    if (!targetCourt) {
        return res.status(404).json({ success: false, message: '해당 코트를 찾을 수 없습니다.' });
    }

    let noticeMessage = '';
    let courtCategory = 'game';

    if (targetCourt.type === 'game') {
        targetCourt.isEmpty = true;
        targetCourt.players = '';
        targetCourt.note = '';
        courtCategory = 'game';
        noticeMessage = `[관리자 알림] ${targetCourt.id}번 게임코트는 관리자에 의해 종료되었습니다.`;
    } else if (targetCourt.type === 'nanta') {
        courtCategory = 'nanta';
        if (side === 'A' && targetCourt.sideA) {
            targetCourt.sideA.isEmpty = true;
            targetCourt.sideA.players = '';
            targetCourt.sideA.startTime = null;
            targetCourt.sideA.remainingSeconds = 0;
            noticeMessage = `[관리자 알림] ${targetCourt.id}번 난타코트 A구역은 관리자에 의해 종료되었습니다.`;
        } else if (side === 'B' && targetCourt.sideB) {
            targetCourt.sideB.isEmpty = true;
            targetCourt.sideB.players = '';
            targetCourt.sideB.startTime = null;
            targetCourt.sideB.remainingSeconds = 0;
            noticeMessage = `[관리자 알림] ${targetCourt.id}번 난타코트 B구역은 관리자에 의해 종료되었습니다.`;
        } else {
            if (targetCourt.sideA) {
                targetCourt.sideA.isEmpty = true;
                targetCourt.sideA.players = '';
                targetCourt.sideA.startTime = null;
                targetCourt.sideA.remainingSeconds = 0;
            }
            if (targetCourt.sideB) {
                targetCourt.sideB.isEmpty = true;
                targetCourt.sideB.players = '';
                targetCourt.sideB.startTime = null;
                targetCourt.sideB.remainingSeconds = 0;
            }
            noticeMessage = `[관리자 알림] ${targetCourt.id}번 난타코트 전체는 관리자에 의해 종료되었습니다.`;
        }
        targetCourt.note = '';
    } else if (targetCourt.type === 'lesson') {
        targetCourt.isEmpty = true;
        targetCourt.players = '';
        courtCategory = 'lesson';
        noticeMessage = `[관리자 알림] ${targetCourt.id}번 레슨코트는 관리자에 의해 종료되었습니다.`;
    }

    if (typeof io !== 'undefined') {
        io.emit('courtClearedNotice', {
            courtId: targetCourt.id,
            category: courtCategory,
            message: noticeMessage
        });
    }

    res.json({ success: true, message: `${targetCourt.id}번 코트가 성공적으로 강제 비워졌습니다.` });
});

// ==========================================
// 4. 인메모리 데이터 상태 관리
// ==========================================
let config = {
    ENTRY_TIMEOUT_SEC: 180, 
    NANTA_COURT_LIMIT_SEC: 900, 
    ADMIN_PASSWORD: '1234' 
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

setInterval(() => {
    const now = Date.now();

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
// 6. Socket.IO 이벤트 핸들링
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

    socket.on('registerUserSession', (username) => {
        if (username) {
            socket.username = username;
            console.log(`👤 [소켓 등록] 유저 ${username}의 소켓(ID: ${socket.id})이 매핑되었습니다.`);
        }
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            console.log(`🔌 [연결 끊김] 소켓 ID: ${socket.id} (유저: ${socket.username}) 연결 해제됨`);
            cleanupUser(socket.username);
        }
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
});

// ==========================
// 7. 서버 실행
// ==========================
server.listen(PORT, () => {
    console.log(`🚀 배드민턴 클럽 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});