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
            
            const firstNames = ['민준', '서준', '도윤', '예준', '시우', '하준', '주원', '지호', '은우', '지후', '서연', '서윤', '지우', '하윤', '민서', '지유', '채원', '수아', '지민', '은서'];
            const lastNames = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임'];
            const grades = ['초심', 'D조', 'C조', 'B조', 'A조', 'S조'];
            const genders = ['남', '여'];
            const ageGroups = ['20대', '30대', '40대', '50대'];
            const addresses = ['경기도 파주시'];

            // 관리자 계정 삽입
            stmt.run("reg_admin", "regular", "admin", "admin123", "관리자", "남", "1975-01-01", "50대", "A조", "010-0000-0000", "경기도 파주시", "2023-01-01");

            // 50명의 실제 한글 이름 더미 생성
            for (let i = 1; i <= 50; i++) {
                const padNum = String(i).padStart(2, '0');
                const randomLastName = lastNames[i % lastNames.length];
                const randomFirstName = firstNames[(i * 3) % firstNames.length];
                const fullName = `${randomLastName}${randomFirstName}`;

                stmt.run(
                    `reg_${padNum}`,
                    'regular',
                    `user${i}`,
                    '1234',
                    fullName,
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
            console.log('✨ 실제 한글 이름 정회원 더미 데이터 50명 + 관리자 적재 완료');
        }

        // 💡 [추가] 서버가 켜질 때 로그인 테스트용 계정 몇 개를 터미널에 출력
        db.all(`SELECT name, phone FROM regular_members LIMIT 5`, (err, rows) => {
            if (!err && rows) {
                console.log('📋 [로그인 테스트용 정회원 샘플 명단]');
                rows.forEach((member, idx) => {
                    console.log(`  ${idx + 1}. 이름: ${member.name} / 전화번호: ${member.phone}`);
                });
            }
        });
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

                // 💡 게임 매칭 성사 및 타이머 시작 시 TV 전용 음성 안내 전송
                const validPlayers = getValidPlayers(slot.players);
                const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                const emptyCourt = courtsData.find(c => c.type === 'game' && c.isEmpty);
                const courtNum = emptyCourt ? emptyCourt.id : '';

                io.to('tv-room').emit('requestVoiceAnnouncement', {
                    courtNumber: courtNum,
                    names: memberNames,
                    matchType: '게임'
                });
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

                // 💡 난타 매칭 성사 및 타이머 시작 시 TV 전용 음성 안내 전송
                const validPlayers = getValidPlayers(slot.players);
                const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                let targetCourtNum = '';
                for (let court of courtsData) {
                    if (court.type === 'nanta') {
                        if ((court.sideA && court.sideA.isEmpty) || (court.sideB && court.sideB.isEmpty)) {
                            targetCourtNum = court.id;
                            break;
                        }
                    }
                }

                io.to('tv-room').emit('requestVoiceAnnouncement', {
                    courtNumber: targetCourtNum,
                    names: memberNames,
                    matchType: '난타'
                });
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
    // 서버 소켓 연결 부분 어딘가에 추가
socket.on('registerTV', () => {
    socket.join('tv-room');
    console.log("📺 TV 전광판 화면이 'tv-room'에 등록되었습니다.");
});
    // ==========================
    // 정회원 및 일일회원 로그인 소켓 이벤트
    // ==========================

    // 1. 정회원 로그인 처리
    socket.on('loginMember', ({ name, phone }, callback) => {
        const query = `SELECT * FROM regular_members WHERE name = ? AND REPLACE(phone, '-', '') = ?`;
        const cleanInputPhone = phone.replace(/[^0-9]/g, '');

        db.get(query, [name, cleanInputPhone], (err, row) => {
            if (err || !row) {
                return callback({ success: false, message: '등록된 정회원 정보가 일치하지 않습니다.' });
            }

            // 프론트엔드 호환을 위해 필요한 모든 속성 포함
            const user = {
                id: row.id,
                username: row.username,
                name: row.name,
                rawName: row.name,
                displayName: `${row.name} / ${row.gender} / ${row.ageGroup} / ${row.grade}`,
                gender: row.gender,
                ageGroup: row.ageGroup,
                grade: row.grade,
                isGuest: false,
                phone: row.phone
            };

            callback({ success: true, user });
        });
    });

    // 2. 일일회원 로그인 처리 (undefined 방지를 위한 기본 속성 추가)
    socket.on('loginGuest', ({ name, phone, payCode }, callback) => {
        if (!payCode || payCode.length !== 6) {
            return callback({ success: false, message: '유효한 결제인증번호 6자리를 입력하세요.' });
        }

        const guestId = `guest_${Date.now()}`;
        const user = {
            id: guestId,
            username: guestId,
            name: name,
            rawName: name,
            displayName: `${name}(일일)`,
            gender: '-',
            ageGroup: '-',
            grade: '일일',
            isGuest: true,
            phone: phone
        };

        callback({ success: true, user });
    });
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

    // 🔒 방 개설 시 현재 코트 플레이 여부 및 중복 체크
    socket.on('createSlot', ({ type, userId, user }) => {
        const myName = user.split(' / ')[0].trim();

        // 1. 현재 게임 코트에서 뛰고 있는지 확인
        const isInGameCourt = courtsData.some(c => c.type === 'game' && !c.isEmpty && c.players && c.players.includes(myName));
        if (isInGameCourt) {
            socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 게임 코트에서 플레이 중이므로 새로운 방을 개설할 수 없습니다.`);
            return;
        }

        // 2. 난타 코트에서 뛰고 있는지 확인 (난타방 개설 시만 차단, 게임방 개설은 허용)
        if (type === 'nanta') {
            const isInNantaCourt = courtsData.some(c => c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && c.sideA.players.includes(myName)) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && c.sideB.players.includes(myName))
            ));
            if (isInNantaCourt) {
                socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 난타 코트에서 플레이 중이므로 새로운 난타 방을 개설할 수 없습니다.`);
                return;
            }
        }

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
        const myName = user.split(' / ')[0].trim();
        const isInGameCourt = courtsData.some(c => c.type === 'game' && !c.isEmpty && c.players && c.players.includes(myName));
        if (isInGameCourt) {
            socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 게임 코트에서 플레이 중이므로 방을 개설할 수 없습니다.`);
            return;
        }

        if (type === 'nanta') {
            const isInNantaCourt = courtsData.some(c => c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && c.sideA.players.includes(myName)) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && c.sideB.players.includes(myName))
            ));
            if (isInNantaCourt) {
                socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 난타 코트에서 플레이 중이므로 난타 방을 개설할 수 없습니다.`);
                return;
            }
        }

        const existingGameSlot = gameQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const existingNantaSlot = nantaQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const sameSlot = type === 'game' ? existingGameSlot : existingNantaSlot;
        
        if (sameSlot) {
            socket.emit('alertMessage', `이미 ${type === 'game' ? '게임' : '난타'} 대기 방에 참여 중이거나 개설한 상태입니다.`);
            return;
        }

        createNewSlotDirectly(type, userId, user);
    });

    // 🔒 대기 방 참여(입장하기) 시 현재 코트 플레이 여부 체크
    socket.on('joinPlayer', ({ type, slotId, index, name }) => {
        const cleanName = name.split('/')[0].trim();

        // 1. 게임 코트 플레이 중이면 모든 입장 차단
        const isInGameCourt = courtsData.some(c => c.type === 'game' && !c.isEmpty && c.players && c.players.includes(cleanName));
        if (isInGameCourt) {
            socket.emit('alertMessage', `⚠️ ${cleanName} 님은 현재 게임 코트에서 플레이 중이므로 대기 방에 입장할 수 없습니다.`);
            return;
        }

        // 2. 난타 코트 플레이 중이면 난타 방 입장 차단 (게임 방 입장은 허용)
        if (type === 'nanta') {
            const isInNantaCourt = courtsData.some(c => c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && c.sideA.players.includes(cleanName)) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && c.sideB.players.includes(cleanName))
            ));
            if (isInNantaCourt) {
                socket.emit('alertMessage', `⚠️ ${cleanName} 님은 현재 난타 코트에서 플레이 중이므로 난타 방에 입장할 수 없습니다.`);
                return;
            }
        }

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

   // 🏟️ 대기 방에서 정원 충족 후 [코트 입장] 처리 (규칙 반영 완료)
    socket.on('enterCourtFromSlot', ({ type, slotId }) => {
        try {
            if (type === 'game') {
                const slotIdx = gameQueue.findIndex(s => s.id === slotId);
                if (slotIdx === -1) return;
                const slot = gameQueue[slotIdx];
                const validPlayers = getValidPlayers(slot.players);

                if (validPlayers.length < 4) return;

                // 빈 게임 코트 찾기
                const emptyCourt = courtsData.find(c => c.type === 'game' && c.isEmpty);
                if (!emptyCourt) return;

                // 코트에 플레이어 배정 및 상태 변경
                emptyCourt.isEmpty = false;
                emptyCourt.players = validPlayers.join(', ');
                emptyCourt.startTime = Date.now();
                emptyCourt.remainingSeconds = 0;

                // 게임 대기열에서 제거
                gameQueue.splice(slotIdx, 1);

                // ⭐ [규칙 적용] 게임 코트 입장 시, 해당 인원들이 포함된 난타 대기열(nantaQueue) 및 난타 코트(A/B반)에서 강제 퇴장 처리
                validPlayers.forEach(p => {
                    const cleanPName = p.split('/')[0].trim();

                    // 1. 난타 대기열에서 제거
                    nantaQueue.forEach(nSlot => {
                        nSlot.players.forEach((np, idx) => {
                            if (np && np.includes(cleanPName)) {
                                nSlot.players[idx] = '';
                            }
                        });
                    });
                    // 비어버린 난타 대기방 제거
                    nantaQueue = nantaQueue.filter(nSlot => getValidPlayers(nSlot.players).length > 0);

                    // 2. 난타 코트(진행 중)에서 제거
                    courtsData.forEach(court => {
                        if (court.type === 'nanta') {
                            if (court.sideA && !court.sideA.isEmpty && court.sideA.players && court.sideA.players.includes(cleanPName)) {
                                court.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                            }
                            if (court.sideB && !court.sideB.isEmpty && court.sideB.players && court.sideB.players.includes(cleanPName)) {
                                court.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                            }
                        }
                    });
                });

                addNotification(`🏟️ [코트 입장] 게임 코트 (${emptyCourt.id}번)에 팀이 입장했습니다.`);
                broadcastState();

            } else if (type === 'nanta') {
                const slotIdx = nantaQueue.findIndex(s => s.id === slotId);
                if (slotIdx === -1) return;
                const slot = nantaQueue[slotIdx];
                const validPlayers = getValidPlayers(slot.players);

                if (validPlayers.length < 2) return;

                // 빈 난타 반코트(sideA 또는 sideB) 찾기
                let targetCourt = null;
                let targetSide = null;

                for (let court of courtsData) {
                    if (court.type === 'nanta') {
                        if (court.sideA && court.sideA.isEmpty) {
                            targetCourt = court;
                            targetSide = 'sideA';
                            break;
                        } else if (court.sideB && court.sideB.isEmpty) {
                            targetCourt = court;
                            targetSide = 'sideB';
                            break;
                        }
                    }
                }

                if (!targetCourt) return;

                // 반코트에 플레이어 배정
                targetCourt[targetSide] = {
                    isEmpty: false,
                    players: validPlayers.join(', '),
                    startTime: Date.now(),
                    remainingSeconds: config.NANTA_COURT_LIMIT_SEC || 900
                };

                // 난타 대기열에서 제거
                nantaQueue.splice(slotIdx, 1);

                addNotification(`🏟️ [코트 입장] 난타 코트 (${targetCourt.id}번 - ${targetSide === 'sideA' ? 'A반' : 'B반'})에 팀이 입장했습니다.`);
                broadcastState();
            }
        } catch (err) {
            console.error('코트 입장 처리 에러:', err);
        }
    });
   // 🏸 난타 코트(특정 사이드) 종료 요청 처리
    socket.on('endNantaCourt', ({ courtId, side }) => {
        console.log(`🔍 [디버깅] 난타 종료 요청 수신 - 코트번호: ${courtId}, 사이드: ${side}`);

        const targetCourt = courtsData.find(c => c.id === Number(courtId));
        if (!targetCourt || targetCourt.type !== 'nanta') return;

        let isCleared = false;

        // 'sideA', 'sideB', 'A', 'B' 어떤 형태로 들어와도 안전하게 인식하도록 정제
        const cleanSide = side ? String(side).replace('side', '').toUpperCase() : '';

        if (cleanSide === 'A' && targetCourt.sideA && !targetCourt.sideA.isEmpty) {
            targetCourt.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            isCleared = true;
        } else if (cleanSide === 'B' && targetCourt.sideB && !targetCourt.sideB.isEmpty) {
            targetCourt.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            isCleared = true;
        }

        if (isCleared) {
            addNotification(`🔔 [난타종료] ${targetCourt.id}번 코트 (${cleanSide}면)가 수동 종료되었습니다.`);
            broadcastState(); // 모든 클라이언트와 TV 화면에 즉시 동기화
        }
    });
    // 🏁 [게임 종료] 코트의 게임을 완전히 종료하고 비우는 핸들러
    socket.on('endGameCourt', ({ courtId }) => {
        try {
            const court = courtsData.find(c => c.id === courtId && c.type === 'game');
            if (court) {
                court.isEmpty = true;
                court.players = '';
                court.startTime = null;
                court.remainingSeconds = 0;
                addNotification(`🏁 [게임 종료] ${court.id}번 코트 게임이 종료되었습니다.`);
                broadcastState();
            }
        } catch (err) {
            console.error('게임 종료 처리 에러:', err);
        }
    });

    // 🔄 [한게임 더] 게임이 끝난 인원들을 새로운 대기 방으로 만들어 게임 대기열의 '최후순위'로 배치하는 핸들러
    socket.on('extendGameCourt', ({ courtId }) => {
        try {
            const court = courtsData.find(c => c.id === courtId && c.type === 'game');
            if (!court || court.isEmpty || !court.players) return;

            const playersArr = court.players.split(',').map(p => p.trim()).filter(Boolean);
            if (playersArr.length === 0) return;

            // 새로운 대기 방 슬롯 생성 (기존 플레이어들 그대로 유지)
            const newSlot = {
                id: 'slot_' + (slotIdCounter++),
                type: 'game',
                players: [
                    playersArr[0] || '',
                    playersArr[1] || '',
                    playersArr[2] || '',
                    playersArr[3] || ''
                ],
                userIds: [], 
                createdAt: Date.now(),
                fullAt: null,
                remainingSeconds: null
            };

            // 게임 대기열의 맨 뒤(최후순위)에 푸시
            gameQueue.push(newSlot);

            // 해당 코트는 비워주기
            court.isEmpty = true;
            court.players = '';
            court.startTime = null;
            court.remainingSeconds = 0;

            addNotification(`🔄 [한게임 더] ${court.id}번 코트 팀이 대기열 최후순위로 재등록되었습니다.`);
            broadcastState();
        } catch (err) {
            console.error('한게임 더 처리 에러:', err);
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