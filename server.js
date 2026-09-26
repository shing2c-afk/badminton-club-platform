// ==========================
// 1. 필수 모듈 불러오기
// ==========================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const readline = require('readline');

// ==========================================
// 💾 영구 디스크 및 데이터베이스/설정 파일 경로 설정 (Render 대응)
// ==========================================
const DATA_DIR = process.env.RENDER ? '/var/data' : __dirname;

// 폴더가 없으면 자동으로 생성하는 안전장치
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 영구 디스크 경로가 반영된 파일 경로 정의
const dbPath = path.join(DATA_DIR, 'badminton.db');

// 유저별 활성 소켓 ID 관리 맵 (username -> socketId)
const activeUserSockets = new Map();

// 유저별 연결 끊김 유예 타이머를 저장할 객체
const disconnectTimers = {};
const disconnectUserClubs = {}; // 끊긴 시점의 구장을 기억하는 메모장
const disconnectRawUsers = {};  // 방 폭파용 회원 정보를 기억하는 메모장
const sessionTimers = {}; // 👈 이 줄 추가 (60분 완전 만료 관리용)
const userSockets = {};
const expiredUsers = {}; // 유예 시간 초과로 만료된 유저를 기록할 객체
const UserDictionary = require('./userDictionary'); // 파일 경로에 맞게 설정
// 현재 로그인된 유저들의 소켓 ID 또는 유저 정보를 담는 Set
const onlineUsers = new Set();

// ==========================================
// 🔊 [구장별 격리] 서버 음성 안내 큐 및 재생 상태 관리
// ==========================================
const clubAudioQueues = {
    'unjeong': [],
    'daewon': []
};

const clubVoicePlayingState = {
    'unjeong': false,
    'daewon': false
};

// 💡 안전한 큐 삽입 헬퍼 함수 (외부 이벤트에서 호출용)
function pushVoiceAnnouncement(clubId, announcement) {
    const targetClub = clubId || 'unjeong';
    if (!clubAudioQueues[targetClub]) {
        clubAudioQueues[targetClub] = [];
        clubVoicePlayingState[targetClub] = false;
    }
    announcement.clubId = targetClub;
    clubAudioQueues[targetClub].push(announcement);
    console.log(`📢 [${targetClub} TV 음성 큐 등록]`, announcement.message || announcement);
}

// ==========================================
// 🔊 구장별 독립 음성 큐 처리 프로세서 (각 구장별 10초 간격 독립 발송)
// ==========================================
setInterval(() => {
    // 등록된 모든 구장 키를 순회하며 독립적으로 처리
    const activeClubIds = Object.keys(clubs);

    activeClubIds.forEach(clubId => {
        // 해당 구장의 큐가 없으면 초기화
        if (!clubAudioQueues[clubId]) {
            clubAudioQueues[clubId] = [];
            clubVoicePlayingState[clubId] = false;
        }

        // 해당 구장이 이미 방송 중이거나 대기 중인 안내가 없으면 통과
        if (clubVoicePlayingState[clubId] || clubAudioQueues[clubId].length === 0) {
            return;
        }

        // 해당 구장의 큐에서 가장 앞의 안내를 꺼냄
        const nextAnnouncement = clubAudioQueues[clubId].shift();
        clubVoicePlayingState[clubId] = true;

        // 💡 해당 구장 전용 TV 룸으로만 신호 발송 (타 구장 방송 간섭 차단)
        const targetRoom = `tv-room-${clubId}`;
        io.to(targetRoom).emit('requestVoiceAnnouncement', nextAnnouncement);
        console.log(`🎙️ [${targetRoom} 전송] TV 음성 송출 시작`);

        // 해당 구장의 음성 재생 시간(10초) 동안만 해당 구장의 다음 방송을 차단
        setTimeout(() => {
            clubVoicePlayingState[clubId] = false;
        }, 10000);
    });
}, 1000);

// ==========================================
// 1. 기본 설정 템플릿 및 전역 안전 변수선언
// ==========================================
const defaultConfig = {
    ENTRY_TIMEOUT_SEC: 180,
    NANTA_COURT_LIMIT_SEC: 900,
    ADMIN_PASSWORD: "1234",
    cleaningSchedules: [],
    cleaningStartMsg: "구장 청소 및 정비 시간입니다. 잠시 코트 이용을 중단해 주시기 바랍니다.",
    cleaningEndMsg: "구장 청소가 완료되었습니다. 코트 이용을 재개해 주시기 바랍니다.",
    useWifiRestriction: true,
    allowedGymIps: []
};

// 레거시 호환용 전역 config
let config = { ...defaultConfig };

// ==========================================
// 2. 🏸 모든 클럽 데이터를 보관하는 중앙 맵 (안전한 초기화 구조)
// ==========================================
const clubs = {
    'unjeong': {
        clubId: 'unjeong',
        clubName: '운정배드민턴클럽',
        config: { ...defaultConfig },
        courtsData: [], // 💡 선언 전 참조 에러 방지를 위해 빈 배열로 초기화
        gameQueue: [],
        nantaQueue: [],
        notifications: [],
        slotIdCounter: 1
    },
    'daewon': {
        clubId: 'daewon',
        clubName: '대원배드민턴클럽',
        config: { ...defaultConfig },
        courtsData: [], // 💡 빈 배열로 초기화
        gameQueue: [],
        nantaQueue: [],
        notifications: [],
        slotIdCounter: 1000
    }
};

// ==========================================
// 💾 [영구 저장] 클럽 설정 및 코트 구성 파일 입출력 로직
// ==========================================
const CLUBS_DATA_FILE = path.join(__dirname, 'clubs-data.json');

// 1. 파일에서 설정 불러오기
function loadClubsData() {
    try {
        if (!fs.existsSync(CLUBS_DATA_FILE)) {
            console.log('ℹ️ 저장된 clubs-data.json 파일이 없습니다. 기본값으로 새로 생성합니다.');
            saveClubsData();
            return;
        }

        const rawData = fs.readFileSync(CLUBS_DATA_FILE, 'utf-8');
        const savedData = JSON.parse(rawData);

        Object.keys(savedData).forEach(cId => {
            if (!clubs[cId]) {
                clubs[cId] = {
                    clubId: cId,
                    clubName: savedData[cId].clubName || (cId === 'unjeong' ? '운정배드민턴클럽' : (cId === 'daewon' ? '대원배드민턴클럽' : `${cId.toUpperCase()} 배드민턴클럽`)),
                    gameQueue: [],
                    nantaQueue: [],
                    notifications: [],
                    slotIdCounter: 1
                };
            }

            // 환경설정 복원
            if (savedData[cId].config) {
                clubs[cId].config = savedData[cId].config;
            }

            // 코트 구성 복원 (실시간 경기 데이터는 제외하고 코트 틀만 안전하게 생성)
            if (Array.isArray(savedData[cId].courtsData)) {
                clubs[cId].courtsData = savedData[cId].courtsData.map((c, idx) => {
                    const id = c.id || (idx + 1);
                    const type = c.type || 'game';
                    const note = c.note || '';

                    if (type === 'nanta') {
                        return {
                            id, type: 'nanta', nextType: 'nanta', note,
                            sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                            sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 }
                        };
                    } else if (type === 'lesson') {
                        return {
                            id, type: 'lesson', nextType: 'lesson', isEmpty: false,
                            players: note || '레슨 코트', note
                        };
                    } else {
                        return {
                            id, type: 'game', nextType: 'game', isEmpty: true,
                            players: '', note
                        };
                    }
                });
            }
        });

        console.log('✅ [clubs-data.json] 클럽별 영구 설정 로드 완료!');
    } catch (err) {
        console.error('❌ 클럽 데이터 로드 중 오류 발생:', err);
    }
}

// 2. 파일에 설정 저장하기
function saveClubsData() {
    try {
        const dataToSave = {};

        Object.keys(clubs).forEach(cId => {
            const club = clubs[cId];
           dataToSave[cId] = {
                clubId: club.clubId || cId,
                clubName: club.clubName || (cId === 'unjeong' ? '운정배드민턴클럽' : (cId === 'daewon' ? '대원배드민턴클럽' : `${cId.toUpperCase()} 배드민턴클럽`)),
                config: club.config,
                courtsData: (club.courtsData || []).map(c => ({
                    id: c.id,
                    type: c.type || 'game',
                    note: c.note || ''
                }))
            };
        });

        fs.writeFileSync(CLUBS_DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
        
        // 💡 [진단 로그] 실제 저장된 절대 경로와 구장별 설정 요약 출력
        const absolutePath = path.resolve(CLUBS_DATA_FILE);
        console.log(`💾 [저장 완료] 파일 절대경로: ${absolutePath}`);

        // 운정클럽 핵심 설정 1줄 요약
        const uCfg = (dataToSave['unjeong'] && dataToSave['unjeong'].config) || {};
        console.log(`📝 [unjeong 요약] 입장:${uCfg.ENTRY_TIMEOUT_SEC ?? '-'}초 | 난타:${uCfg.NANTA_COURT_LIMIT_SEC ?? '-'}초 | 음성:[입장:${uCfg.soundEntryNotice !== false ? 'ON' : 'OFF'}, 난타:${uCfg.soundNantaWarning !== false ? 'ON' : 'OFF'}, 청소:${uCfg.soundScheduleNotice !== false ? 'ON' : 'OFF'}]`);

        // 대원클럽 핵심 설정 1줄 요약 (데이터가 존재할 때만 자동 출력)
        if (dataToSave['daewon'] && dataToSave['daewon'].config) {
            const dCfg = dataToSave['daewon'].config;
            console.log(`📝 [daewon 요약] 입장:${dCfg.ENTRY_TIMEOUT_SEC ?? '-'}초 | 난타:${dCfg.NANTA_COURT_LIMIT_SEC ?? '-'}초 | 음성:[입장:${dCfg.soundEntryNotice !== false ? 'ON' : 'OFF'}, 난타:${dCfg.soundNantaWarning !== false ? 'ON' : 'OFF'}, 청소:${dCfg.soundScheduleNotice !== false ? 'ON' : 'OFF'}]`);
        }

    } catch (err) {
        console.error('❌ 클럽 데이터 저장 중 오류 발생:', err);
    }
}

// 서버 시작 시 최초 1회 즉시 로드 실행
loadClubsData();

// ==========================================
// 3. 클럽별 설정 파일 로드 (clubs-data.json 통합으로 인해 무력화)
// ==========================================
function loadConfigFromFile() {
    // 💡 clubs-data.json에서 모든 설정을 단독 관리하므로, 옛날 config.json 로딩을 차단합니다.
    return;
}

function saveConfigToFile() {
    try {
        // 💾 clubs-data.json 파일에 모든 클럽 설정 영구 저장
        if (typeof saveClubsData === 'function') {
            saveClubsData();
            console.log('💾 [설정 저장] clubs-data.json 파일에 클럽별 설정이 영구 기록되었습니다.');
        }

        const clubIds = Object.keys(clubs);
        if (typeof io !== 'undefined') {
            clubIds.forEach(cId => {
                if (clubs[cId] && clubs[cId].config) {
                    io.to(`club_${cId}`).emit('syncConfig', clubs[cId].config);
                }
            });
            console.log('📡 [실시간 동기화] 각 클럽별 클라이언트에 syncConfig 전송 완료');
        }
    } catch (err) {
        console.error('❌ [설정 저장 실패]:', err);
    }
}

// ==========================================
// 4. 구장 Wi-Fi 판별 및 getClub 헬퍼 함수
// ==========================================
function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address;
}

function isGymWifiUser(socket, clubId) {
    // 💡 호출 시 넘겨준 clubId -> 소켓에 등록된 socket.clubId -> 기본값 'unjeong' 순서로 확인
    const targetClubId = clubId || (socket && socket.clubId) || 'unjeong';
    const club = (typeof clubs !== 'undefined' && clubs[targetClubId]) ? clubs[targetClubId] : null;
    const targetConfig = (club && club.config) ? club.config : (typeof config !== 'undefined' ? config : {});

    if (targetConfig.useWifiRestriction === false) {
        return true;
    }
    if (!targetConfig.allowedGymIps || targetConfig.allowedGymIps.length === 0) {
        return true; 
    }
    const clientIp = typeof getClientIp === 'function' ? getClientIp(socket) : '';
    return targetConfig.allowedGymIps.includes(clientIp);
}

// ==========================
// 2. 서버 및 미들웨어 초기화
// ==========================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);

// 💡 실서버(Render) WebSocket 400 에러 방지를 위한 transports 및 cors 설정 추가
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;

// 생년월일(YYYY-MM-DD)을 받아 '40대', '50대' 등의 연령대 문자열로 변환하는 함수
function calculateAgeGroup(birthDateStr) {
    if (!birthDateStr) return '기타';
    const birthYear = new Date(birthDateStr).getFullYear();
    const currentYear = new Date().getFullYear();
    const age = currentYear - birthYear;
    const decade = Math.floor(age / 10) * 10;
    return `${decade}대`;
}

// ==========================================
// 정회원 가입 및 관리자 승인 관련 API
// ==========================================

// 1. 정회원 가입 신청 접수 API (구장별 격리 적용)
// 💡 수정 후: 두 경로 모두 수신 가능하도록 지정
app.post(['/api/register', '/api/register-request'], async (req, res) => {
    try {
        const { name, phone, gender, birthDate, grade, address, clubId: reqClubId, club } = req.body;
        // 💡 신청한 구장 식별자 추출 (기본값 unjeong)
        const clubId = reqClubId || club || 'unjeong';

        if (!name || !phone || !gender || !birthDate || !grade) {
            return res.status(400).json({ success: false, message: '필수 항목을 모두 입력해주세요.' });
        }

        // 1단계: 해당 구장(club_id)에 이미 정회원으로 등록되어 있는지 확인
        db.get(`SELECT * FROM regular_members WHERE phone = ? AND club_id = ?`, [phone, clubId], (err, existingMember) => {
            if (existingMember) {
                return res.status(400).json({ success: false, message: '이미 해당 클럽에 정회원으로 등록되어 있는 연락처입니다.' });
            }

            // 2단계: 해당 구장(club_id) 대기 목록에 이미 신청되어 있는지 확인
            db.get(`SELECT * FROM pending_registrations WHERE phone = ? AND club_id = ?`, [phone, clubId], (err, existingPending) => {
                if (existingPending) {
                    return res.status(400).json({ success: false, message: '이미 해당 클럽에 가입 대기 중인 연락처입니다. 관리자 승인을 기다려주세요.' });
                }

                // 3단계: club_id를 포함하여 대기 테이블에 INSERT
                const createdAt = new Date().toISOString();
                const query = `
                    INSERT INTO pending_registrations (name, phone, gender, birthDate, grade, address, status, createdAt, club_id) 
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                `;
                
                db.run(query, [name, phone, gender, birthDate, grade, address || '', createdAt, clubId], function(err) {
                    if (err) {
                        console.error('가입 신청 DB 저장 오류:', err.message);
                        return res.status(500).json({ success: false, message: '데이터베이스 저장 중 오류가 발생했습니다.' });
                    }
                    console.log(`📝 [신규 가입 신청 접수 - ${clubId}] ${name} (${phone})`);
                    res.json({ success: true, message: '정회원 가입 신청이 완료되었습니다. 관리자 승인을 기다려주세요.' });
                });
            });
        });
    } catch (error) {
        console.error('가입 신청 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 2. 관리자용: 가입 신청 대기 목록 조회 API (구장별 필터링 적용)
app.get('/api/admin/pending-members', async (req, res) => {
    const clubId = req.query.clubId || req.query.club || 'unjeong';

    try {
        db.all(
            `SELECT * FROM pending_registrations WHERE status = 'pending' AND club_id = ? ORDER BY id DESC`,
            [clubId],
            (err, rows) => {
                if (err) {
                    console.error('대기 목록 조회 오류:', err.message);
                    return res.status(500).json({ success: false, message: '데이터베이스 조회 중 오류가 발생했습니다.' });
                }
                res.json({ success: true, data: rows });
            }
        );
    } catch (error) {
        console.error('대기 목록 조회 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 3. 관리자용: 가입 신청 승인 처리 API (구장별 격리 적용)
app.post('/api/admin/approve-member', async (req, res) => {
    try {
        const { phone, action, clubId: reqClubId } = req.body;

        if (!phone || !action) {
            return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
        }

        if (action === 'approve') {
            db.get(`SELECT * FROM pending_registrations WHERE phone = ?`, [phone], (err, user) => {
                if (err || !user) {
                    return res.status(404).json({ success: false, message: '신청 내역을 찾을 수 없습니다.' });
                }

                // 💡 승인 시 적용할 클럽 식별자 결정 (요청값 우선, 없으면 대기정보의 club_id, 기본값 unjeong)
                const clubId = reqClubId || user.club_id || 'unjeong';

                // 생년월일로부터 연령대 자동 계산
                const ageGroup = typeof calculateAgeGroup === 'function' ? calculateAgeGroup(user.birthDate) : '';
                const memberId = 'reg_' + Date.now();
                const joinedAt = new Date().toISOString().split('T')[0];
                
                // 💡 club_id 컬럼 추가 (총 13개 컬럼)
                const insertQuery = `
                    INSERT INTO regular_members (id, type, username, password, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt, club_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                // 💡 물음표 13개에 대응하는 파라미터 13개 매칭
                const params = [
                    memberId,           // 1. id
                    'regular',          // 2. type
                    user.phone,         // 3. username
                    '1234',             // 4. password
                    user.name,          // 5. name
                    user.gender,        // 6. gender
                    user.birthDate,     // 7. birthDate
                    ageGroup,           // 8. ageGroup
                    user.grade,         // 9. grade
                    user.phone,         // 10. phone
                    user.address || '', // 11. address
                    joinedAt,           // 12. joinedAt
                    clubId              // 13. club_id
                ];

                db.run(insertQuery, params, (insertErr) => {
                    if (insertErr) {
                        console.error('정회원 테이블 등록 오류:', insertErr.message);
                        if (insertErr.message.includes('UNIQUE constraint failed')) {
                            return res.status(400).json({ success: false, message: '이미 동일한 연락처로 등록된 정회원이 존재합니다.' });
                        }
                        return res.status(500).json({ success: false, message: '정회원 등록 중 오류가 발생했습니다.' });
                    }

                    // 💡 해당 구장의 승인 대기 내역에서 삭제
                    db.run(`DELETE FROM pending_registrations WHERE phone = ?`, [phone], () => {
                        res.json({ success: true, message: '정회원 가입이 승인되었습니다.' });
                    });
                });
            });
        } else {
            // 반려 처리
            db.run(`DELETE FROM pending_registrations WHERE phone = ?`, [phone], (err) => {
                if (err) {
                    return res.status(500).json({ success: false, message: '반려 처리 중 오류가 발생했습니다.' });
                }
                res.json({ success: true, message: '가입 신청이 반려되었습니다.' });
            });
        }
    } catch (error) {
        console.error('가입 승인 처리 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 4. 정회원 탈퇴 처리 API (구장별 격리 및 대기열 정리 적용)
app.post('/api/member/withdraw', async (req, res) => {
    try {
        const { phone, name, clubId: reqClubId, club } = req.body;
        const clubId = reqClubId || club || 'unjeong'; // 💡 클럽 식별자 추출

        if (!phone) {
            return res.status(400).json({ success: false, message: '회원 정보를 확인할 수 없습니다.' });
        }

        // 1. regular_members 테이블에서 해당 클럽(club_id)의 회원만 특정하여 삭제
        db.run(`DELETE FROM regular_members WHERE phone = ? AND club_id = ?`, [phone, clubId], function(err) {
            if (err) {
                console.error(`❌ 회원 탈퇴 처리 오류 (${clubId} regular_members):`, err.message);
                return res.status(500).json({ success: false, message: '탈퇴 처리 중 서버 오류가 발생했습니다.' });
            }

            // 2. 해당 클럽의 pending_registrations 대기 내역만 삭제
            db.run(`DELETE FROM pending_registrations WHERE phone = ? AND club_id = ?`, [phone, clubId], async (pendingErr) => {
                if (pendingErr) {
                    console.error(`❌ 대기 테이블 정리 오류 (${clubId}):`, pendingErr.message);
                }

                // 3. 💡 혹시 해당 구장의 코트나 대기열에 회원이 들어가 있다면 즉시 정리
                if (typeof cleanupUser === 'function') {
                    try {
                        await cleanupUser(phone, clubId);
                    } catch (cleanErr) {
                        console.error('탈퇴 유저 대기열 정리 오류:', cleanErr);
                    }
                }

                console.log(`🗑️ [${clubId} 회원 탈퇴 및 정리 완료]: 전화번호 ${phone} (${name || '이름미확인'})`);
                res.json({ success: true, message: '정상적으로 탈퇴 처리되었습니다.' });
            });
        });
    } catch (error) {
        console.error('회원 탈퇴 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// ==========================================
// 🏢 [멀티 테넌트] 등록된 전체 클럽 목록 조회 API
// ==========================================
app.get('/api/clubs', (req, res) => {
    try {
        // clubs 데이터 객체에 등록된 구장들을 동적으로 추출
        const clubList = Object.keys(clubs).map(clubId => {
            const club = clubs[clubId] || {};
            const config = club.config || {};

            // 표시용 구장 이름 (clubName 속성 우선 참조 및 신규 클럽 자동 완성)
            let displayName = club.clubName || club.name || config.clubName;
            if (!displayName) {
                if (clubId === 'unjeong') displayName = '운정배드민턴클럽';
                else if (clubId === 'daewon') displayName = '대원배드민턴클럽';
                else displayName = `${clubId.toUpperCase()} 배드민턴클럽`;
            }

            return {
                id: clubId,                                                // 구장 식별자 (예: unjeong, daewon)
                name: displayName,                                        // 화면에 보여줄 이름
                courtCount: Array.isArray(club.courtsData) ? club.courtsData.length : 0, // 총 코트 수
                isActive: true
            };
        });

        res.json({ success: true, clubs: clubList });
    } catch (err) {
        console.error('클럽 목록 조회 에러:', err);
        res.status(500).json({ success: false, message: '클럽 목록 조회 실패' });
    }
});

// ==========================
// 3. 데이터베이스(SQLite) 연결 및 초기화
// ==========================
// 💡 상단에서 선언한 영구 디스크 대응 dbPath 변수를 그대로 사용합니다.
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 데이터베이스 연결 실패:', err.message);
    } else {
        console.log('✅ SQLite 데이터베이스 연결 성공:', dbPath);
        initDatabase();
        insertDefaultDummyData(); 
    }
});

function initDatabase() {
    // 1. 기존 테이블의 전체 UNIQUE 제약조건을 풀고 구장별 분리 구조로 안전 변환
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS regular_members (
                id TEXT PRIMARY KEY,
                club_id TEXT DEFAULT 'unjeong',
                type TEXT,
                username TEXT,
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
        `);

        // 혹시 기존 테이블에 phone UNIQUE가 걸려 있다면 안전하게 새 구조로 이전
        db.all(`PRAGMA index_list(regular_members)`, (err, indexes) => {
            const hasGlobalUnique = indexes && indexes.some(idx => idx.unique && idx.origin === 'u');
            if (hasGlobalUnique) {
                console.log('🔄 [DB 마이그레이션] 정회원 테이블을 구장별 독립 가입 구조로 갱신합니다...');
                db.run(`ALTER TABLE regular_members RENAME TO old_regular_members`, () => {
                    db.run(`
                        CREATE TABLE regular_members (
                            id TEXT PRIMARY KEY,
                            club_id TEXT DEFAULT 'unjeong',
                            type TEXT,
                            username TEXT,
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
                    `, () => {
                        db.run(`
                            INSERT INTO regular_members 
                            SELECT id, COALESCE(club_id, 'unjeong'), type, username, password, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt 
                            FROM old_regular_members
                        `, () => {
                            db.run(`DROP TABLE old_regular_members`);
                            // 구장 + 전화번호 조합으로만 중복 검사 (구장별 1회 가입 허용)
                            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_club_phone ON regular_members(club_id, phone)`);
                            console.log('✅ [DB 마이그레이션 완료] 구장별 독립 정회원 등록이 가능해졌습니다.');
                        });
                    });
                });
            } else {
                // 구장별 유니크 인덱스 생성
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_club_phone ON regular_members(club_id, phone)`);
            }
        });

        // 2. 가입 대기 테이블 club_id 보정
        db.run(`
            CREATE TABLE IF NOT EXISTS pending_registrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                club_id TEXT DEFAULT 'unjeong',
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                gender TEXT,
                birthDate TEXT,
                grade TEXT,
                address TEXT, 
                status TEXT DEFAULT 'pending',
                createdAt TEXT NOT NULL
            )
        `, () => {
            db.run(`ALTER TABLE pending_registrations ADD COLUMN club_id TEXT DEFAULT 'unjeong'`, () => {});
            db.run(`ALTER TABLE pending_registrations ADD COLUMN address TEXT`, () => {});
        });

        // 3. 일일 게스트 테이블
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

        // 4. 공지사항 테이블
        db.run(`
            CREATE TABLE IF NOT EXISTS notices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                author TEXT DEFAULT '관리자',
                createdAt TEXT NOT NULL
            )
        `, (err) => {
            if (!err) {
                db.get(`SELECT COUNT(*) as count FROM notices`, (err, row) => {
                    if (row && row.count === 0) {
                        db.run(`INSERT INTO notices (title, content, author, createdAt) VALUES (?, ?, ?, ?)`,
                            ['체육관 이용 수칙 안내', '체육관 내 음료 및 음식물 반입을 금지합니다. 즐거운 배드민턴 되세요!', '관리자', '2026-09-03']
                        );
                    }
                });
            }
        });

        checkAndInsertDefaultData();
    });
}

function checkAndInsertDefaultData() {
    // 🛑 기존 정회원/더미 데이터 자동 생성을 원하지 않으므로 기능을 차단(주석 처리)합니다.
    /*
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

        // 서버가 켜질 때 로그인 테스트용 계정 몇 개를 터미널에 출력
        db.all(`SELECT name, phone FROM regular_members LIMIT 5`, (err, rows) => {
            if (!err && rows) {
                console.log('📋 [로그인 테스트용 정회원 샘플 명단]');
                rows.forEach((member, idx) => {
                    console.log(`  ${idx + 1}. 이름: ${member.name} / 전화번호: ${member.phone}`);
                });
            }
        });
    });
    */
}

function insertDefaultDummyData() {}

// 정적 파일 및 라우팅 설정
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ⚙️ [멀티 테넌트] 클럽별 환경 설정 조회 API
// ==========================================
app.get('/api/config', (req, res) => {
    const clubId = req.query.club || 'unjeong';
    const targetClub = getClub(clubId);
    
    if (targetClub && targetClub.config) {
        return res.json(targetClub.config);
    }
    res.json(config);
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/tv', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/super-admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'super-admin.html'));
});

// ==========================
// [수정] 클럽별 분리된 공지사항 관련 API 및 라우트
// ==========================

// 1. 공지사항 목록 조회 API (구장별 필터링)
app.get('/api/notices', (req, res) => {
    const clubId = req.query.clubId || req.query.club || 'unjeong';

    db.all(`SELECT * FROM notices WHERE clubId = ? ORDER BY id DESC`, [clubId], (err, rows) => {
        if (err) {
            console.error('❌ 공지사항 조회 실패:', err.message);
            return res.status(500).json({ success: false, message: '공지사항을 불러오지 못했습니다.' });
        }
        res.json(rows);
    });
});

// 2. 관리자용 공지사항 등록 API (클럽별 저장 및 해당 구장에만 실시간 전송)
app.post('/api/admin/notice', (req, res) => {
    const { title, content, author, clubId: reqClubId, club } = req.body;
    const clubId = reqClubId || club || 'unjeong';

    if (!title || !content) {
        return res.status(400).json({ success: false, message: '제목과 내용을 모두 입력해 주세요.' });
    }

    const createdAt = new Date().toISOString().split('T')[0];
    db.run(
        `INSERT INTO notices (title, content, author, createdAt, clubId) VALUES (?, ?, ?, ?, ?)`,
        [title, content, author || '관리자', createdAt, clubId],
        function(err) {
            if (err) {
                console.error('❌ 공지 등록 실패:', err.message);
                return res.status(500).json({ success: false, message: '공지 등록 중 오류가 발생했습니다.' });
            }
            
            const newNotice = { id: this.lastID, title, content, author: author || '관리자', createdAt, clubId };

            // 📌 해당 구장 룸(club_${clubId}) 사용자들에게만 실시간 공지 전송
            io.to(`club_${clubId}`).emit('noticeUpdated', newNotice);

            res.json({ success: true, message: '공지사항이 성공적으로 등록되었습니다.', id: this.lastID });
        }
    );
});

// 3. 공지사항 수정 API
app.put('/api/notices/:id', (req, res) => {
    const noticeId = req.params.id;
    const { title, content } = req.body;

    db.run(`UPDATE notices SET title = ?, content = ? WHERE id = ?`, [title, content, noticeId], function(err) {
        if (err) {
            console.error('❌ 공지사항 수정 실패:', err.message);
            return res.status(500).json({ success: false, message: '공지사항 수정에 실패했습니다.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: '해당 공지사항을 찾을 수 없습니다.' });
        }
        res.json({ success: true, message: '공지사항이 수정되었습니다.' });
    });
});

// 4. 공지사항 삭제 API
app.delete('/api/notices/:id', (req, res) => {
    const noticeId = req.params.id;

    db.run(`DELETE FROM notices WHERE id = ?`, [noticeId], function(err) {
        if (err) {
            console.error('❌ 공지사항 삭제 실패:', err.message);
            return res.status(500).json({ success: false, message: '공지사항 삭제에 실패했습니다.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: '해당 공지사항을 찾을 수 없습니다.' });
        }
        res.json({ success: true, message: '공지사항이 삭제되었습니다.' });
    });
});

// 5. 공지사항 상세 게시판 페이지 라우트
app.get('/notice', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'notice.html'));
});

// 1. 회원 목록 조회 API (구장별 필터링 적용)
app.get('/api/members', (req, res) => {
    const clubId = req.query.clubId || req.query.club || 'unjeong';

    // 💡 club_id 컬럼으로 해당 클럽 회원만 필터링하여 조회
    db.all(`SELECT id, username, name, gender, birthDate, ageGroup, grade, phone, address, club_id FROM regular_members WHERE club_id = ?`, [clubId], (err, rows) => {
        if (err) {
            console.error('❌ 회원 목록 조회 실패:', err.message);
            return res.status(500).json({ success: false, error: '데이터베이스 조회 실패', message: '회원 목록을 불러오지 못했습니다.' });
        }

        const processedRows = rows.map(member => {
            if ((!member.ageGroup || member.ageGroup.trim() === '' || member.ageGroup === '/ /') && member.birthDate) {
                member.ageGroup = calculateAgeGroup(member.birthDate);
            }
            return member;
        });

        res.json(processedRows);
    });
});

// 📌 연령대 계산 헬퍼 함수 (서버 내에 없다면 이 함수도 함께 추가해주세요)
function calculateAgeGroup(birthDate) {
    if (!birthDate) return '';
    const birthYear = parseInt(birthDate.split('-')[0], 10);
    if (isNaN(birthYear)) return '';

    const currentYear = new Date().getFullYear();
    const age = currentYear - birthYear;
    const decade = Math.floor(age / 10) * 10;

    return `${decade}대`; // 📌 반드시 뒤에 '대'가 붙어 있어야 합니다!
}

// 2. 로그인 처리 API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get(`SELECT * FROM regular_members WHERE username = ? OR id = ?`, [username, username], (err, user) => {
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

// 📌 [추가] 정회원 가입 신청 API
app.post('/api/register-request', (req, res) => {
    const { name, phone, gender, birthDate, grade } = req.body;

    if (!name || !phone || !birthDate) {
        return res.status(400).json({ message: '필수 입력 항목(이름, 전화번호, 생년월일)이 누락되었습니다.' });
    }

    // 중복 전화번호 체크 (정회원 테이블 또는 대기 테이블에 이미 존재하는지 확인)
    db.get(`SELECT phone FROM regular_members WHERE phone = ? UNION SELECT phone FROM pending_members WHERE phone = ?`, [phone, phone], (err, row) => {
        if (err) {
            console.error('DB 조회 에러:', err.message);
            return res.status(500).json({ message: '서버 내부 오류가 발생했습니다.' });
        }

        if (row) {
            return res.status(400).json({ message: '이미 가입되었거나 신청된 전화번호입니다.' });
        }

        // 고유 ID 생성 (예: pending_시간밀리초) 및 연령대 계산
        const pendingId = 'pending_' + Date.now();
        const birthYear = parseInt(String(birthDate).substring(0, 4)) || 1990;
        const currentYear = new Date().getFullYear(); // 2026 등 현재 연도
        const age = currentYear - birthYear;
        const ageGroup = `${Math.floor(age / 10) * 10}대`;
        
        const address = '경기도 파주시'; // 기본 주소 설정 (필요시 폼에서 받도록 확장 가능)
        const requestedAt = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

        const query = `
            INSERT INTO pending_members (id, name, phone, gender, birthDate, ageGroup, grade, address, requestedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [pendingId, name, phone, gender, birthDate, ageGroup, grade, address, requestedAt], function(err) {
            if (err) {
                console.error('승인 대기 데이터 저장 실패:', err.message);
                return res.status(500).json({ message: '가입 신청 저장에 실패했습니다.' });
            }

            console.log(`📝 [가입신청] ${name} (${phone}) 님이 가입을 신청했습니다.`);
            res.status(200).json({ success: true, message: '가입 신청이 성공적으로 접수되었습니다.' });
        });
    });
});

// 회원 정보 수정 API
app.post('/api/member/update', (req, res) => {
    const { id, phone, grade, address } = req.body;

    const query = `UPDATE regular_members SET phone = ?, grade = ?, address = ? WHERE id = ?`;
    db.run(query, [phone, grade, address], function(err) {
        if (err) {
            console.error('❌ 회원 정보 수정 실패:', err.message);
            return res.status(500).json({ success: false, message: '수정 중 오류가 발생했습니다.' });
        }
        res.json({ success: true, message: '회원 정보가 수정되었습니다.' });
    });
});

// 3. 🧹 [디버깅 로그가 강화된 슬롯 청소 및 자동 방 폭파 함수]
async function cleanupUser(usernameOrObj, clubId = null) { // 💡 특정 구장이 없으면 전 구장 자동 청소
    if (!usernameOrObj) {
        console.log("⚠️ [청소 중단] 전달된 유저 정보가 없습니다.");
        return;
    }

    let targetId = '';
    let targetName = '';

    if (typeof usernameOrObj === 'object' && usernameOrObj !== null) {
        targetId = usernameOrObj.id || usernameOrObj.phone || '';
        targetName = usernameOrObj.name || '';
    } else if (typeof usernameOrObj === 'string') {
        if (usernameOrObj.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(usernameOrObj);
                targetId = parsed.id || parsed.phone || '';
                targetName = parsed.name || '';
            } catch (e) {
                targetId = usernameOrObj;
                targetName = usernameOrObj;
            }
        } else {
            targetId = usernameOrObj;
            targetName = usernameOrObj;
        }
    }

    // DB에서 해당 유저의 정확한 정보(이름, ID 등)를 조회
    let dbRow = null;
    if (targetId === '010-0000-0000' || targetName === '관리자' || targetId === '관리자') {
        dbRow = { id: '010-0000-0000', name: '관리자' };
    } else {
        try {
            dbRow = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT id, name FROM regular_members WHERE id = ? OR phone = ? OR name = ?`, 
                    [targetId, targetId, targetName], 
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row || null);
                    }
                );
            });
        } catch (e) {
            console.error('❌ [청소 DB 조회 에러]:', e.message);
        }
    }

    const realId = dbRow ? dbRow.id : targetId;
    const realName = dbRow ? dbRow.name : targetName;

    // 💡 구장이 특정되지 않은 경우 모든 활성 구장(운정, 대원 등)을 대상으로 청소
    const targetClubs = (clubId && clubId !== 'all') 
        ? [clubId] 
        : (typeof clubs !== 'undefined' ? Object.keys(clubs) : ['unjeong', 'daewon']);

    console.log(`\n========================================`);
    console.log(`🧹 [청소 시작] 대상: "${realName}" (ID: ${realId}), 검사 대상 구장:`, targetClubs);

    for (const cid of targetClubs) {
        const club = (typeof getClub === 'function') ? getClub(cid) : (typeof clubs !== 'undefined' ? clubs[cid] : null);
        if (!club) continue;

        const gameQueue = club.gameQueue;
        const nantaQueue = club.nantaQueue;

        // 1️⃣ 게임 대기열 청소
        if (Array.isArray(gameQueue)) {
            const validGameQueue = [];
            gameQueue.forEach((slot) => {
                const slotStr = JSON.stringify(slot);
                const isMatched = 
                    (realId && slotStr.includes(realId)) ||
                    (realName && slotStr.includes(realName));

                if (isMatched) {
                    if (slot.userIds && Array.isArray(slot.userIds)) {
                        slot.userIds = slot.userIds.filter(id => id !== realId);
                    }
                    if (slot.players && Array.isArray(slot.players)) {
                        slot.players = slot.players.map(p => {
                            if (!p) return '';
                            const pStr = typeof p === 'object' ? JSON.stringify(p) : String(p);
                            if (
                                (realId && pStr.includes(realId)) ||
                                (realName && pStr.includes(realName))
                            ) {
                                return '';
                            }
                            return p;
                        });
                    }
                }

                const validPlayers = (typeof getValidPlayers === 'function') 
                    ? getValidPlayers(slot.players) 
                    : (slot.players || []).filter(p => p && p !== '');
                
                if (validPlayers.length > 0) {
                    validGameQueue.push(slot);
                }
            });

            gameQueue.length = 0;
            gameQueue.push(...validGameQueue);
        }

        // 2️⃣ 난타 대기열 청소
        if (Array.isArray(nantaQueue)) {
            const validNantaQueue = [];
            nantaQueue.forEach((slot) => {
                const slotStr = JSON.stringify(slot);
                const isMatched = 
                    (realId && slotStr.includes(realId)) ||
                    (realName && slotStr.includes(realName));

                if (isMatched) {
                    if (slot.userIds && Array.isArray(slot.userIds)) {
                        slot.userIds = slot.userIds.filter(id => id !== realId);
                    }
                    if (slot.players && Array.isArray(slot.players)) {
                        slot.players = slot.players.map(p => {
                            if (!p) return '';
                            const pStr = typeof p === 'object' ? JSON.stringify(p) : String(p);
                            if (
                                (realId && pStr.includes(realId)) ||
                                (realName && pStr.includes(realName))
                            ) {
                                return '';
                            }
                            return p;
                        });
                    }
                }

                const validPlayers = (typeof getValidPlayers === 'function') 
                    ? getValidPlayers(slot.players) 
                    : (slot.players || []).filter(p => p && p !== '');

                if (validPlayers.length > 0) {
                    validNantaQueue.push(slot);
                }
            });

            nantaQueue.length = 0;
            nantaQueue.push(...validNantaQueue);
        }

        // 💡 각 구장에 대기방 삭제 최신 상태를 실시간 방송
        if (typeof broadcastState === 'function') {
            broadcastState(cid);
        }
    }

    console.log(`========================================\n`);
}

// 4. 로그아웃 API
app.post('/api/logout', async (req, res) => {
    const { username, user } = req.body;
    const target = user || username;
    console.log(`🧹 [로그아웃 요청 수신] 유저 데이터 정리 중...`, target);
    if (target) {
        await cleanupUser(target);
    }
    res.json({ success: true });
});

// 관리자 모드: 강제 퇴장 API
app.post('/api/admin/kick-user', async (req, res) => {
    const target = req.body.targetUsername || req.body.targetId || req.body.username;
    const clubId = req.body.clubId || req.body.club || 'unjeong'; // 💡 1. 클럽 아이디 추출

    if (!target) {
        console.log('❌ [관리자 강제 퇴장 실패] 전달된 회원 식별자가 없습니다.', req.body);
        return res.status(400).json({ success: false, message: '퇴장시킬 회원 정보가 없습니다.' });
    }

    console.log(`🚨 [관리자 강제 퇴장 요청 - ${clubId}] 타겟 식별자:`, target);

    // 💡 2. cleanupUser 호출할 때 반드시 뒤에 clubId를 함께 넘겨줍니다!
    await cleanupUser(target, clubId);

    res.json({ success: true, message: `해당 회원을 성공적으로 강제 퇴장 및 정리했습니다.` });
});

app.post('/api/admin/delete-room', (req, res) => {
    const { roomType, roomId, clubId = 'unjeong' } = req.body; // 💡 요청에서 clubId를 함께 받습니다 (기본값 unjeong)

    if (!roomType || roomId === undefined) {
        return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    }

    // 💡 해당 클럽의 데이터를 가져옵니다.
    const club = getClub(clubId);

    if (roomType === 'game' && Array.isArray(club.gameQueue)) {
        club.gameQueue = club.gameQueue.filter(slot => slot.id !== roomId && slot.slotId !== roomId);
        console.log(`💥 [관리자 게임방 강제 종료 - ${clubId}] 게임방(${roomId})이 삭제되었습니다.`);
    } else if (roomType === 'nanta' && Array.isArray(club.nantaQueue)) {
        club.nantaQueue = club.nantaQueue.filter(slot => slot.id !== roomId && slot.slotId !== roomId);
        console.log(`💥 [관리자 난타방 강제 종료 - ${clubId}] 난타방(${roomId})이 삭제되었습니다.`);
    } else {
        return res.json({ success: false, message: '존재하지 않는 방이거나 타입 오류입니다.' });
    }

    // 💡 빈 괄호 대신 명확히 해당 클럽 아이디를 전달합니다.
    if (typeof broadcastState === 'function') {
        broadcastState(clubId);
    }

    res.json({ success: true, message: '해당 방이 강제 종료되었습니다.' });
});

app.post('/api/admin/clear-court', (req, res) => {
    const { courtId, side, clubId = 'unjeong' } = req.body; // 💡 요청에서 clubId를 함께 받습니다

    if (courtId === undefined) {
        return res.status(400).json({ success: false, message: '코트 번호가 지정되지 않았습니다.' });
    }

    // 💡 해당 클럽의 코트 데이터를 가져옵니다.
    const club = getClub(clubId);
    const targetCourt = club.courtsData.find(c => c.id === Number(courtId));

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

    // 💡 해당 클럽 룸에만 실시간 상태 및 알림 브로드캐스트
    if (typeof io !== 'undefined') {
        io.to(`club_${clubId}`).emit('courtClearedNotice', {
            courtId: targetCourt.id,
            category: courtCategory,
            message: noticeMessage
        });
    }

    if (typeof broadcastState === 'function') {
        broadcastState(clubId); // 💡 클럽 아이디 전달
    }

    res.json({ success: true, message: `${targetCourt.id}번 코트가 성공적으로 강제 비워졌습니다.` });
});

// ==========================================
// 4. 인메모리 데이터 상태 관리
// =========================================
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
// 🏢 [멀티 테넌트 1단계] 클럽별 상태 통합 저장소
// ==========================================

// 각 클럽이 처음 생성될 때 사용할 기본 코트 템플릿
function createDefaultCourts() {
    return [
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
}

// 클럽 ID로 해당 클럽 데이터 객체를 안전하게 가져오는 헬퍼 함수
function getClub(clubId) {
    const id = clubId || 'unjeong'; // 지정이 없으면 기본값은 무조건 'unjeong'
    
    // 🏢 기본 한글 클럽 명칭 매핑
    const defaultClubNames = {
        'unjeong': '운정배드민턴클럽',
        'daewon': '대원배드민턴클럽'
    };

    if (!clubs[id]) {
        // 새 클럽이 처음 호출되면 기본 틀을 자동 생성
        clubs[id] = {
            clubId: id,
            clubName: defaultClubNames[id] || `${id}배드민턴클럽`,
            config: {
                ...(typeof defaultConfig !== 'undefined' ? defaultConfig : {}),
                // ⏱️ 클럽별 유예 시간 기본값 (관리자가 변경 가능)
                queueGraceMinutes: 30,    // 대기방 유지 시간 (기본 30분)
                sessionExpireMinutes: 60  // 세션 완전 만료 시간 (기본 60분)
            },
            courtsData: typeof createDefaultCourts === 'function' ? createDefaultCourts() : (typeof courtsData !== 'undefined' ? JSON.parse(JSON.stringify(courtsData)) : []),
            gameQueue: [],
            nantaQueue: [],
            notifications: [],
            slotIdCounter: 1
        };
    }
    return clubs[id];
}
// ==========================================
// 5. 유틸리티 및 브로드캐스트 함수
// ==========================================
// ==========================================
// 📡 [멀티 테넌트] 클럽별 실시간 상태 브로드캐스트
// ==========================================
function broadcastState(targetClubId) {
    if (!io) return;

    const sendClubState = (cid) => {
        const club = (typeof getClub === 'function') ? getClub(cid) : (typeof clubs === 'object' ? clubs[cid] : {});
        
        // 💡 club 내부에 데이터가 아직 연결되지 않았을 경우, 운정 기본 전역 변수로 안전하게 대체(fallback)
        const cCourtsData = (club && Array.isArray(club.courtsData) && club.courtsData.length > 0)
            ? club.courtsData
            : (cid === 'unjeong' && typeof courtsData !== 'undefined' ? courtsData : (club ? club.courtsData : []));

        const cGameQueue = (club && Array.isArray(club.gameQueue))
            ? club.gameQueue
            : (cid === 'unjeong' && typeof gameQueue !== 'undefined' ? gameQueue : []);

        const cNantaQueue = (club && Array.isArray(club.nantaQueue))
            ? club.nantaQueue
            : (cid === 'unjeong' && typeof nantaQueue !== 'undefined' ? nantaQueue : []);

        const cNotifications = (club && club.notifications) || (typeof notifications !== 'undefined' ? notifications : []);
        const cConfig = (club && club.config) || (typeof config !== 'undefined' ? config : {});

        // 💡 [진단 로그 추가] 서버가 화면으로 실제로 보내고 있는 설정값 확인
        // console.log(`📡 [${cid}] 화면 전송 설정값 -> 입장제한: ${cConfig.ENTRY_TIMEOUT_SEC}초, 비밀번호: ${cConfig.ADMIN_PASSWORD}`);

        io.to(`club_${cid}`).emit('stateUpdated', {
            clubId: (club && club.clubId) || cid,
            // 🏢 [수정] 하드코딩 제거: clubName -> name -> cid 순서로 유연하게 매칭
            clubName: (club && (club.clubName || club.name)) || cid,
            courtsData: cCourtsData || [],
            gameQueue: cGameQueue || [],
            nantaQueue: cNantaQueue || [],
            notifications: cNotifications,
            config: cConfig
        });
    };

    // 1. 특정 클럽만 갱신할 때
    if (targetClubId) {
        sendClubState(targetClubId);
        return;
    }

    // 2. 전체 클럽 갱신할 때
    const clubIds = (typeof clubs === 'object' && Object.keys(clubs).length > 0) ? Object.keys(clubs) : ['unjeong'];
    clubIds.forEach((cid) => {
        sendClubState(cid);
    });
}

// ==========================================
// 🔔 개인 이벤트 알림 처리 (구장 식별 및 당일 자동 정리)
// ==========================================
function addNotification(message, clubId = 'default', targetUser = null) {
    const now = new Date();
    // 📅 오늘 날짜 추출 (YYYY-MM-DD)
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    // 💡 1. 당일(오늘) 알림만 서버 메모리에 유지 (어제 이전 알림 자동 정리)
    if (Array.isArray(notifications)) {
        notifications = notifications.filter(n => {
            if (!n) return false;
            let itemDate = n.date;
            if (!itemDate && n.timestamp) {
                const d = new Date(n.timestamp);
                itemDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
            return itemDate === todayStr;
        });
    } else {
        notifications = [];
    }

    // 💡 2. 새 알림 객체 생성 (구장 ID 및 대상자 포함)
    const newNoti = { 
        message, 
        clubId: clubId || 'default',
        targetUser: targetUser || null,
        time: timeStr, 
        date: todayStr,
        timestamp: now.getTime() 
    };

    notifications.unshift(newNoti);
    if (notifications.length > 50) notifications.pop();

    // 💡 3. 소켓 브로드캐스트 (클라이언트에서 본인 및 구장 필터링 수행)
    try {
        if (typeof io !== 'undefined' && io) {
            io.emit('newNotification', newNoti);
        }
    } catch (err) {
        console.error('알림 소켓 전송 에러:', err);
    }
}

function getValidPlayers(playersArr) {
    return (playersArr || []).filter(p => p && p.trim() !== '');
}

setInterval(() => {
    const now = Date.now();
    const nowObj = new Date();
    const currentHHMM = `${String(nowObj.getHours()).padStart(2, '0')}:${String(nowObj.getMinutes()).padStart(2, '0')}`;

    // 🏢 [멀티 테넌트] 등록된 각 클럽별로 독립적으로 청소 시간, 대기열 및 코트 타이머 순회
    const clubIdsToRun = (typeof clubs === 'object' && Object.keys(clubs).length > 0) ? Object.keys(clubs) : ['unjeong'];

    clubIdsToRun.forEach(cId => {
        const club = clubs[cId] || {};
        
        // 💡 공용 config가 아니라 해당 클럽의 고유 config를 확실하게 보장
        if (!club.config) {
            club.config = JSON.parse(JSON.stringify(typeof config !== 'undefined' ? config : {}));
        }
        const clubConfig = club.config; 

        // 타이머 체크 로그
        // console.log(`🔍 [타이머 체크] 클럽: ${cId}, 현재 설정된 청소시작멘트:`, clubConfig.cleaningStartMsg);
        
        // 클럽별 독립된 청소 상태 관리 (클럽 객체 내부에 isCleaningTime 유지)
        if (typeof club.isCleaningTime === 'undefined') {
            club.isCleaningTime = false;
        }

        const cGameQueue = club.gameQueue || (cId === 'unjeong' ? gameQueue : []);
        const cNantaQueue = club.nantaQueue || (cId === 'unjeong' ? nantaQueue : []);
        const cCourtsData = club.courtsData || (cId === 'unjeong' ? courtsData : []);

        const schedules = clubConfig.cleaningSchedules || [];
        const activeSchedule = schedules.find(s => currentHHMM >= s.start && currentHHMM < s.end);

        // 1) 해당 클럽의 청소 시작 시점 감지
        if (activeSchedule && !club.isCleaningTime) {
            club.isCleaningTime = true;

            const startMsg = clubConfig.cleaningStartMsg || '구장 청소 및 정비 시간입니다. 잠시 코트 이용을 중단해 주시기 바랍니다.';
           
            // 💡 수정 후: 구장별 독립 큐로 전송
            pushVoiceAnnouncement(cId, {
                clubId: cId,
                matchType: '공지',
                names: [],
                message: startMsg
            });

            // 해당 클럽 룸에만 전송
            io.to(`club_${cId}`).emit('toastAlert', `🧹 ${startMsg}`);

            io.to(`tv-room_${cId}`).emit('tvCleaningAlert', {
                clubId: cId, // 💡 클럽 ID 명시
                type: 'start',
                title: '🧹 구장 청소 및 코트 정비 시간',
                message: startMsg,
                duration: 10000
            });

            if (typeof addNotification === 'function') {
                addNotification(`🧹 [구장 청소 시작] ${startMsg}`, cId);
            }
        }

        // 2) 해당 클럽의 청소 종료 시점 감지
        if (!activeSchedule && club.isCleaningTime) {
            club.isCleaningTime = false;

            const endMsg = clubConfig.cleaningEndMsg || '구장 청소가 완료되었습니다. 코트 이용을 재개해 주시기 바랍니다.';

            pushVoiceAnnouncement(cId,  {
                clubId: cId,
                matchType: '공지',
                names: [],
                message: endMsg
            });

            io.to(`club_${cId}`).emit('toastAlert', `🏸 ${endMsg}`);

            io.to(`tv-room_${cId}`).emit('tvCleaningAlert', {
                clubId: cId, // 💡 클럽 ID 명시
                type: 'end',
                title: '🏸 구장 청소 완료 안내',
                message: endMsg,
                duration: 8000
            });

            if (typeof addNotification === 'function') {
                addNotification(`✅ [구장 청소 종료] ${endMsg}`, cId);
            }
        }

        // 3) 청소 진행 중인 경우 해당 클럽의 타이머 동결 처리
        if (club.isCleaningTime) {
            if (Array.isArray(cGameQueue)) {
                cGameQueue.forEach(slot => { if (slot.fullAt) slot.fullAt += 1000; });
            }
            if (Array.isArray(cNantaQueue)) {
                cNantaQueue.forEach(slot => { if (slot.fullAt) slot.fullAt += 1000; });
            }
            if (Array.isArray(cCourtsData)) {
                cCourtsData.forEach(court => {
                    if (court.type === 'nanta') {
                        ['sideA', 'sideB'].forEach(side => {
                            if (court[side] && !court[side].isEmpty && court[side].startTime) {
                                court[side].startTime += 1000;
                            }
                        });
                    }
                });
            }

            if (typeof broadcastState === 'function') {
                broadcastState(cId);
            }
            return; // 이 클럽의 이번 틱은 청소로 인해 대기/진행 타이머 동결
        }

        // -------------------------------------------------------------
        // 아래부터는 기존의 게임 및 난타 대기열/코트 타이머 루프 로직 그대로 유지
        // -------------------------------------------------------------

        // 1. 게임 코트 및 게임 대기열 처리
        const emptyGameCourtsCount = cCourtsData.filter(c => c.type === 'game' && c.isEmpty).length;
        let activeTimerCount = 0;

        cGameQueue.forEach((slot) => {
            const validCount = getValidPlayers(slot.players).length;
            
            if (validCount === 4 && activeTimerCount < emptyGameCourtsCount) {
                activeTimerCount++;
                
                if (!slot.fullAt) {
                    slot.fullAt = now;
                }
                
                const elapsed = Math.floor((now - slot.fullAt) / 1000);
                slot.remainingSeconds = Math.max(0, clubConfig.ENTRY_TIMEOUT_SEC - elapsed);

                if (elapsed === 30 && !slot.announced) {
                    slot.announced = true;
                    const validPlayers = getValidPlayers(slot.players);
                    const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                    
                    const emptyGameCourts = cCourtsData.filter(c => c.type === 'game' && c.isEmpty);
                    const targetCourt = emptyGameCourts[activeTimerCount - 1] || emptyGameCourts[0];
                    const courtNum = targetCourt ? targetCourt.id : '';

                    // 💡 수정 후: 구장별 독립 큐로 전송
                    pushVoiceAnnouncement(cId, {
                        clubId: cId,
                        courtNumber: courtNum,
                        names: memberNames,
                        matchType: '게임'
                    });

                    io.to(`club_${cId}`).emit('entryPopupAlert', {
                        clubId: cId, // 💡 [추가] 클럽 ID 명시
                        matchType: '게임',
                        courtNumber: courtNum,
                        targetPlayers: memberNames
                    });
                }

                if (slot.remainingSeconds === 0) {
                    const targetIdx = cGameQueue.findIndex(s => s.id === slot.id);
                    if (targetIdx !== -1) {
                        const expiredTeam = cGameQueue.splice(targetIdx, 1)[0];
                        const validPlayers = getValidPlayers(expiredTeam.players);
                        const memberNames = validPlayers.map(p => p.split('/')[0].trim());

                        io.to(`club_${cId}`).emit('tvPopupAlert', {
                            clubId: cId, // 💡 [추가] 클럽 ID 명시
                            matchType: '게임',
                            names: memberNames,
                            message: '입장 시간 초과로 게임 대기방이 삭제되었습니다.<br>게임 대기를 원하시면 다시 등록해 주세요.'
                        });

                        const cancelPersonalMsg = '코트 입장 제한 시간(초과)으로 인해 게임 대기방이 취소되었습니다. 다시 대기 등록을 해주세요.';
                        validPlayers.forEach(playerStr => {
                            const parts = playerStr.split('/');
                            const userIdentifier = (parts[1] || parts[0]).trim();
                            sendPersonalNotification(userIdentifier, cancelPersonalMsg);
                        });

                        if (typeof addNotification === 'function') {
                            addNotification(`🗑️ [게임 대기방 삭제] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열에서 삭제되었습니다.`, cId);
                        }
                    }
                }
            } else {
                slot.fullAt = null;
                slot.remainingSeconds = null;
                slot.announced = false;
            }
        });

        // 2. 난타 코트 및 난타 대기열 처리
        let emptyNantaSlotsCount = 0;
        cCourtsData.forEach(court => {
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
        cNantaQueue.forEach(slot => {
            const validCount = getValidPlayers(slot.players).length;
            
            if (validCount === 2 && activeNantaTimerCount < emptyNantaSlotsCount) {
                activeNantaTimerCount++;
                
                if (!slot.fullAt) {
                    slot.fullAt = now;
                }

                const elapsed = Math.floor((now - slot.fullAt) / 1000);
                slot.remainingSeconds = Math.max(0, clubConfig.ENTRY_TIMEOUT_SEC - elapsed);

                if (elapsed === 30 && !slot.announced) {
                    slot.announced = true;
                    const validPlayers = getValidPlayers(slot.players);
                    const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                    
                    let availableSides = [];
                    for (let court of cCourtsData) {
                        if (court.type === 'nanta') {
                            if (court.sideA && court.sideA.isEmpty) {
                                availableSides.push({ courtId: court.id, side: 'sideA' });
                            }
                            if (court.sideB && court.sideB.isEmpty) {
                                availableSides.push({ courtId: court.id, side: 'sideB' });
                            }
                        }
                    }
                    
                    const targetSlotInfo = availableSides[activeNantaTimerCount - 1] || availableSides[0];
                    const targetCourtNum = targetSlotInfo ? targetSlotInfo.courtId : '';

                    pushVoiceAnnouncement(cId,  {
                        clubId: cId,
                        courtNumber: targetCourtNum,
                        names: memberNames,
                        matchType: '난타'
                    });

                    io.to(`club_${cId}`).emit('entryPopupAlert', {
                        clubId: cId, // 💡 [추가] 클럽 ID 명시
                        matchType: '난타',
                        courtNumber: targetCourtNum,
                        targetPlayers: memberNames
                    });
                }

                if (slot.remainingSeconds === 0) {
                    const index = cNantaQueue.findIndex(s => s.id === slot.id);
                    if (index !== -1) {
                        const expiredTeam = cNantaQueue.splice(index, 1)[0];
                        const validPlayers = getValidPlayers(expiredTeam.players);
                        const memberNames = validPlayers.map(p => p.split('/')[0].trim());

                        io.to(`club_${cId}`).emit('tvPopupAlert', {
                            clubId: cId, // 💡 [추가] 클럽 ID 명시
                            matchType: '난타',
                            names: memberNames,
                            message: '입장 시간 초과로 난타 대기방이 삭제되었습니다.<br>난타 대기를 원하시면 다시 등록해 주세요.'
                        });

                        const cancelPersonalMsg = '코트 입장 제한 시간(초과)으로 인해 난타 대기방이 취소되었습니다. 다시 대기 등록을 해주세요.';
                        validPlayers.forEach(playerStr => {
                            const parts = playerStr.split('/');
                            const userIdentifier = (parts[1] || parts[0]).trim();
                            sendPersonalNotification(userIdentifier, cancelPersonalMsg);
                        });

                        if (typeof addNotification === 'function') {
                            addNotification(`🗑️ [난타 대기방 삭제] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열에서 삭제되었습니다.`, cId);
                        }
                    }
                }
            } else {
                slot.fullAt = null;
                slot.remainingSeconds = null;
                slot.announced = false;
            }
        });

        // 3. 진행 중인 난타 코트 잔여시간 처리
        cCourtsData.forEach(court => {
            if (court.type === 'nanta') {
                ['sideA', 'sideB'].forEach(side => {
                    if (court[side] && !court[side].isEmpty && court[side].startTime) {
                        const elapsed = Math.floor((now - court[side].startTime) / 1000);
                        court[side].remainingSeconds = Math.max(0, clubConfig.NANTA_COURT_LIMIT_SEC - elapsed);
                        
                        if (court[side].remainingSeconds === 60 && !court[side].warned1Min) {
                            court[side].warned1Min = true;
                            const sideName = (side === 'sideA') ? 'A면' : 'B면';
                            
                            // 💡 수정 후: 구장별 독립 큐로 전송
                            pushVoiceAnnouncement(cId, {
                                clubId: cId,
                                courtNumber: court.id,
                                names: [], 
                                matchType: '난타1분전',
                                message: `${court.id}번 코트 ${sideName} 난타 이용 시간이 잠시 후 종료됩니다. 다음 대기자를 위해 정리를 준비해 주시기 바랍니다.`
                            });

                            if (typeof addNotification === 'function') {
                                addNotification(`⏰ [난타 임박] ${court.id}번 코트 (${sideName}) 이용 시간 1분 전`, cId);
                            }
                        }

                        if (court[side].remainingSeconds === 0) {
                            const exitedPlayers = court[side].players;
                            court[side] = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0, warned1Min: false };
                            
                            if (typeof addNotification === 'function') {
                                addNotification(`🔔 [난타종료] ${court.id}번 코트 (${side === 'sideA' ? 'A' : 'B'}면)${exitedPlayers} 난타 시간이 종료되었습니다.`, cId);
                            }
                        }

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
                });
            }
        });

        // 4. 해당 클럽에만 최신 상태 실시간 전송
        if (typeof broadcastState === 'function') {
            broadcastState(cId);
        }
    });
}, 1000);

// ==========================================
// 🔔 [개인 알림 발송 헬퍼 함수]
// ==========================================
function sendPersonalNotification(targetIdentifier, message) {
    if (!targetIdentifier || !io) return;
    
    // 특수문자/공백 제거하여 채널 ID 생성 (예: '010-1234-5678' -> '01012345678')
    const cleanId = String(targetIdentifier).replace(/[^0-9a-zA-Z가-힣_]/g, '');
    
    const notiItem = {
        id: 'noti_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        message: message,
        time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }),
        timestamp: Date.now()
    };

    // 해당 사용자 전용 소켓 룸으로만 다이렉트 전송
    io.to(`user_${cleanId}`).emit('personalNotification', notiItem);
    console.log(`🔔 [개인 알림 전송] -> [user_${cleanId}]: ${message}`);
}

// ==========================================
// 6. Socket.IO 이벤트 핸들링 (기존 모든 소켓 기능 + 로그인 핸들러 완벽 통합)
// ==========================================
io.on('connection', (socket) => {

    // 📶 접속자의 구장 Wi-Fi 여부 판별 후 개별 전달
    const isGym = isGymWifiUser(socket);
    socket.emit('wifiStatus', { isGymWifi: isGym, clientIp: getClientIp(socket) });

    console.log('새 소켓 연결:', socket.id);

    // 🏢 [멀티 테넌트] 접속한 클라이언트의 클럽 룸 배정
    // 클라이언트가 쿼리스트링(?club=xxx)이나 핸드셰이크로 보낸 clubId 확인 (기본값: 'unjeong')
    // 수정 후
    const clientClubId = (socket.handshake.query && (socket.handshake.query.club || socket.handshake.query.clubId)) || 'unjeong';
    socket.clubId = clientClubId;
    socket.join(`club_${clientClubId}`);
    console.log(`🏸 [클럽 입장] 소켓(${socket.id})이 club_${clientClubId} 룸에 참여했습니다.`);
    
    // ✅ [추가] 룸 입장 직후 해당 클럽 접속자 수 즉시 계산 및 화면 전송
    broadcastOnlineCount(clientClubId);

    // 🔔 로그인 사용자 소켓 등록 처리
    socket.on('registerUser', (userData) => {
        if (userData && userData.phone) {
            const cleanPhone = String(userData.phone).replace(/[^0-9a-zA-Z가-힣_]/g, '');
            socket.join(`user_${cleanPhone}`);
            socket.userIdentifier = cleanPhone; // 소켓에 로그인 식별자 저장
            socket.userId = userData.id || cleanPhone;
            
            console.log(`👤 [소켓 룸 조인] Socket ID(${socket.id})가 user_${cleanPhone} 방에 입장했습니다.`);

            // ✅ 로그인 성공 시점에 해당 클럽 접속자 카운트 즉시 갱신!
            broadcastOnlineCount(socket.clubId);
        }
    });

   // 💡 사용자가 세션을 등록할 때 (자동 복귀 검증 및 신규 로그인 승인)
    socket.on('registerUserSession', (data) => {
        if (!data) return;

        // 1. 객체 형태({ username, isAutoRestore })와 기존 문자열 형태 모두 안전하게 처리
        let rawUsername = '';
        let isAutoRestore = false;

        if (typeof data === 'object' && data !== null) {
            rawUsername = data.username || data.user || data.id || '';
            isAutoRestore = Boolean(data.isAutoRestore);
        } else {
            rawUsername = String(data);
        }

        const cleanUsername = String(rawUsername).split('/')[0].trim();
        if (!cleanUsername) return;

        // 🚨 [세션 만료 검증 분기]
        if (typeof expiredUsers !== 'undefined' && expiredUsers[cleanUsername]) {
            if (isAutoRestore) {
                // 🛑 자동 복귀 시도: 이미 만료되었으므로 브라우저 열리자마자 즉시 쫓아냄
                delete expiredUsers[cleanUsername];
                if (typeof disconnectUserClubs !== 'undefined') delete disconnectUserClubs[cleanUsername];
                if (typeof disconnectRawUsers !== 'undefined') delete disconnectRawUsers[cleanUsername];
                console.log(`[접속 차단] 유저(${cleanUsername})는 세션이 완전 만료되어 브라우저 오픈 즉시 강제 로그아웃 신호를 전송합니다.`);
                
                socket.emit('forceLogout', { message: '장시간 미접속으로 세션이 만료되었습니다. 다시 로그인해 주세요.' });
                return; // ⛔ 소켓 등록을 중단하고 즉시 종료
            } else {
                // 🟢 직접 신규 로그인 시도: 이전 만료 기록을 지워주고 정상 통과
                delete expiredUsers[cleanUsername];
                console.log(`[신규 로그인] 유저(${cleanUsername})가 직접 로그인하여 이전 만료 상태를 초기화하고 정상 접속합니다.`);
            }
        }

        // 중복 로그인 감지 (다른 창/기기 연결 끊기)
        if (activeUserSockets.has(cleanUsername)) {
            const oldSocketId = activeUserSockets.get(cleanUsername);
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('forceLogout', {
                    username: cleanUsername,
                    reason: 'duplicate_login',
                    message: '다른 기기 또는 브라우저에서 로그인하여 현재 세션이 종료되었습니다.'
                });
            }
        }

        // 🔄 [수정] 1. 구장 식별자 먼저 추출 (구장별 독립 세션 키 생성)
        const incomingClubId = socket.clubId || 'unjeong';
        const clubUserKey = `${incomingClubId}_${cleanUsername}`;

        // 🚪 [수정] 동일 구장 내 중복 로그인만 감지 (다른 구장은 서로 튕겨내지 않음)
        if (activeUserSockets.has(clubUserKey)) {
            const oldSocketId = activeUserSockets.get(clubUserKey);
            if (oldSocketId !== socket.id) {
                io.to(oldSocketId).emit('forceLogout', {
                    username: cleanUsername,
                    clubId: incomingClubId,
                    reason: 'duplicate_login',
                    message: '동일 구장에 다른 기기 또는 브라우저에서 로그인하여 이전 창이 종료되었습니다.'
                });
            }
        }

        // 🔄 [수정] 유예 타이머 해제 및 클럽 변경 감지 (이전 구장 대기방 정리)
        const previousClubId = (typeof disconnectUserClubs !== 'undefined') ? disconnectUserClubs[cleanUsername] : null;

        // ⏱️ 정상 유예 시간 내 복귀한 경우: 대기 타이머 해제
        if (disconnectTimers[cleanUsername]) {
            clearTimeout(disconnectTimers[cleanUsername]);
            delete disconnectTimers[cleanUsername];

            // 다른 클럽으로 들어온 경우 -> 이전 클럽 대기방 즉시 폭파!
            if (previousClubId && previousClubId !== incomingClubId) {
                const prevUser = (typeof disconnectRawUsers !== 'undefined' && disconnectRawUsers[cleanUsername])
                    ? disconnectRawUsers[cleanUsername]
                    : cleanUsername;

                if (typeof cleanupUser === 'function') {
                    cleanupUser(prevUser);
                }
                console.log(`[클럽 변경 감지] 유저(${cleanUsername})가 '${previousClubId}' ➔ '${incomingClubId}'(으)로 이동: 이전 대기방 즉시 삭제 완료`);
            } else {
                console.log(`[복귀 확인] 유저(${cleanUsername}) 동일 구장(${incomingClubId}) 재접속: 대기열 순번 유지`);
            }

            if (typeof disconnectUserClubs !== 'undefined') delete disconnectUserClubs[cleanUsername];
            if (typeof disconnectRawUsers !== 'undefined') delete disconnectRawUsers[cleanUsername];
        }

        // ⏱️ 세션 타이머도 함께 해제 (정상 사용 중 만료되는 현상 방지)
        if (typeof sessionTimers !== 'undefined' && sessionTimers[cleanUsername]) {
            clearTimeout(sessionTimers[cleanUsername]);
            delete sessionTimers[cleanUsername];
        }

        // 💾 [수정] 구장별 세션 키로 소켓 등록
        activeUserSockets.set(clubUserKey, socket.id);
        socket.username = cleanUsername;
        socket.clubUserKey = clubUserKey;

        if (typeof broadcastOnlineCount === 'function') {
            broadcastOnlineCount(incomingClubId);
        }
    });

    // ==========================================
    // 📺 TV 전광판 등록 (하이픈/언더바 룸 동시 지원 및 완벽 격리)
    // ==========================================
    socket.on('registerTV', (data) => {
        const clubId = (data && data.clubId) ? data.clubId : (socket.clubId || 'unjeong');
        
        // 1. 기존 방 정리 (Socket.io Set 및 Array 완벽 호환)
        if (socket.rooms) {
            const currentRooms = Array.from(socket.rooms);
            currentRooms.forEach(room => {
                if (room.startsWith('tv-room') || room.startsWith('club_')) {
                    socket.leave(room);
                }
            });
        }

        socket.clubId = clubId;
        socket.isTV = true;
        
        // 💡 2. 하이픈(-)과 언더바(_) 방을 둘 다 참가시켜 발송 방식 불일치 완벽 방어!
        socket.join(`tv-room-${clubId}`);
        socket.join(`tv-room_${clubId}`);
        socket.join(`club_${clubId}`);

        console.log(`📺 TV 전광판 등록 완료: [클럽: ${clubId}] -> 룸: tv-room-${clubId}, club_${clubId}`);

        if (typeof broadcastState === 'function') {
            broadcastState(clubId);
        }
    });

    // ==========================================
    // 🚪 [추가] 범용 룸 조인 리스너 (tv.html의 joinRoom 신호 수신)
    // ==========================================
   // ==========================================
    // 🚪 [보강] 범용 룸 조인 리스너 (방 이름 자동 매칭 및 이중 격리 보장)
    // ==========================================
    socket.on('joinRoom', (roomName) => {
        if (!roomName) return;

        // 1. 전달받은 원본 방 이름으로 조인 (예: 'gimpo' 또는 'club_gimpo')
        socket.join(roomName);

        // 2. 만약 'club_' 접두사가 없는 순수 ID라면 'club_' 접두사 룸에도 동시 참가
        const cleanId = roomName.replace(/^club_/, '');
        const clubRoomName = `club_${cleanId}`;
        socket.join(clubRoomName);

        console.log(`🚪 [소켓 룸 조인] 소켓(${socket.id}) -> 방 등록: [${roomName}, ${clubRoomName}]`);
    });
    
    // 🔑 [추가 완료] 정회원 로그인 처리 소켓 이벤트
    // 🔑 [수정] 정회원 로그인 처리 소켓 이벤트 (클럽별 회원 분리)
    socket.on('loginMember', ({ name, phone }, callback) => {
        const trimmedName = name ? name.trim() : '';
        const cleanInputPhone = phone ? phone.replace(/[^0-9]/g, '') : '';
        const currentClubId = socket.clubId || 'unjeong'; // 🏢 접속한 클럽 확인

        if (!trimmedName || !cleanInputPhone) {
            return callback({ success: false, message: '이름과 전화번호를 모두 입력해 주세요.' });
        }

        // 🏢 해당 클럽 소속 회원만 조회 (기존 데이터 누락 시 기본 unjeong 매핑)
        const query = `
            SELECT * FROM regular_members 
            WHERE TRIM(name) = ? 
              AND REPLACE(REPLACE(phone, '-', ''), ' ', '') = ?
              AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))
        `;

        db.get(query, [trimmedName, cleanInputPhone, currentClubId, currentClubId], (err, row) => {
            if (err) {
                console.error('❌ 로그인 DB 조회 에러:', err.message);
                return callback({ success: false, message: '서버 에러가 발생했습니다.' });
            }

            if (!row) {
                return callback({ success: false, message: '해당 클럽에 등록된 정회원 정보를 찾을 수 없습니다.' });
            }

            const genderStr = row.gender ? row.gender : '미입력';
            const ageGroupStr = row.ageGroup ? row.ageGroup : '일반';
            const gradeStr = row.grade ? row.grade : '초심';

            const user = {
                id: row.id,
                clubId: row.club_id || currentClubId,
                username: row.username,
                name: row.name,
                rawName: row.name,
                displayName: `${row.name} / ${genderStr} / ${ageGroupStr} / ${gradeStr}`,
                gender: row.gender,
                ageGroup: row.ageGroup,
                grade: row.grade,
                isGuest: false,
                phone: row.phone
            };

            callback({ success: true, user });
        });
    });

    // 🔑 [추가 완료] 일일회원 로그인 처리 소켓 이벤트
    // 🔑 [수정 완료] 일일회원 로그인 처리 소켓 이벤트 (클럽 식별자 부여)
    socket.on('loginGuest', ({ name, phone, payCode }, callback) => {
        if (!payCode || payCode.length !== 6) {
            return callback({ success: false, message: '유효한 결제인증번호 6자리를 입력하세요.' });
        }

        const currentClubId = socket.clubId || 'unjeong'; // 🏢 접속한 클럽 식별
        const guestId = `guest_${Date.now()}`;
        const user = {
            id: guestId,
            clubId: currentClubId, // 🏢 [추가] 일일회원 객체에도 현재 클럽 ID 부여
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

    // 🎛️ [관리자] Wi-Fi 제한 ON/OFF 토글 및 구장 IP 등록 이벤트 (클럽별 독립 분리)
    socket.on('updateWifiSettings', ({ clubId: reqClubId, useWifiRestriction, allowedGymIps }) => {
        try {
            const clubId = reqClubId || socket.clubId || 'unjeong';
            const club = (typeof getClub === 'function') ? getClub(clubId) : (clubs && clubs[clubId]);

            if (!club) return;
            if (!club.config) club.config = {};

            if (typeof useWifiRestriction === 'boolean') {
                club.config.useWifiRestriction = useWifiRestriction;
            }
            if (Array.isArray(allowedGymIps)) {
                club.config.allowedGymIps = allowedGymIps;
            }

            // 💾 1. clubs-data.json에 영구 저장
            if (typeof saveClubsData === 'function') {
                saveClubsData();
            }

            console.log(`📡 [${clubId}] Wi-Fi 제한: ${club.config.useWifiRestriction ? 'ON' : 'OFF'}, 등록 IP:`, club.config.allowedGymIps);

            // 📡 2. 해당 클럽 화면/관리자에 설정 동기화
            if (typeof broadcastState === 'function') {
                broadcastState(clubId);
            }

            // 📡 3. 해당 클럽 방(club_${clubId})에 접속 중인 사용자들에게만 Wi-Fi 인증 상태 재검증 전송
            const roomSockets = io.sockets.adapter.rooms.get(`club_${clubId}`);
            if (roomSockets) {
                roomSockets.forEach((sId) => {
                    const s = io.sockets.sockets.get(sId);
                    if (s) {
                        const isGym = (typeof isGymWifiUser === 'function') ? isGymWifiUser(s, clubId) : true;
                        s.emit('wifiStatus', { isGymWifi: isGym, clientIp: (typeof getClientIp === 'function' ? getClientIp(s) : '') });
                    }
                });
            }
        } catch (err) {
            console.error('Wi-Fi 설정 변경 에러:', err);
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
                const clubId = newConfig.clubId || socket.clubId || 'unjeong';

                if (!clubs[clubId]) clubs[clubId] = {};
                if (!clubs[clubId].config) {
                    clubs[clubId].config = JSON.parse(JSON.stringify(typeof config !== 'undefined' ? config : {}));
                }
                const targetConfig = clubs[clubId].config;

                // 💡 전달된 필드만 안전하게 개별 갱신 (전달되지 않은 값은 기존 값 유지)
                if (newConfig.ENTRY_TIMEOUT_SEC !== undefined) targetConfig.ENTRY_TIMEOUT_SEC = newConfig.ENTRY_TIMEOUT_SEC;
                if (newConfig.NANTA_COURT_LIMIT_SEC !== undefined) targetConfig.NANTA_COURT_LIMIT_SEC = newConfig.NANTA_COURT_LIMIT_SEC;
                if (newConfig.ADMIN_PASSWORD !== undefined && newConfig.ADMIN_PASSWORD.trim() !== '') {
                    targetConfig.ADMIN_PASSWORD = newConfig.ADMIN_PASSWORD;
                }

                // ⏱️ 유예 시간 관리자 설정 갱신 (대기방 보존 분, 세션 만료 분)
                if (newConfig.queueGraceMinutes !== undefined) {
                    targetConfig.queueGraceMinutes = Number(newConfig.queueGraceMinutes) || 30;
                }
                if (newConfig.sessionExpireMinutes !== undefined) {
                    targetConfig.sessionExpireMinutes = Number(newConfig.sessionExpireMinutes) || 60;
                }

                if (newConfig.cleaningSchedules !== undefined) {
                    targetConfig.cleaningSchedules = newConfig.cleaningSchedules;
                }
                if (newConfig.cleaningStartMsg !== undefined) {
                    targetConfig.cleaningStartMsg = newConfig.cleaningStartMsg;
                }
                if (newConfig.cleaningEndMsg !== undefined) {
                    targetConfig.cleaningEndMsg = newConfig.cleaningEndMsg;
                }

                if (newConfig.soundEntryNotice !== undefined) {
                    targetConfig.soundEntryNotice = newConfig.soundEntryNotice;
                }
                if (newConfig.soundNantaWarning !== undefined) {
                    targetConfig.soundNantaWarning = newConfig.soundNantaWarning;
                }
                if (newConfig.soundScheduleNotice !== undefined) {
                    targetConfig.soundScheduleNotice = newConfig.soundScheduleNotice;
                }

                // 1~4번 개별 청소 메시지 설정 안전 갱신
                for (let i = 1; i <= 4; i++) {
                    if (newConfig[`cleaningStartMsg_${i}`] !== undefined) {
                        targetConfig[`cleaningStartMsg_${i}`] = newConfig[`cleaningStartMsg_${i}`];
                    }
                    if (newConfig[`cleaningEndMsg_${i}`] !== undefined) {
                        targetConfig[`cleaningEndMsg_${i}`] = newConfig[`cleaningEndMsg_${i}`];
                    }
                }

                console.log(`📌 [클럽별 설정 안전 병합 완료] 클럽: ${clubId} (대기유예: ${targetConfig.queueGraceMinutes}분, 세션만료: ${targetConfig.sessionExpireMinutes}분)`);
            }

            const targetClubId = newConfig.clubId || socket.clubId || 'unjeong';
            
            // 1. 해당 클럽에 변경된 설정 실시간 전송
            if (typeof broadcastState === 'function') {
                broadcastState(targetClubId);
            }

            // 2. 💾 구장 환경설정 파일에 영구 저장 (1회 실행)
            if (typeof saveClubsData === 'function') {
                saveClubsData();
            }
        } catch (err) {
            console.error('환경 설정 변경 에러:', err);
        }
    });

    socket.on('updatePassword', (newPassword) => {
        try {
            if (newPassword) {
                config.ADMIN_PASSWORD = newPassword; 
            }
            broadcastState(socket.clubId); // 👈 소켓이 속한 클럽 아이디를 넣어줍니다.
        } catch (err) {
            console.error('비밀번호 변경 에러:', err);
        }
    });

    socket.on('updateCourtsConfig', (payload) => {
    try {
        // 💡 데이터가 객체({ clubId, courts })인지 단순 배열([])인지 모두 호환 처리
        let courtsList = [];
        let targetClubId = socket.clubId || 'unjeong';

        if (Array.isArray(payload)) {
            courtsList = payload;
        } else if (payload && typeof payload === 'object') {
            if (payload.clubId) targetClubId = payload.clubId;
            if (Array.isArray(payload.courts)) courtsList = payload.courts;
        }

        if (!Array.isArray(courtsList)) return;

        const club = getClub(targetClubId);

        // 해당 클럽의 courtsData 갱신
        club.courtsData = courtsList.map((court, idx) => {
            const id = idx + 1;
            const targetType = court ? (court.type || 'game') : 'game';
            const targetNote = court ? (court.note || '') : '';
            const existingCourt = Array.isArray(club.courtsData) ? club.courtsData.find(c => c.id === id) : null;

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

        // 💡 수정한 해당 클럽에만 변경 상태 브로드캐스트
        if (typeof broadcastState === 'function') {
            broadcastState(targetClubId);
        }

        console.log(`✅ [${targetClubId}] 코트 설정 변경 완료: 총 ${club.courtsData.length}개 코트 등록됨`);
        saveClubsData(); // 💾 코트 구성 영구 저장 실행
    } catch (err) {
        console.error('코트 설정 변경 에러:', err);
    }
});

    // 🔒 방 개설 시 현재 코트 플레이 여부 및 중복 체크
    socket.on('createSlot', ({ type, userId, user }) => {
        // 🏢 [멀티 테넌트] 현재 소켓이 접속한 클럽 데이터 가져오기
        const club = getClub(socket.clubId);

        if (!isGymWifiUser(socket)) {
            socket.emit('alertMessage', '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.');
            return;
        }
        const myName = user.split(' / ')[0].trim();

        // ✅ 해당 클럽 코트만 검사
        const isInGameCourt = club.courtsData.some(c => c.type === 'game' && !c.isEmpty && c.players && c.players.includes(myName));
        if (isInGameCourt) {
            socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 게임 코트에서 플레이 중이므로 새로운 방을 개설할 수 없습니다.`);
            return;
        }

        if (type === 'nanta') {
            const isInNantaCourt = club.courtsData.some(c => c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && c.sideA.players.includes(myName)) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && c.sideB.players.includes(myName))
            ));
            if (isInNantaCourt) {
                socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 난타 코트에서 플레이 중이므로 새로운 난타 방을 개설할 수 없습니다.`);
                return;
            }
        }

        // ✅ 해당 클럽의 대기열만 검사
        const existingGameSlot = club.gameQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const existingNantaSlot = club.nantaQueue.find(slot => slot.userIds && slot.userIds.includes(userId));

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
        // 🏢 [멀티 테넌트] 현재 소켓이 접속한 클럽 데이터 가져오기
        const club = getClub(socket.clubId);

        if (!isGymWifiUser(socket)) {
            socket.emit('alertMessage', '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.');
            return;
        }
        const myName = user.split(' / ')[0].trim();
        
        // ✅ 해당 클럽 코트만 검사
        const isInGameCourt = club.courtsData.some(c => c.type === 'game' && !c.isEmpty && c.players && c.players.includes(myName));
        if (isInGameCourt) {
            socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 게임 코트에서 플레이 중이므로 방을 개설할 수 없습니다.`);
            return;
        }

        if (type === 'nanta') {
            const isInNantaCourt = club.courtsData.some(c => c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && c.sideA.players.includes(myName)) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && c.sideB.players.includes(myName))
            ));
            if (isInNantaCourt) {
                socket.emit('alertMessage', `⚠️ ${myName} 님은 현재 난타 코트에서 플레이 중이므로 난타 방을 개설할 수 없습니다.`);
                return;
            }
        }

        // ✅ 해당 클럽의 대기열만 검사
        const existingGameSlot = club.gameQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const existingNantaSlot = club.nantaQueue.find(slot => slot.userIds && slot.userIds.includes(userId));
        const sameSlot = type === 'game' ? existingGameSlot : existingNantaSlot;
        
        if (sameSlot) {
            socket.emit('alertMessage', `이미 ${type === 'game' ? '게임' : '난타'} 대기 방에 참여 중이거나 개설한 상태입니다.`);
            return;
        }

        // 💡 실제 슬롯 생성 함수 호출 시에도 클럽 정보를 넘겨주어야 함
        if (typeof createNewSlotDirectly === 'function') {
            createNewSlotDirectly(type, userId, user, socket.clubId);
        }
    });

    // 🏸 대기 슬롯 참가 처리 (클럽별 멀티 테넌트 반영)
    socket.on('joinPlayer', ({ type, slotId, index, name }) => {
        if (!isGymWifiUser(socket)) {
            socket.emit('alertMessage', '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 대기 방에 입장할 수 있습니다.');
            return;
        }

        const currentClubId = socket.clubId || 'unjeong';
        const club = clubs[currentClubId] || clubs['unjeong'];
        const cleanName = name ? name.split('/')[0].trim() : '';

        // 1. 해당 클럽의 코트에서 이미 플레이 중인지 검사
        const currentCourts = club.courtsData || [];
        const isInGameCourt = currentCourts.some(c => c.type === 'game' && !c.isEmpty && c.players && c.players.includes(cleanName));
        if (isInGameCourt) {
            socket.emit('alertMessage', `⚠️ ${cleanName} 님은 현재 게임 코트에서 플레이 중이므로 대기 방에 입장할 수 없습니다.`);
            return;
        }

        if (type === 'nanta') {
            const isInNantaCourt = currentCourts.some(c => c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && c.sideA.players.includes(cleanName)) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && c.sideB.players.includes(cleanName))
            ));
            if (isInNantaCourt) {
                socket.emit('alertMessage', `⚠️ ${cleanName} 님은 현재 난타 코트에서 플레이 중이므로 난타 방에 입장할 수 없습니다.`);
                return;
            }
        }

        // 2. 해당 클럽의 대기열에서 슬롯 탐색
        const queue = type === 'game' ? club.gameQueue : club.nantaQueue;
        const slot = queue ? queue.find(s => s.id === slotId) : null;
        
        if (slot && index >= 0 && index < slot.players.length) {
            slot.players[index] = name;
            if (typeof addNotification === 'function') {
                addNotification(`👤 [참가] ${name} 님이 대기 방에 입장하셨습니다.`, currentClubId);
            }
            // 3. 해당 클럽 방에만 최신 상태 실시간 브로드캐스트
            if (typeof broadcastState === 'function') {
                broadcastState(currentClubId);
            }
        }
    });

   function createNewSlotDirectly(type, userId, user, clubId = 'unjeong') {
        const myName = user.split(' / ')[0].trim();
        
        // 🏢 [멀티 테넌트] 대상 클럽 데이터 가져오기
        const club = getClub(clubId);

        const newSlot = {
            id: 'slot_' + (slotIdCounter++),
            type: type,
            players: type === 'game' ? [user, '', '', ''] : [user, '', ''],
            userIds: [userId], 
            createdAt: Date.now(),
            fullAt: null,
            remainingSeconds: null
        };

        // ✅ 해당 클럽의 대기열에만 방 추가
        if (type === 'game') {
            club.gameQueue.push(newSlot);
        } else {
            club.nantaQueue.push(newSlot);
        }

        // 해당 클럽 전용 공지 알림 추가 (addNotification 함수가 clubId를 지원하도록 연결)
        if (typeof addNotification === 'function') {
            addNotification(`📢 [방 개설] 새로운 ${type === 'game' ? '게임' : '난타'} 방이 개설되었습니다 (${myName}).`, clubId);
        }

        // ✅ 해당 클럽 사용자들에게만 화면 갱신 브로드캐스트
        broadcastState(clubId);
    }

    socket.on('exitPlayer', ({ type, slotId, index }) => {
        // 🏢 [멀티 테넌트] 현재 소켓이 속한 클럽의 데이터 가져오기
        const club = getClub(socket.clubId);
        const queue = type === 'game' ? club.gameQueue : club.nantaQueue;
        const slotIdx = queue.findIndex(s => s.id === slotId);

        if (slotIdx !== -1) {
            const slot = queue[slotIdx];
            slot.players[index] = '';
            
            // 해당 자리의 userId도 함께 정리 (대기열 중복 방지 해제)
            if (slot.userIds && slot.userIds[index]) {
                slot.userIds[index] = null;
            }
            
            if (getValidPlayers(slot.players).length === 0) {
                queue.splice(slotIdx, 1);
            }
            // ✅ 해당 클럽에만 상태 갱신 전송
            broadcastState(socket.clubId);
        }
    });

    // 🏟️ [코트 입장 처리] (멀티 테넌트 반영)
    socket.on('enterCourtFromSlot', ({ type, slotId }) => {
        try {
            const currentClubId = socket.clubId || 'unjeong';
            const club = clubs[currentClubId] || clubs['unjeong'];
            const clubCourts = club.courtsData || [];

            if (type === 'game') {
                const queue = club.gameQueue || [];
                const slotIdx = queue.findIndex(s => s.id === slotId);
                if (slotIdx === -1) return;
                const slot = queue[slotIdx];
                const validPlayers = getValidPlayers(slot.players);

                if (validPlayers.length < 4) return;

                const emptyCourt = clubCourts.find(c => c.type === 'game' && c.isEmpty);
                if (!emptyCourt) return;

                emptyCourt.isEmpty = false;
                emptyCourt.players = validPlayers.join(', ');
                emptyCourt.startTime = Date.now();
                emptyCourt.remainingSeconds = 0;

                queue.splice(slotIdx, 1);

                // 다른 큐 및 난타 코트에서 중복 플레이어 정리
                validPlayers.forEach(p => {
                    const cleanPName = p.split('/')[0].trim();

                    if (club.nantaQueue) {
                        club.nantaQueue.forEach(nSlot => {
                            nSlot.players.forEach((np, idx) => {
                                if (np && np.includes(cleanPName)) {
                                    nSlot.players[idx] = '';
                                }
                            });
                        });
                        club.nantaQueue = club.nantaQueue.filter(nSlot => getValidPlayers(nSlot.players).length > 0);
                    }

                    clubCourts.forEach(court => {
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

                if (typeof addNotification === 'function') {
                    addNotification(`🏟️ [코트 입장] 게임 코트 (${emptyCourt.id}번)에 팀이 입장했습니다.`, currentClubId);
                }
                if (typeof broadcastState === 'function') {
                    broadcastState(currentClubId);
                }

            } else if (type === 'nanta') {
                const queue = club.nantaQueue || [];
                const slotIdx = queue.findIndex(s => s.id === slotId);
                if (slotIdx === -1) return;
                const slot = queue[slotIdx];
                const validPlayers = getValidPlayers(slot.players);

                if (validPlayers.length < 2) return;

                let targetCourt = null;
                let targetSide = null;

                for (let court of clubCourts) {
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

                targetCourt[targetSide] = {
                    isEmpty: false,
                    players: validPlayers.join(', '),
                    startTime: Date.now(),
                    remainingSeconds: config.NANTA_COURT_LIMIT_SEC || 900
                };

                queue.splice(slotIdx, 1);

                if (typeof addNotification === 'function') {
                    addNotification(`🏟️ [코트 입장] 난타 코트 (${targetCourt.id}번 - ${targetSide === 'sideA' ? 'A반' : 'B반'})에 팀이 입장했습니다.`, currentClubId);
                }
                if (typeof broadcastState === 'function') {
                    broadcastState(currentClubId);
                }
            }
        } catch (err) {
            console.error('코트 입장 처리 에러:', err);
        }
    });

    // 🔔 [난타 코트 종료] (멀티 테넌트 반영)
    socket.on('endNantaCourt', ({ courtId, side }) => {
        const currentClubId = socket.clubId || 'unjeong';
        const club = clubs[currentClubId] || clubs['unjeong'];
        const clubCourts = club.courtsData || [];

        const targetCourt = clubCourts.find(c => c.id === Number(courtId));
        if (!targetCourt || targetCourt.type !== 'nanta') return;

        let isCleared = false;
        const cleanSide = side ? String(side).replace('side', '').toUpperCase() : '';

        if (cleanSide === 'A' && targetCourt.sideA && !targetCourt.sideA.isEmpty) {
            targetCourt.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            isCleared = true;
        } else if (cleanSide === 'B' && targetCourt.sideB && !targetCourt.sideB.isEmpty) {
            targetCourt.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
            isCleared = true;
        }

        if (isCleared) {
            if (typeof addNotification === 'function') {
                addNotification(`🔔 [난타종료] ${targetCourt.id}번 코트 (${cleanSide}면)가 수동 종료되었습니다.`, currentClubId);
            }
            if (typeof broadcastState === 'function') {
                broadcastState(currentClubId);
            }
        }
    });

    // 🏁 [게임 코트 종료] (멀티 테넌트 반영)
    socket.on('endGameCourt', ({ courtId }) => {
        try {
            const currentClubId = socket.clubId || 'unjeong';
            const club = clubs[currentClubId] || clubs['unjeong'];
            const clubCourts = club.courtsData || [];

            const court = clubCourts.find(c => c.id === courtId && c.type === 'game');
            if (court) {
                court.isEmpty = true;
                court.players = '';
                court.startTime = null;
                court.remainingSeconds = 0;

                if (typeof addNotification === 'function') {
                    addNotification(`🏁 [게임 종료] ${court.id}번 코트 게임이 종료되었습니다.`, currentClubId);
                }
                if (typeof broadcastState === 'function') {
                    broadcastState(currentClubId);
                }
            }
        } catch (err) {
            console.error('게임 종료 처리 에러:', err);
        }
    });

    // 🔄 [한게임 더 연장] (멀티 테넌트 반영)
    socket.on('extendGameCourt', ({ courtId }) => {
        try {
            const currentClubId = socket.clubId || 'unjeong';
            const club = clubs[currentClubId] || clubs['unjeong'];
            const clubCourts = club.courtsData || [];

            const court = clubCourts.find(c => c.id === courtId && c.type === 'game');
            if (!court || court.isEmpty || !court.players) return;

            const playersArr = court.players.split(',').map(p => p.trim()).filter(Boolean);
            if (playersArr.length === 0) return;

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

            if (!club.gameQueue) club.gameQueue = [];
            club.gameQueue.push(newSlot);

            court.isEmpty = true;
            court.players = '';
            court.startTime = null;
            court.remainingSeconds = 0;

            if (typeof addNotification === 'function') {
                addNotification(`🔄 [한게임 더] ${court.id}번 코트 팀이 대기열 최후순위로 재등록되었습니다.`, currentClubId);
            }
            if (typeof broadcastState === 'function') {
                broadcastState(currentClubId);
            }
        } catch (err) {
            console.error('한게임 더 처리 에러:', err);
        }
    });

    socket.on('adminForceExit', ({ targetType, targetId, index }) => {
        try {
            // 💡 현재 소켓이 속한 클럽 아이디 가져오기
            const clubId = socket.clubId || 'unjeong';
            const club = getClub(clubId);

            if (targetType === 'gameQueue' || targetType === 'nantaQueue') {
                const queue = targetType === 'gameQueue' ? club.gameQueue : club.nantaQueue;
                const slot = queue.find(s => s.id === targetId);
                if (slot && slot.players[index] !== undefined) {
                    const kickedName = slot.players[index];
                    slot.players[index] = '';
                    
                    if (getValidPlayers(slot.players).length === 0) {
                        const qIndex = queue.findIndex(s => s.id === targetId);
                        if (qIndex !== -1) queue.splice(qIndex, 1);
                    }
                    
                    // 클럽별 알림 추가 함수가 있다면 활용, 또는 기존 방식 유지
                    if (typeof addNotificationForClub === 'function') {
                        addNotificationForClub(clubId, `⚠️ [관리자 강제퇴장] ${kickedName} 님이 대기 방에서 강제 퇴장되었습니다.`);
                    } else if (typeof addNotification === 'function') {
                        addNotification(`⚠️ [관리자 강제퇴장] ${kickedName} 님이 대기 방에서 강제 퇴장되었습니다.`);
                    }

                    broadcastState(clubId); // 💡 클럽 아이디 전달
                }
            } 
            else if (targetType === 'court') {
                const court = club.courtsData.find(c => c.id === targetId);
                if (court) {
                    if (court.type === 'game') {
                        court.isEmpty = true;
                        court.players = '';
                        court.startTime = null;
                        court.remainingSeconds = 0;
                        if (typeof addNotification === 'function') {
                            addNotification(`⚠️ [관리자 강제퇴장] 게임 코트(${court.id}번)가 강제 종료 및 비워졌습니다.`);
                        }
                    } else if (court.type === 'nanta') {
                        if (index === 'A' && court.sideA) {
                            court.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                        } else if (index === 'B' && court.sideB) {
                            court.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                        }
                        if (typeof addNotification === 'function') {
                            addNotification(`⚠️ [관리자 강제퇴장] 난타 코트(${court.id}번 - ${index}면)가 강제 비워졌습니다.`);
                        }
                    }
                    broadcastState(clubId); // 💡 클럽 아이디 전달
                }
            }
        } catch (err) {
            console.error('관리자 강제 퇴장 처리 에러:', err);
        }
    });

    // 🤝 [방 통합 처리] (멀티 테넌트 반영)
    socket.on('mergeSlot', ({ mySlotId, targetSlotId }) => {
        const currentClubId = socket.clubId || 'unjeong';
        const club = clubs[currentClubId] || clubs['unjeong'];
        
        if (!club || !Array.isArray(club.gameQueue)) return;

        const mySlot = club.gameQueue.find(s => s.id === mySlotId);
        const targetSlot = club.gameQueue.find(s => s.id === targetSlotId);

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

                // 해당 클럽 큐에서 내 슬롯 제거
                club.gameQueue = club.gameQueue.filter(s => s.id !== mySlotId);

                if (typeof addNotification === 'function') {
                    addNotification(`🤝 [방 통합] 대기 팀이 하나로 통합되었습니다.`, currentClubId);
                }
                if (typeof broadcastState === 'function') {
                    broadcastState(currentClubId);
                }
            }
        }
    });

   // =================================================================
    // 🚪 1. 명시적 로그아웃 (버튼 클릭 / 클럽 변경 즉시 대기열 파기)
    // =================================================================
    socket.on('explicitLogout', () => {
        socket.isExplicitLogout = true;
        const currentSocketId = socket.id;
        const rawUser = userSockets[currentSocketId] || socket.username;

        let userKey = '';
        if (rawUser) {
            userKey = (typeof rawUser === 'object' && rawUser !== null)
                ? (rawUser.id || rawUser.username || rawUser.name || '')
                : String(rawUser);
        }

        if (userKey) {
            // 실행 중이던 유예 타이머 모두 제거
            if (disconnectTimers[userKey]) {
                clearTimeout(disconnectTimers[userKey]);
                delete disconnectTimers[userKey];
            }
            if (typeof sessionTimers !== 'undefined' && sessionTimers[userKey]) {
                clearTimeout(sessionTimers[userKey]);
                delete sessionTimers[userKey];
            }

            // 💥 유예 없이 즉시 대기열/대기방 정리 (진행 중인 코트는 건드리지 않음)
            cleanupUser(rawUser);
            delete expiredUsers[userKey];
            console.log(`[즉시 퇴장] 유저(${userKey}) 명시적 로그아웃으로 대기열 즉시 삭제 완료`);
        }
    });

    // =================================================================
    // ⏱️ 2. 통합된 disconnect (화면 꺼짐, 와이파이 단절 시 2단계 유예)
    // =================================================================
    socket.on('disconnect', () => {
        const currentSocketId = socket.id;
        const currentClubId = socket.clubId || 'unjeong';
        const rawUser = userSockets[currentSocketId] || socket.username;
        
        let userKey = '';
        if (rawUser) {
            userKey = (typeof rawUser === 'object' && rawUser !== null)
                ? (rawUser.id || rawUser.username || rawUser.name || '')
                : String(rawUser);
        }

        // 소켓 매핑 정보 정리
        delete userSockets[currentSocketId];
        if (userKey && activeUserSockets.get(userKey) === currentSocketId) {
            activeUserSockets.delete(userKey);
        }

        // 접속자 수 갱신
        if (typeof broadcastOnlineCount === 'function') {
            broadcastOnlineCount(currentClubId);
        }

        // 💡 이미 명시적 로그아웃(버튼/클럽변경)을 했다면 유예 타이머를 걸지 않고 즉시 종료
        if (socket.isExplicitLogout) {
            return;
        }

        // -------------------------------------------------------------
        // 💡 비명시적 단절 (와이파이 단절, 화면 꺼짐): 2단계 유예 타이머 가동
        // -------------------------------------------------------------
        if (userKey) {
            // 기존에 돌고 있던 타이머가 있다면 초기화
            if (disconnectTimers[userKey]) {
                clearTimeout(disconnectTimers[userKey]);
            }
            if (typeof sessionTimers !== 'undefined' && sessionTimers[userKey]) {
                clearTimeout(sessionTimers[userKey]);
            }

            // 💡 끊긴 시점의 구장과 유저 정보 저장 (클럽 변경 감지용)
            if (typeof disconnectUserClubs !== 'undefined') disconnectUserClubs[userKey] = currentClubId;
            if (typeof disconnectRawUsers !== 'undefined') disconnectRawUsers[userKey] = rawUser;

            // ⏱️ 해당 클럽의 설정값(분 단위) 불러오기 (설정이 없으면 기본 30분 / 60분 적용)
            const currentClub = (typeof getClub === 'function') ? getClub(currentClubId) : null;
            const graceMinutes = (currentClub && currentClub.config && currentClub.config.queueGraceMinutes) ? currentClub.config.queueGraceMinutes : 30;
            const expireMinutes = (currentClub && currentClub.config && currentClub.config.sessionExpireMinutes) ? currentClub.config.sessionExpireMinutes : 60;

            // [1단계: 설정된 유예 시간] 대기열 유지 시간 (폰 화면 꺼짐/몸풀기 배려)
            disconnectTimers[userKey] = setTimeout(() => {
                if (typeof cleanupUser === 'function') {
                    cleanupUser(rawUser);
                }
                delete disconnectTimers[userKey];
                if (typeof disconnectUserClubs !== 'undefined') delete disconnectUserClubs[userKey];
                if (typeof disconnectRawUsers !== 'undefined') delete disconnectRawUsers[userKey];
                console.log(`[대기열 정리] 유저(${userKey}) ${graceMinutes}분 미접속으로 대기방/슬롯에서 제외되었습니다.`);
            }, graceMinutes * 60 * 1000);

            // [2단계: 설정된 만료 시간] 운동 마치고 귀가한 것으로 간주하여 세션 만료
            if (typeof sessionTimers !== 'undefined') {
                sessionTimers[userKey] = setTimeout(() => {
                    expiredUsers[userKey] = true;
                    delete sessionTimers[userKey];
                    console.log(`[세션 완전 만료] 유저(${userKey}) ${expireMinutes}분 경과로 세션이 만료되었습니다.`);
                }, expireMinutes * 60 * 1000);
            }
        }
    });

    // ==========================================
    // 👑 [슈퍼 관리자] 멀티 클럽 생성 및 통합 관리
    // ==========================================
    const SUPER_ADMIN_KEY = 'super1234'; // 💡 슈퍼 관리자 마스터 비밀번호

    // 1. 슈퍼 관리자 로그인 및 클럽 목록 조회
    socket.on('superAdmin:getClubs', (password, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '마스터 비밀번호가 일치하지 않습니다.' });
        }

        const clubList = Object.keys(clubs).map(cId => {
            const c = clubs[cId];
            // 🏢 JSON에 저장된 clubName을 최우선 적용
            const displayName = c.clubName || c.name || cId;

            return {
                id: cId,
                name: displayName,
                clubName: displayName,
                courtCount: Array.isArray(c.courtsData) ? c.courtsData.length : 0,
                gameQueueCount: Array.isArray(c.gameQueue) ? c.gameQueue.length : 0,
                nantaQueueCount: Array.isArray(c.nantaQueue) ? c.nantaQueue.length : 0,
                useWifi: c.config ? Boolean(c.config.useWifiRestriction) : false
            };
        });

        callback({ success: true, clubs: clubList });
    });

    // 2. 새 클럽 자동 생성
    socket.on('superAdmin:createClub', ({ password, clubId, clubName, courtCount, adminPassword }, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '권한이 없습니다.' });
        }

        const cleanId = String(clubId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const cleanName = String(clubName || '').trim();
        const courtsNum = Math.max(2, Math.min(20, parseInt(courtCount, 10) || 6));
        const adminPass = String(adminPassword || '1234').trim();

        if (!cleanId) {
            return callback({ success: false, message: '클럽 영문 ID(영문 소문자, 숫자)를 올바르게 입력해 주세요.' });
        }
        if (!cleanName) {
            return callback({ success: false, message: '클럽 이름을 입력해 주세요.' });
        }
        if (clubs[cleanId]) {
            return callback({ success: false, message: '이미 존재하는 클럽 ID입니다.' });
        }

        // 코트 기본 데이터 생성 (마지막 2코트는 난타 및 레슨 전용)
        const generatedCourts = [];
        for (let i = 1; i <= courtsNum; i++) {
            if (i <= courtsNum - 2) {
                generatedCourts.push({ id: i, type: 'game', isEmpty: true, players: '', note: '' });
            } else if (i === courtsNum - 1) {
                generatedCourts.push({
                    id: i,
                    type: 'nanta',
                    sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                    sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                    note: ''
                });
            } else {
                generatedCourts.push({ id: i, type: 'lesson', isEmpty: false, players: '레슨 전용 코트', note: '' });
            }
        }

        // 새 클럽 데이터 모델 구조화
        clubs[cleanId] = {
            clubId: cleanId,
            clubName: cleanName,
            name: cleanName, // 기존 호환성 유지용
            config: {
                ENTRY_TIMEOUT_SEC: 180,
                NANTA_COURT_LIMIT_SEC: 900,
                ADMIN_PASSWORD: adminPass,
                DISCONNECT_GRACE_SEC: 1800,
                SESSION_TIMEOUT_SEC: 3600,
                useWifiRestriction: false,
                allowedGymIps: []
            },
            courtsData: generatedCourts,
            gameQueue: [],
            nantaQueue: [],
            notifications: []
        };

        // 💾 clubs-data.json에 즉시 영구 저장
        if (typeof saveClubsData === 'function') {
            saveClubsData();
        }

        console.log(`👑 [슈퍼 관리자] 새 클럽 등록 완료: ${cleanName} (${cleanId}), 코트: ${courtsNum}개`);
        callback({ success: true, message: `[${cleanName}] 클럽이 성공적으로 생성되었습니다!` });
    });

    // 3. 클럽 삭제
    socket.on('superAdmin:deleteClub', ({ password, clubId }, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '권한이 없습니다.' });
        }
        if (!clubs[clubId]) {
            return callback({ success: false, message: '존재하지 않는 클럽입니다.' });
        }

        const deletedName = clubs[clubId].name;
        delete clubs[clubId];

        if (typeof saveClubsData === 'function') {
            saveClubsData();
        }

        console.log(`👑 [슈퍼 관리자] 클럽 삭제 완료: ${deletedName} (${clubId})`);
        callback({ success: true, message: `[${deletedName}] 클럽이 삭제되었습니다.` });
    });
});

// 🏢 [멀티 테넌트] 실제 로그인한 회원만 클럽별로 집계하여 전송
function broadcastOnlineCount(targetClubId) {
    if (!io || !io.sockets || !io.sockets.adapter) return;

    const clubsToUpdate = targetClubId ? [targetClubId] : ['unjeong', 'daewon'];

    clubsToUpdate.forEach((clubId) => {
        const roomName = `club_${clubId}`;
        const room = io.sockets.adapter.rooms.get(roomName);

        let totalCount = 0; // 로그인 완료 회원 수
        let clubCount = 0;  // 체육관 Wi-Fi 접속 회원 수

        if (room) {
            room.forEach((socketId) => {
                const userSocket = io.sockets.sockets.get(socketId);
                // 🔑 [핵심] 소켓에 로그인 사용자 정보(userId 또는 userIdentifier)가 등록된 경우만 카운트!
                if (userSocket && (userSocket.userId || userSocket.userIdentifier)) {
                    totalCount++;
                    if (typeof isGymWifiUser === 'function' && isGymWifiUser(userSocket)) {
                        clubCount++;
                    }
                }
            });
        }

        // 해당 클럽 방에만 전송
        io.to(roomName).emit('updateOnlineCount', {
            club: clubCount,
            total: totalCount
        });
    });
}

// 1. 전체 회원 명부 CSV 다운로드 라우트 (프론트엔드 경로 /api/admin/download-excel와 일치시킴)
app.get('/api/admin/download-excel', (req, res) => {
    db.all("SELECT * FROM regular_members", [], (err, rows) => {
        if (err) {
            console.error('회원 조회 에러:', err);
            return res.status(500).send('데이터 조회 실패');
        }

        // CSV 파일 형식 생성 (UTF-8 BOM 추가하여 엑셀에서 한글 깨짐 방지)
        let csvContent = '\uFEFF이름,연락처,성별,연령대,급수,주소\n';
        rows.forEach(m => {
            csvContent += `"${m.name || ''}","${m.phone || ''}","${m.gender || ''}","${m.birthDate || ''}","${m.grade || ''}","${m.address || ''}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=member_list.csv');
        res.status(200).send(csvContent);
    });
});

// 2. 회원 명부 일괄 업로드(엑셀/CSV) 라우트 (구장별 격리 적용)
app.post('/api/admin/upload-excel', upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.json({ success: false, message: '파일이 업로드되지 않았습니다.' });
    }

    // 💡 요청 바디 또는 쿼리에서 클럽 식별자 추출 (기본값 unjeong)
    const clubId = req.body.clubId || req.query.clubId || req.body.club || req.query.club || 'unjeong';

    const filePath = req.file.path;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineCount = 0;
    let successCount = 0;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        // 💡 club_id 컬럼 추가 및 충돌(Conflict) 시 소속 구장도 함께 갱신
        const stmt = db.prepare(`
            INSERT INTO regular_members (id, type, username, password, name, gender, birthDate, grade, phone, address, joinedAt, club_id) 
            VALUES (?, 'regular', ?, '1234', ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?)
            ON CONFLICT(phone) DO UPDATE SET 
                name = excluded.name,
                gender = excluded.gender,
                birthDate = excluded.birthDate,
                grade = excluded.grade,
                address = excluded.address,
                club_id = excluded.club_id
        `);

        rl.on('line', (line) => {
            lineCount++;
            if (lineCount === 1) return; // 첫 줄(제목 행) 건너뜀

            const cols = line.split(',').map(val => val.replace(/^["']|["']$/g, '').trim());
            if (cols.length >= 2 && cols[0] && cols[1]) {
                const [name, phone, gender = '', birthDate = '', grade = '초심', address = ''] = cols;
                
                // 전화번호 숫자만 남긴 후, 앞의 0이 잘렸다면 복구
                let cleanPhone = phone.replace(/[^0-9]/g, '');
                if (cleanPhone.length === 10 && cleanPhone.startsWith('10')) {
                    cleanPhone = '0' + cleanPhone;
                }

                // 고유 ID와 로그인용 username 생성
                const uniqueId = 'reg_' + cleanPhone;
                const username = 'user_' + cleanPhone;

                // 💡 9번째 파라미터로 clubId 전달
                stmt.run(uniqueId, username, name, gender, birthDate, grade, cleanPhone, address, clubId, (err) => {
                    if (!err) {
                        successCount++;
                    } else {
                        console.error('회원 일괄 등록 중 개별 행 에러:', err);
                    }
                });
            }
        });

        rl.on('close', () => {
            stmt.finalize();
            db.run("COMMIT", (err) => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }

                if (err) {
                    return res.json({ success: false, message: 'DB 저장 중 오류가 발생했습니다.' });
                }
                console.log(`📁 [회원 명부 일괄 등록 완료 - ${clubId}] 총 ${successCount}명 반영`);
                res.json({ success: true, message: `총 ${successCount}명의 회원이 [${clubId}] 구장에 등록(갱신)되었습니다.` });
            });
        });
    });
});

// ==========================
// 7. 서버 실행
// ==========================
server.listen(PORT, () => {
    console.log(`🚀 배드민턴 클럽 서버가 포트 ${PORT} 에서 실행 중입니다.`);
});