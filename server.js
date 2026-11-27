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
const readline = require('readline');
const gymSessionManager = require('./gymSessionManager');
const { balanceTeams } = require('./utils/teamBalancer');

// ==========================================
// 💾 영구 디스크 및 데이터베이스/설정 파일 경로 설정 (Render 대응)
// ==========================================
// Render 환경이거나 /var/data 마운트 경로가 실제로 존재하면 영구 디스크 사용
const isRender = process.env.RENDER || fs.existsSync('/var/data');
const DATA_DIR = isRender && fs.existsSync('/var/data') ? '/var/data' : __dirname;

// 데이터 폴더 및 영구 업로드 폴더 생성 (안전장치)
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
} catch (err) {
    console.warn('⚠️ 디렉터리 생성 확인 (이미 존재하거나 권한 확인 필요):', err.message);
}

// 📦 업로드 파일도 영구 디스크 uploads 폴더에 저장되도록 설정
const upload = multer({ dest: UPLOAD_DIR });

// 📌 DB 파일 경로 정의 (기존 파일명에 맞게 badminton.db 사용)
const dbPath = path.join(DATA_DIR, 'badminton.db');

console.log(`📂 [스토리지 경로] DATA_DIR: ${DATA_DIR}`);
console.log(`📦 [DB 파일 경로] dbPath: ${dbPath}`);

// 🗄️ [복구] SQLite 데이터베이스 연결 및 기본 테이블 보장
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ [DB 연결 실패]:', err.message);
    } else {
        console.log('✅ [DB 연결 성공] badminton.db 연결 완료');
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS regular_members (
        id TEXT PRIMARY KEY,
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
        joinedAt TEXT,
        club_id TEXT DEFAULT 'unjeong'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pending_registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT,
        gender TEXT,
        birthDate TEXT,
        grade TEXT,
        address TEXT,
        status TEXT DEFAULT 'pending',
        createdAt TEXT,
        club_id TEXT DEFAULT 'unjeong'
    )`);

    // 🔍 [확인용] 기존 DB 테이블에 phone/username 단독 UNIQUE 제약이 남아 있는지 로그 출력
    db.all(`PRAGMA index_list('regular_members')`, [], (err, indexes) => {
        if (!err && indexes) {
            console.log('📋 [regular_members 인덱스 목록]:', indexes);
        }
    });

    // 🏷️ [회원 상태 관리] 기존 regular_members 테이블에 상태/메모/종료예정일/발생일자 컬럼 안전 추가
    [
        `ALTER TABLE regular_members ADD COLUMN member_status TEXT DEFAULT 'active'`,
        `ALTER TABLE regular_members ADD COLUMN status_memo TEXT DEFAULT ''`,
        `ALTER TABLE regular_members ADD COLUMN status_end_date TEXT DEFAULT ''`,
        `ALTER TABLE regular_members ADD COLUMN status_updated_at TEXT DEFAULT ''`
    ].forEach((alterSql) => {
        db.run(alterSql, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error('⚠️ 회원 상태 컬럼 추가 중 알림:', err.message);
            }
        });
    });

    // 🏷️ [회원 상태/복귀 신청] 병가·휴면·탈퇴·복귀·재입회 승인 대기 테이블
    db.run(`CREATE TABLE IF NOT EXISTS member_status_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT,
        club_id TEXT DEFAULT 'unjeong',
        name TEXT,
        phone TEXT,
        current_status TEXT,
        requested_status TEXT,
        end_date TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        request_status TEXT DEFAULT 'pending',
        created_at TEXT
    )`);

    // 💬 [고객지원/FAQ/오픈채팅] 독립 테이블 3종 생성
    db.run(`CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT ''
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS support_faqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT DEFAULT '기본 사용법',
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_id TEXT DEFAULT 'unjeong',
        club_name TEXT DEFAULT '',
        member_name TEXT DEFAULT '',
        member_phone TEXT DEFAULT '',
        is_guest INTEGER DEFAULT 0,
        category TEXT DEFAULT 'question',
        content TEXT NOT NULL,
        device_info TEXT DEFAULT '',
        wifi_info TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        reply TEXT DEFAULT '',
        replied_by TEXT DEFAULT '',
        created_at TEXT,
        replied_at TEXT DEFAULT ''
    )`);

    // 초기 기본 FAQ 5개 최초 1회만 자동 등록 (이후 마스터가 삭제해도 재부활 방지)
    db.get(`SELECT value FROM platform_settings WHERE key = 'faqs_seeded'`, [], (seedErr, seedRow) => {
        if (!seedErr && !seedRow) {
            const defaultFaqs = [
                ['Wi-Fi 연결', '게임 방 개설·참여 버튼이 비활성화(흐리게) 되어 있어요.', '구장 전용 Wi-Fi에 연결해야 게임·난타 방 개설 및 참여가 가능합니다. 스마트폰 설정에서 구장 Wi-Fi를 연결한 뒤 2~3초 기다리면 자동으로 활성화됩니다.'],
                ['대기열 이용', '게임이나 난타 대기방을 만들고 취소하려면 어떻게 하나요?', '게임신청(방 개설) 또는 난타신청(방 개설) 버튼으로 방을 만들고, 취소할 때는 본인 이름이 들어간 방의 [퇴장]버튼을 누르면 즉시 취소됩니다.'],
                ['일일회원', '외부 방문객이나 휴면 회원이 오늘 하루만 운동하려면 어떻게 하나요?', '로그인 화면 상단의 [일일회원] 탭을 선택한 뒤 이름, 전화번호, 결제승인번호 6자리를 입력하면 바로 입장할 수 있습니다.'],
                ['회원 상태', '부상·출장 등으로 잠시 쉬어야 할 때 병가·휴면 신청은 어디서 하나요?', '정회원 로그인 후 메인 화면 맨 아래 [병가·휴면·탈퇴 신청]을 눌러 신청하면 운영진 승인 후 반영됩니다. 복귀 시 기존 정보로 정회원 로그인을 시도하면 바로 복귀 신청을 할 수 있습니다.'],
                ['화면 오류', '화면이 멈추거나 최신 현황이 안 보일 때는 어떻게 하나요?', '브라우저 화면을 아래로 당겨 새로고침하거나 앱을 완전히 닫았다가 다시 열어주세요. 문제가 계속되면 [문의·오류 제보] 탭이나 카카오톡 오픈채팅으로 알려주세요.']
            ];
            const nowStr = new Date().toISOString().slice(0, 10);
            defaultFaqs.forEach(([cat, q, a]) => {
                db.run(`INSERT INTO support_faqs (category, question, answer, created_at) VALUES (?, ?, ?, ?)`, [cat, q, a, nowStr]);
            });
            db.run(`INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('faqs_seeded', '1')`);
        }
    });
    // 기존 DB에 이미 등록된 기본 FAQ 문구 자동 보정 ('하단' 삭제, '나가기' -> '퇴장')
    db.run(
        `UPDATE support_faqs
         SET answer = '게임신청(방 개설) 또는 난타신청(방 개설) 버튼으로 방을 만들고, 취소할 때는 본인 이름이 들어간 방의 [퇴장] 버튼을 누르면 즉시 취소됩니다.'
         WHERE answer LIKE '%하단 [게임 방 개설]%[나가기]%'`
    );
});

// =========================================================================
// ⚖️ [복식 팀 자동 밸런싱] 코트 입장 시 회원 정보 + 전적 기반 팀 편성 헬퍼
// =========================================================================
const enteringCourtLocks = new Set();

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function extractCleanPlayerName(rawPlayer) {
    return String(rawPlayer || '')
        .replace(/\|?guest/gi, '') // 👈 이 한 줄만 추가
        .split('/')[0]
        .replace(/\(일일\)|\[일일\]|\(게스트\)/g, '')
        .trim();
}

async function buildBalancedTeamsForCourt(clubId, validPlayers) {
    if (!Array.isArray(validPlayers) || validPlayers.length !== 4) return null;

    const cleanNames = validPlayers.map(extractCleanPlayerName);
    const placeholders = cleanNames.map(() => '?').join(', ');

    // 1) 정회원 정보 조회
    const regularRows = await dbAllAsync(
        `SELECT name, gender, birthDate, ageGroup, grade
         FROM regular_members
         WHERE (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
           AND name IN (${placeholders})`,
        [clubId, clubId, ...cleanNames]
    );
    const regularMap = new Map();
    regularRows.forEach(r => {
        if (r.name && !regularMap.has(r.name.trim())) {
            regularMap.set(r.name.trim(), r);
        }
    });

    // 2) 일일회원 정보 조회 (정회원에 없는 이름 대비)
    const guestRows = await dbAllAsync(
        `SELECT name, gender, age_group, grade
         FROM guest_members
         WHERE club_id = ?
           AND name IN (${placeholders})
         ORDER BY last_visit DESC`,
        [clubId, ...cleanNames]
    );
    const guestMap = new Map();
    guestRows.forEach(g => {
        if (g.name && !guestMap.has(g.name.trim())) {
            guestMap.set(g.name.trim(), g);
        }
    });

    // 3) 해당 클럽의 경기 기록에서 4명의 승/패/득실차 집계
    const statsMap = new Map();
    cleanNames.forEach(name => {
        statsMap.set(name, { wins: 0, losses: 0, pointDiff: 0 });
    });

    const matchRows = await dbAllAsync(
        `SELECT team_a_p1, team_a_p2, team_b_p1, team_b_p2, score_a, score_b
         FROM match_records
         WHERE club_id = ?`,
        [clubId]
    );

    matchRows.forEach(m => {
        const scoreA = Number(m.score_a) || 0;
        const scoreB = Number(m.score_b) || 0;
        if (scoreA === 0 && scoreB === 0) return;

        const teamAPlayers = [m.team_a_p1, m.team_a_p2].map(extractCleanPlayerName).filter(Boolean);
        const teamBPlayers = [m.team_b_p1, m.team_b_p2].map(extractCleanPlayerName).filter(Boolean);

        statsMap.forEach((st, playerName) => {
            if (teamAPlayers.includes(playerName)) {
                st.pointDiff += (scoreA - scoreB);
                if (scoreA > scoreB) st.wins += 1;
                else if (scoreB > scoreA) st.losses += 1;
            } else if (teamBPlayers.includes(playerName)) {
                st.pointDiff += (scoreB - scoreA);
                if (scoreB > scoreA) st.wins += 1;
                else if (scoreA > scoreB) st.losses += 1;
            }
        });
    });

    // 4) teamBalancer.js 입력 형식으로 조립
    const playerInputs = validPlayers.map((raw, idx) => {
        const cleanName = cleanNames[idx];
        const reg = regularMap.get(cleanName);
        const guest = !reg ? guestMap.get(cleanName) : null;
        const st = statsMap.get(cleanName) || { wins: 0, losses: 0, pointDiff: 0 };

        // 표시 문자열에 '이름/C조' 형태로 급수가 붙어있을 경우 보조 추출
        const slashParts = String(raw || '').split('/');
        const fallbackGrade = slashParts.length > 1 ? slashParts[1].trim() : null;

        if (reg) {
            return {
                displayName: raw,
                name: cleanName,
                grade: reg.grade || fallbackGrade,
                gender: reg.gender,
                ageGroup: reg.ageGroup,
                birthDate: reg.birthDate,
                wins: st.wins,
                losses: st.losses,
                pointDiff: st.pointDiff,
                isGuest: false
            };
        }

        return {
            displayName: raw,
            name: cleanName,
            grade: (guest && guest.grade && guest.grade !== '일반' && guest.grade !== '일일') ? guest.grade : fallbackGrade,
            gender: guest ? guest.gender : null,
            ageGroup: guest ? guest.age_group : null,
            birthDate: null,
            wins: 0,
            losses: 0,
            pointDiff: 0,
            isGuest: true
        };
    });

    // 5) 최적 팀 분배 실행
    const balanced = balanceTeams(playerInputs);

    return {
        teamA: balanced.teamA.map(p => p.displayName),
        teamB: balanced.teamB.map(p => p.displayName),
        teamANames: balanced.teamA.map(p => p.name),
        teamBNames: balanced.teamB.map(p => p.name),
        teamAScore: balanced.teamAScore,
        teamBScore: balanced.teamBScore,
        scoreDiff: balanced.scoreDiff,
        isMixedDoubles: balanced.isMixedDoubles,
        matchType: balanced.matchType || (balanced.isMixedDoubles ? '혼복' : '자유')
    };
}

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
    'unjeong': []
};

const clubVoicePlayingState = {
    'unjeong': false
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
        io.to(`tv-room-${clubId}`).to(`tv-room_${clubId}`).emit('requestVoiceAnnouncement', nextAnnouncement);
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
    }
};

// 💾 Render 영구 디스크(/var/data) 우선 사용, 로컬 환경은 기본 폴더 사용
const DISK_PATH = '/var/data';
const CLUBS_DATA_FILE = fs.existsSync(DISK_PATH)
    ? path.join(DISK_PATH, 'clubs-data.json')
    : path.join(__dirname, 'clubs-data.json');

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

            const savedCfg = savedData[cId].config || {};
            clubs[cId].config = {
                ...(clubs[cId].config || {}),
                ...savedCfg,
                // ⏱️ 1. 입장 대기 제한시간 (초 단위)
                ENTRY_TIMEOUT_SEC: savedCfg.ENTRY_TIMEOUT_SEC !== undefined ? Number(savedCfg.ENTRY_TIMEOUT_SEC) : 180,
                // ⏱️ 2. 난타 코트 이용시간 (초 단위)
                NANTA_COURT_LIMIT_SEC: savedCfg.NANTA_COURT_LIMIT_SEC !== undefined ? Number(savedCfg.NANTA_COURT_LIMIT_SEC) : 300,
                // ⏱️ 3. 대기방 보존 유예시간 (분 단위)
                queueGraceMinutes: savedCfg.queueGraceMinutes !== undefined ? Number(savedCfg.queueGraceMinutes) : 30,
                // ⏱️ 4. 세션 자동 만료시간 (분 단위)
                sessionExpireMinutes: savedCfg.sessionExpireMinutes !== undefined ? Number(savedCfg.sessionExpireMinutes) : 60,
                // ⏱️ 4-1. 연속 게임 제한 시간 (분 단위, 기본값 5분)
                continuousGameLimitMinutes: savedCfg.continuousGameLimitMinutes !== undefined ? Number(savedCfg.continuousGameLimitMinutes) : 5,
                // 🔒 5. 관리자 접속 비밀번호
                ADMIN_PASSWORD: savedCfg.ADMIN_PASSWORD || (clubs[cId].config?.ADMIN_PASSWORD || '1234'),

                // 🎯 토글 스위치(boolean) 값과 IP 목록 영구 보존
                useWifiRestriction: typeof savedCfg.useWifiRestriction === 'boolean' 
                    ? savedCfg.useWifiRestriction 
                    : (clubs[cId].config?.useWifiRestriction ?? false),
                allowedGymIps: Array.isArray(savedCfg.allowedGymIps) 
                    ? savedCfg.allowedGymIps 
                    : (clubs[cId].config?.allowedGymIps || [])
            };

            // 🏟️ 코트 구성 복원 (courtsData 및 courts 동시 동기화)
            if (Array.isArray(savedData[cId].courtsData) && savedData[cId].courtsData.length > 0) {
                const restoredCourts = savedData[cId].courtsData.map((c, idx) => {
                    const id = c.id || (idx + 1);
                    const name = c.name || `${id}코트`;
                    const type = c.type || 'game';
                    const note = c.note || '';

                    if (type === 'nanta') {
                        return {
                            id, name, type: 'nanta', nextType: 'nanta', note,
                            sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                            sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 }
                        };
                    } else if (type === 'lesson') {
                        return {
                            id, name, type: 'lesson', nextType: 'lesson', isEmpty: false,
                            players: note || '레슨 코트', note
                        };
                    } else {
                        return {
                            id, name, type: 'game', nextType: 'game', isEmpty: true,
                            players: '', note
                        };
                    }
                });

                // 💡 [핵심] 두 변수 및 코트 수 동시 동기화
                clubs[cId].courtsData = restoredCourts;
                clubs[cId].courts = restoredCourts;
                clubs[cId].courtCount = savedData[cId].courtCount || restoredCourts.length;
            }
        });

        console.log('✅ [clubs-data.json] 클럽별 영구 설정(코트/설정/와이파이) 로드 완료!');
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
            if (!club) return;

            // 💡 courts 또는 courtsData 중 존재하는 코트 배열 참조
            const rawCourts = club.courtsData || club.courts || [];

            dataToSave[cId] = {
                clubId: club.clubId || cId,
                clubName: club.clubName || (cId === 'unjeong' ? '운정배드민턴클럽' : (cId === 'daewon' ? '대원배드민턴클럽' : `${cId.toUpperCase()} 배드민턴클럽`)),
                courtCount: club.courtCount || rawCourts.length || 8, // 코트 수 보존
                config: club.config,
                courtsData: rawCourts.map(c => ({
                    id: c.id,
                    name: c.name || `${c.id}코트`,
                    type: c.type || 'game',
                    note: c.note || '',
                    isActive: c.isActive !== false
                }))
            };
        });

        fs.writeFileSync(CLUBS_DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
        
        // 💡 [진단 로그] 실제 저장된 절대 경로와 구장별 설정 요약 출력
        const absolutePath = path.resolve(CLUBS_DATA_FILE);
        console.log(`💾 [저장 완료] 파일 절대경로: ${absolutePath}`);

        // 운정클럽 핵심 설정 1줄 요약
        const uClub = dataToSave['unjeong'] || {};
        const uCfg = uClub.config || {};
        console.log(`📝 [unjeong 요약] 코트수:${uClub.courtCount}개 | 입장:${uCfg.ENTRY_TIMEOUT_SEC ?? '-'}초 | 난타:${uCfg.NANTA_COURT_LIMIT_SEC ?? '-'}초 | 음성:[입장:${uCfg.soundEntryNotice !== false ? 'ON' : 'OFF'}, 난타:${uCfg.soundNantaWarning !== false ? 'ON' : 'OFF'}, 청소:${uCfg.soundScheduleNotice !== false ? 'ON' : 'OFF'}]`);

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
    // 💡 1. 기본 클럽 설정 로드 (관리자 모드 설정 반영)
    const targetClubId = clubId || (socket && socket.clubId) || 'unjeong';
    const club = (typeof getClub === 'function')
        ? getClub(targetClubId)
        : ((typeof clubs !== 'undefined' && clubs[targetClubId]) ? clubs[targetClubId] : null);
    const targetConfig = (club && club.config) ? club.config : (typeof config !== 'undefined' ? config : {});

    // 관리자 모드에서 Wi-Fi 제한 스위치가 꺼져 있거나(false), 등록된 IP가 없으면 무조건 통과
    if (targetConfig.useWifiRestriction === false) {
        return true;
    }
    if (!targetConfig.allowedGymIps || targetConfig.allowedGymIps.length === 0) {
        return true; 
    }

    // 💡 2. 최신 실제 IP 추출 및 정규화 (5G↔Wi-Fi 전환 시 verifiedClientIp 우선 반영, 토글 변경 시에도 실제 IP로 재검증)
    let rawIp = (socket && socket.verifiedClientIp)
        ? String(socket.verifiedClientIp)
        : (typeof getClientIp === 'function'
            ? getClientIp(socket)
            : (socket && socket.handshake && (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address)) || '');
    if (rawIp.includes(',')) {
        rawIp = rawIp.split(',')[0].trim();
    }
    const cleanClientIp = rawIp.replace(/^.*:/, '').trim();

    // 💡 3. 등록된 허용 IP 목록 대조
    const isAllowed = targetConfig.allowedGymIps.some(ip => {
        const cleanAllowedIp = String(ip).replace(/^.*:/, '').trim();
        return cleanAllowedIp && (cleanAllowedIp === cleanClientIp || rawIp.includes(cleanAllowedIp));
    });

    // 💡 4. 상태 변화 시 서버 로그 출력
    if (!isAllowed) {
        if (socket && socket.lastWifiLog !== 'mismatch') {
            console.log(`🚫 [Wi-Fi 불일치] 클라이언트 IP: "${cleanClientIp}" (외부망 접속)`);
            if (socket) socket.lastWifiLog = 'mismatch';
        }
    } else {
        if (socket && socket.lastWifiLog !== 'match') {
            console.log(`✅ [Wi-Fi 일치] 클라이언트 IP: "${cleanClientIp}" (구장망 접속)`);
            if (socket) socket.lastWifiLog = 'match';
        }
    }

    return isAllowed;
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

// 실제 달력에 존재하는 유효한 날짜(윤년·월별 일수·미래 날짜 차단)인지 검증하는 헬퍼
function isValidCalendarDate(yyyy, mm, dd) {
    const now = new Date();
    const currentYear = now.getFullYear();
    if (yyyy < 1920 || yyyy > currentYear || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
        return false;
    }
    const testDate = new Date(yyyy, mm - 1, dd);
    if (
        testDate.getFullYear() !== yyyy ||
        testDate.getMonth() + 1 !== mm ||
        testDate.getDate() !== dd
    ) {
        return false; // 예: 1990-02-30, 1990-04-31, 평년 02-29 차단
    }
    if (testDate > now) {
        return false; // 오늘 이후의 미래 날짜 차단
    }
    return true;
}

// 생년월일(8자리 19780116, 6자리 780116, 4자리 1978, 하이픈 포함 등)을 표준 'YYYY-MM-DD'로 정규화
function normalizeBirthDate(rawBirthDate) {
    const digits = String(rawBirthDate || '').replace(/[^0-9]/g, '');
    const currentYear = new Date().getFullYear();
    const currentTwoDigit = currentYear % 100;

    if (digits.length === 8) {
        const yyyy = parseInt(digits.slice(0, 4), 10);
        const mm = parseInt(digits.slice(4, 6), 10);
        const dd = parseInt(digits.slice(6, 8), 10);
        if (isValidCalendarDate(yyyy, mm, dd)) {
            return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        }
    } else if (digits.length === 6) {
        const yy = parseInt(digits.slice(0, 2), 10);
        const mm = parseInt(digits.slice(2, 4), 10);
        const dd = parseInt(digits.slice(4, 6), 10);
        const yyyy = yy <= currentTwoDigit ? (2000 + yy) : (1900 + yy);
        if (isValidCalendarDate(yyyy, mm, dd)) {
            return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        }
    } else if (digits.length === 4) {
        const yyyy = parseInt(digits, 10);
        if (yyyy >= 1920 && yyyy <= currentYear) {
            return `${yyyy}-01-01`;
        }
    }
    return '';
}

// 생년월일을 받아 '40대', '50대' 등의 정상 연령대 문자열로 변환하는 함수
function calculateAgeGroup(birthDateStr) {
    const normalized = normalizeBirthDate(birthDateStr);
    if (!normalized) return '기타';

    const birthYear = parseInt(normalized.slice(0, 4), 10);
    const currentYear = new Date().getFullYear();
    if (isNaN(birthYear) || birthYear < 1920 || birthYear > currentYear) {
        return '기타';
    }

    const age = currentYear - birthYear;
    const decade = Math.floor(age / 10) * 10;
    return decade >= 10 ? `${decade}대` : '10대 미만';
}

// 🔧 서버 시작 시 기존 DB에 잘못 계산된 연령대(-778090대, 0대, 기타, NaN 등) 자동 복구
setTimeout(() => {
    if (typeof db === 'undefined') return;
    db.all(
        `SELECT id, birthDate, ageGroup FROM regular_members 
         WHERE ageGroup LIKE '-%' 
            OR ageGroup LIKE '%NaN%' 
            OR ageGroup IN ('0대', '기타', '') 
            OR ageGroup IS NULL`,
        [],
        (err, rows) => {
            if (err || !Array.isArray(rows) || rows.length === 0) return;
            rows.forEach((row) => {
                const fixedBirth = normalizeBirthDate(row.birthDate);
                const fixedAgeGroup = calculateAgeGroup(fixedBirth || row.birthDate);
                if (fixedAgeGroup && fixedAgeGroup !== '기타') {
                    db.run(
                        `UPDATE regular_members SET birthDate = COALESCE(NULLIF(?, ''), birthDate), ageGroup = ? WHERE id = ?`,
                        [fixedBirth, fixedAgeGroup, row.id]
                    );
                }
            });
        }
    );
}, 2000);

// ==========================================
// 정회원 가입 및 관리자 승인 관련 API
// ==========================================

// 1. 정회원 가입 신청 접수 API (구장별 격리, 입력값 정규화 및 유효성 검증 적용)
app.post(['/api/register', '/api/register-request'], async (req, res) => {
    try {
        const { name: rawName, phone: rawPhone, gender, birthDate: rawBirthDate, grade, address: rawAddress, clubId: reqClubId, club } = req.body;

        const clubId = String(reqClubId || club || 'unjeong').trim();

        // 💡 이름: 괄호·숫자·특수문자 제거 후 순수 한글/영문만 허용
        const name = String(rawName || '')
            .replace(/\([^)]*\)/g, '')
            .replace(/[^가-힣a-zA-Z\s]/g, '')
            .trim();

        const address = String(rawAddress || '').trim();
        const birthDate = normalizeBirthDate(rawBirthDate);

        // 💡 전화번호 정규화: 숫자만 추출 및 표준 하이픈 포맷 생성
        const phoneDigits = String(rawPhone || '').replace(/[^0-9]/g, '');
        let formattedPhone = String(rawPhone || '').trim();
        if (phoneDigits.length === 11) {
            formattedPhone = `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 7)}-${phoneDigits.slice(7, 11)}`;
        } else if (phoneDigits.length === 10) {
            formattedPhone = `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6, 10)}`;
        }

        if (!name) {
            return res.status(400).json({ success: false, message: '이름은 한글 또는 영문으로 정확히 입력해 주세요.' });
        }
        if (!birthDate) {
            return res.status(400).json({ success: false, message: '생년월일은 8자리 숫자(예: 19780116)로 정확히 입력해 주세요.' });
        }
        if (phoneDigits.length < 10 || phoneDigits.length > 11) {
            return res.status(400).json({ success: false, message: '연락처는 숫자 10~11자리로 정확히 입력해 주세요.' });
        }
        if (!gender || !grade) {
            return res.status(400).json({ success: false, message: '성별과 급수를 모두 선택해 주세요.' });
        }

        // 💡 1단계: 해당 구장(club_id)에 이미 정회원으로 등록되어 있는지 확인
        const checkMemberSql = `
            SELECT * FROM regular_members 
            WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ? OR phone = ?)
              AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
        `;

        db.get(checkMemberSql, [phoneDigits, formattedPhone, phoneDigits, clubId, clubId], (err, existingMember) => {
            if (err) {
                console.error('정회원 중복 확인 DB 오류:', err.message);
                return res.status(500).json({ success: false, message: '회원 확인 중 서버 오류가 발생했습니다.' });
            }

            if (existingMember) {
                return res.status(400).json({ success: false, message: '이미 해당 클럽에 정회원으로 등록되어 있는 연락처입니다.' });
            }

            // 💡 2단계: 해당 구장(club_id) 대기 목록에 이미 신청되어 있는지 확인
            const checkPendingSql = `
                SELECT * FROM pending_registrations 
                WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ? OR phone = ?)
                  AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
            `;

            db.get(checkPendingSql, [phoneDigits, formattedPhone, phoneDigits, clubId, clubId], (err2, existingPending) => {
                if (err2) {
                    console.error('대기 목록 중복 확인 DB 오류:', err2.message);
                    return res.status(500).json({ success: false, message: '신청 내역 확인 중 서버 오류가 발생했습니다.' });
                }

                if (existingPending) {
                    return res.status(400).json({ success: false, message: '이미 해당 클럽에 가입 대기 중인 연락처입니다. 관리자 승인을 기다려주세요.' });
                }

                // 💡 3단계: 표준 포맷 데이터와 club_id를 포함하여 대기 테이블에 INSERT
                const createdAt = new Date().toISOString();
                const insertSql = `
                    INSERT INTO pending_registrations (name, phone, gender, birthDate, grade, address, status, createdAt, club_id) 
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                `;
                
                db.run(insertSql, [name, formattedPhone, gender, birthDate, grade, address, createdAt, clubId], function(insertErr) {
                    if (insertErr) {
                        console.error('가입 신청 DB 저장 오류:', insertErr.message);
                        return res.status(500).json({ success: false, message: '데이터베이스 저장 중 오류가 발생했습니다.' });
                    }
                    console.log(`📝 [신규 가입 신청 접수 - ${clubId}] ${name} (${formattedPhone}, ${birthDate})`);
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

// 3. 관리자용: 가입 신청 승인 처리 API (구장별 격리 및 타 클럽 중복가입 완벽 지원)
app.post('/api/admin/approve-member', async (req, res) => {
    try {
        const { phone: rawPhone, action, clubId: reqClubId, club } = req.body;
        const targetClubId = String(reqClubId || club || 'unjeong').trim();

        if (!rawPhone || !action) {
            return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
        }

        const phoneDigits = String(rawPhone).replace(/[^0-9]/g, '');
        const formattedPhone = phoneDigits.length === 11
            ? `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 7)}-${phoneDigits.slice(7, 11)}`
            : String(rawPhone).trim();

        // 💡 해당 구장(club_id)의 대기 내역만 정확히 조회 (타 클럽 신청 내역과 섞이지 않도록 격리)
        const findPendingSql = `
            SELECT * FROM pending_registrations 
            WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ? OR phone = ?)
              AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
        `;

        if (action === 'approve') {
            db.get(findPendingSql, [phoneDigits, formattedPhone, phoneDigits, targetClubId, targetClubId], (err, user) => {
                if (err || !user) {
                    return res.status(404).json({ success: false, message: '신청 내역을 찾을 수 없습니다.' });
                }

                // 💡 승인 시 적용할 클럽 식별자 결정
                const clubId = String(reqClubId || user.club_id || 'unjeong').trim();
                const cleanName = String(user.name || '').trim(); // 게임방/타이머 오류 방지를 위해 이름 공백 완벽 제거

                // 생년월일로부터 연령대 자동 계산
                const ageGroup = typeof calculateAgeGroup === 'function' ? calculateAgeGroup(user.birthDate) : '';
                // 💡 타 클럽 동시 가입 시에도 고유 ID가 겹치지 않도록 구성
                const memberId = `reg_${clubId}_${Date.now()}`;
                const joinedAt = new Date().toISOString().split('T')[0];
                
                // 💡 club_id 컬럼 포함 (총 13개 컬럼)
                const insertQuery = `
                    INSERT INTO regular_members (id, type, username, password, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt, club_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                const params = [
                    memberId,                 // 1. id
                    'regular',                // 2. type
                    formattedPhone,           // 3. username
                    '1234',                   // 4. password
                    cleanName,                // 5. name (공백 제거된 깨끗한 이름)
                    user.gender,              // 6. gender
                    user.birthDate,           // 7. birthDate
                    ageGroup,                 // 8. ageGroup
                    user.grade,               // 9. grade
                    formattedPhone,           // 10. phone
                    String(user.address || '').trim(), // 11. address
                    joinedAt,                 // 12. joinedAt
                    clubId                    // 13. club_id
                ];

                db.run(insertQuery, params, (insertErr) => {
                    if (insertErr) {
                        console.error('정회원 테이블 등록 오류:', insertErr.message);
                        if (insertErr.message.includes('UNIQUE constraint failed')) {
                            const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
                            const todayKst = `${nowKr.getFullYear()}-${String(nowKr.getMonth() + 1).padStart(2, '0')}-${String(nowKr.getDate()).padStart(2, '0')}`;
                            const reactivateSql = `
                                UPDATE regular_members
                                SET member_status = 'active', status_memo = '', status_end_date = '', status_updated_at = ?,
                                    name = ?, gender = ?, birthDate = ?, ageGroup = ?, grade = ?, address = ?
                                WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ?)
                                  AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
                                  AND COALESCE(NULLIF(member_status, ''), 'active') != 'active'
                            `;
                            return db.run(
                                reactivateSql,
                                [todayKst, cleanName, user.gender, user.birthDate, ageGroup, user.grade, String(user.address || '').trim(), phoneDigits, formattedPhone, clubId, clubId],
                                function(reErr) {
                                    if (!reErr && this.changes > 0) {
                                        return db.run(
                                            `DELETE FROM pending_registrations WHERE id = ? OR ((REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ?) AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = ''))))`,
                                            [user.id, phoneDigits, rawPhone, clubId, clubId],
                                            () => res.json({ success: true, message: '기존 휴면/탈퇴 회원의 정회원 재입회가 승인되었습니다.' })
                                        );
                                    }
                                    return res.status(400).json({ success: false, message: '이미 해당 클럽에 동일한 연락처로 등록된 활동 정회원이 존재합니다.' });
                                }
                            );
                        }
                        return res.status(500).json({ success: false, message: '정회원 등록 중 오류가 발생했습니다.' });
                    }

                    // 💡 해당 구장(club_id)의 승인 대기 내역만 정확히 삭제
                    db.run(
                        `DELETE FROM pending_registrations WHERE id = ? OR ((REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ?) AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = ''))))`,
                        [user.id, phoneDigits, rawPhone, clubId, clubId],
                        () => {
                            res.json({ success: true, message: '정회원 가입이 승인되었습니다.' });
                        }
                    );
                });
            });
        } else {
            // 💡 반려 처리 시에도 해당 구장(club_id)의 신청 건만 삭제
            db.run(
                `DELETE FROM pending_registrations WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ? OR phone = ?) AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))`,
                [phoneDigits, formattedPhone, rawPhone, targetClubId, targetClubId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ success: false, message: '반려 처리 중 오류가 발생했습니다.' });
                    }
                    res.json({ success: true, message: '가입 신청이 반려되었습니다.' });
                }
            );
        }
    } catch (error) {
        console.error('가입 승인 처리 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 4. 정회원 탈퇴 처리 API (구장별 격리, 전화번호 포맷 호환 및 대기열 정리 적용)
app.post('/api/member/withdraw', async (req, res) => {
    try {
        const { phone, name, clubId: reqClubId, club } = req.body;
        const clubId = String(reqClubId || club || 'unjeong').trim();

        const rawPhone = String(phone || '').trim();
        const phoneDigits = rawPhone.replace(/[^0-9]/g, '');

        if (!rawPhone && !phoneDigits) {
            return res.status(400).json({ success: false, message: '회원 정보를 확인할 수 없습니다.' });
        }

        // 1. regular_members 테이블에서 해당 클럽(club_id)의 회원만 특정하여 삭제
        const deleteMemberSql = `
            DELETE FROM regular_members 
            WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ?)
              AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
        `;

        db.run(deleteMemberSql, [phoneDigits, rawPhone, clubId, clubId], function(err) {
            if (err) {
                console.error(`❌ 회원 탈퇴 처리 오류 (${clubId} regular_members):`, err.message);
                return res.status(500).json({ success: false, message: '탈퇴 처리 중 서버 오류가 발생했습니다.' });
            }

            // 2. 해당 클럽의 pending_registrations 대기 내역만 삭제
            const deletePendingSql = `
                DELETE FROM pending_registrations 
                WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ?)
                  AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
            `;

            db.run(deletePendingSql, [phoneDigits, rawPhone, clubId, clubId], async (pendingErr) => {
                if (pendingErr) {
                    console.error(`❌ 대기 테이블 정리 오류 (${clubId}):`, pendingErr.message);
                }

                // 3. 해당 구장의 코트나 대기열에 회원이 들어가 있다면 즉시 정리
                if (typeof cleanupUser === 'function') {
                    try {
                        await cleanupUser(rawPhone, clubId);
                    } catch (cleanErr) {
                        console.error('탈퇴 유저 대기열 정리 오류:', cleanErr);
                    }
                }

                console.log(`🗑️ [${clubId} 회원 탈퇴 및 정리 완료]: 전화번호 ${rawPhone} (${name || '이름미확인'})`);
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
                // 🏢 [멀티테넌트 수정] 마스터 관리자 비활성화 상태 반영 (미설정 시 기본 true)
                isActive: club.isActive !== false
            };
        });

        res.json({ success: true, clubs: clubList });
    } catch (err) {
        console.error('클럽 목록 조회 에러:', err);
        res.status(500).json({ success: false, message: '클럽 목록 조회 실패' });
    }
});

// 📶 [추가] 모바일 클라이언트 전용 초경량 Wi-Fi 상태 확인 API
app.get('/api/check-wifi', (req, res) => {
    // 프록시/Render 환경 고려한 클라이언트 실제 IP 추출 및 정규화
    const forwarded = req.headers['x-forwarded-for'];
    const rawIp = forwarded ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || '');
    const clientIp = rawIp.replace(/^.*:/, '').trim();
    
    // 🏢 [멀티테넌트 수정] 구장 ID 누락 시 'unjeong' 설정을 오용하지 않도록 처리
    const clubId = req.query.clubId;
    if (!clubId) {
        return res.json({ isGymWifi: true, clientIp: clientIp, useWifiRestriction: false });
    }

    const club = (typeof getClub === 'function') ? getClub(clubId) : (clubs && clubs[clubId]);
    // 🏢 [멀티테넌트 수정] 전역 config(운정클럽) 폴백 제거 — 반드시 해당 구장의 config만 사용
    const targetConfig = (club && club.config) ? club.config : {};
    
    // IP 일치 여부 판별 (Wi-Fi 제한이 꺼져 있거나 등록된 IP가 없으면 무조건 true)
    let isGym = true;
    if (targetConfig && targetConfig.useWifiRestriction !== false && Array.isArray(targetConfig.allowedGymIps) && targetConfig.allowedGymIps.length > 0) {
        isGym = targetConfig.allowedGymIps.some(allowedIp => {
            const cleanAllowed = String(allowedIp).replace(/^.*:/, '').trim();
            return cleanAllowed && (cleanAllowed === clientIp || rawIp.includes(cleanAllowed));
        });
    }

    res.json({
        isGymWifi: isGym,
        clientIp: clientIp,
        useWifiRestriction: targetConfig ? (targetConfig.useWifiRestriction !== false) : true
    });
});

function initDatabase() {
    db.serialize(() => {
        // =========================================================================
        // 1. 정회원 테이블 (구장별 독립 가입 및 안전한 마이그레이션)
        // =========================================================================
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

        // =========================================================================
        // 🏷️ 회원 게임 성향 테이블 (구장별·회원명별 독립 저장)
        // =========================================================================
        db.run(`
            CREATE TABLE IF NOT EXISTS member_game_styles (
                club_id TEXT NOT NULL,
                member_name TEXT NOT NULL,
                tags TEXT DEFAULT '[]',
                memo TEXT DEFAULT '',
                updated_at TEXT,
                PRIMARY KEY (club_id, member_name)
            )
        `);

        // 기존 테이블 인덱스 점검 및 데이터 유실 없는 안전한 전환
        db.all(`PRAGMA index_list(regular_members)`, (err, indexes) => {
            const hasGlobalUnique = indexes && indexes.some(idx => idx.unique && idx.origin === 'u');
            if (hasGlobalUnique) {
                console.log('🔄 [DB 마이그레이션] 정회원 테이블을 구장별 분리 구조로 안전 변환합니다...');
                
                // 기존 테이블에 club_id 컬럼이 없을 수 있으므로 먼저 안전하게 컬럼을 추가해 둡니다.
                db.run(`ALTER TABLE regular_members ADD COLUMN club_id TEXT DEFAULT 'unjeong'`, () => {
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
                            // club_id가 확실히 보장된 상태에서 안전하게 복사
                            db.run(`
                                INSERT INTO regular_members 
                                SELECT id, COALESCE(club_id, 'unjeong'), type, username, password, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt 
                                FROM old_regular_members
                            `, (insertErr) => {
                                if (insertErr) {
                                    console.error('❌ 정회원 데이터 복사 실패:', insertErr.message);
                                } else {
                                    db.run(`DROP TABLE old_regular_members`);
                                    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_club_phone ON regular_members(club_id, phone)`);
                                    console.log('✅ [DB 마이그레이션 완료] 기존 정회원 데이터가 유실 없이 이전되었습니다.');
                                }
                            });
                        });
                    });
                });
            } else {
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_club_phone ON regular_members(club_id, phone)`);
            }
        });

        // =========================================================================
        // 2. 가입 대기 테이블 (pending_registrations) club_id 보강
        // =========================================================================
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

        // =========================================================================
        // 3. 일일 게스트 테이블 (daily_guests) club_id 및 성별/연령대/급수 보강
        // =========================================================================
        db.run(`
            CREATE TABLE IF NOT EXISTS daily_guests (
                id TEXT PRIMARY KEY,
                club_id TEXT DEFAULT 'unjeong',
                type TEXT,
                name TEXT,
                phone TEXT,
                gender TEXT DEFAULT '-',
                ageGroup TEXT DEFAULT '-',
                grade TEXT DEFAULT '일일',
                address TEXT,
                visitedAt TEXT
            )
        `, () => {
            db.run(`ALTER TABLE daily_guests ADD COLUMN club_id TEXT DEFAULT 'unjeong'`, () => {});
            db.run(`ALTER TABLE daily_guests ADD COLUMN gender TEXT DEFAULT '-'`, () => {});
            db.run(`ALTER TABLE daily_guests ADD COLUMN ageGroup TEXT DEFAULT '-'`, () => {});
            db.run(`ALTER TABLE daily_guests ADD COLUMN grade TEXT DEFAULT '일일'`, () => {});
        });

        // =========================================================================
        // 4. 공지사항 테이블 (notices) clubId 컬럼 탑재 및 기본값 처리
        // =========================================================================
        db.run(`
            CREATE TABLE IF NOT EXISTS notices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clubId TEXT DEFAULT 'unjeong',
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                author TEXT DEFAULT '관리자',
                createdAt TEXT NOT NULL
            )
        `, (err) => {
            if (!err) {
                // 기존 notices 테이블이 이미 만들어져 있던 경우를 위한 안전 컬럼 추가
                db.run(`ALTER TABLE notices ADD COLUMN clubId TEXT DEFAULT 'unjeong'`, () => {});

                // 기본 안내 공지사항 등록
                db.get(`SELECT COUNT(*) as count FROM notices`, (countErr, row) => {
                    if (row && row.count === 0) {
                        db.run(
                            `INSERT INTO notices (clubId, title, content, author, createdAt) VALUES (?, ?, ?, ?, ?)`,
                            ['unjeong', '체육관 이용 수칙 안내', '체육관 내 음료 및 음식물 반입을 금지합니다. 즐거운 배드민턴 되세요!', '관리자', '2026-09-03']
                        );
                    }
                });
            }
        });

        // =========================================================================
        // 5. 🏆 [전적 & 랭킹 확장] 일일회원 누적, 게임 전적, 커스텀 타이틀 테이블
        // =========================================================================
        // 5-1) 일일회원 누적 관리 테이블 (동일 인물 재방문 시 전적 연동용)
        db.run(`
            CREATE TABLE IF NOT EXISTS guest_members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                club_id TEXT DEFAULT 'unjeong',
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                gender TEXT DEFAULT '-',
                age_group TEXT DEFAULT '-',
                grade TEXT DEFAULT '일일',
                visit_count INTEGER DEFAULT 1,
                last_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(club_id, name, phone)
            )
        `);

        // 5-2) 게임 스코어 및 전적 기록 테이블
        db.run(`
            CREATE TABLE IF NOT EXISTS match_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                club_id TEXT DEFAULT 'unjeong',
                court_number INTEGER,
                match_type TEXT DEFAULT '자유',
                team_a_p1 TEXT NOT NULL,
                team_a_p2 TEXT,
                team_b_p1 TEXT NOT NULL,
                team_b_p2 TEXT,
                score_a INTEGER DEFAULT 0,
                score_b INTEGER DEFAULT 0,
                winner_team TEXT,
                played_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5-3) 관리자 커스텀 이벤트 타이틀(반짝이 뱃지) 설정 테이블
        db.run(`
            CREATE TABLE IF NOT EXISTS custom_titles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                club_id TEXT DEFAULT 'unjeong',
                title_name TEXT NOT NULL,
                metric_type TEXT NOT NULL,
                target_match_type TEXT DEFAULT 'ALL',
                min_games INTEGER DEFAULT 5,
                badge_theme TEXT DEFAULT 'gold',
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `, () => {
            console.log('✅ [DB 확장 완료] 일일회원, 경기전적, 커스텀타이틀 테이블 준비 완료');
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

// 🛡️ 등록된 클럽 존재 여부 확인 헬퍼 (삭제된 클럽 자동 부활 방지)
function isRegisteredClub(clubId) {
    if (!clubId || typeof clubs !== 'object' || !clubs) return false;
    const raw = String(clubId).trim();
    const lower = raw.toLowerCase();
    return Boolean(clubs[raw] || clubs[lower]);
}

// 🛡️ 삭제되었거나 존재하지 않는 클럽의 페이지 접속·새로고침 즉시 차단
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const reqPath = req.path || '';
    if (reqPath.startsWith('/api/') || reqPath.startsWith('/socket.io/') || reqPath.includes('super-admin')) {
        return next();
    }
    const isHtmlPage = reqPath === '/' || reqPath === '/admin' || reqPath === '/tv' || reqPath.endsWith('.html');
    const rawClub = req.query.club || req.query.clubId;

    if (isHtmlPage && rawClub && !isRegisteredClub(rawClub)) {
        const safeId = String(rawClub).replace(/[^a-zA-Z0-9_-]/g, '');
        return res.status(404).send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>클럽 운영 종료 안내</title>
</head>
<body style="margin:0; min-height:100vh; background:#0a0c10; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center;">
  <div style="max-width:440px; width:100%; background:#141824; border:1px solid #334155; border-radius:16px; padding:36px 24px; box-shadow:0 20px 50px rgba(0,0,0,0.5);">
    <div style="font-size:48px; margin-bottom:14px;">🚫</div>
    <h2 style="margin:0 0 12px 0; font-size:22px; color:#f87171;">접근할 수 없는 클럽입니다</h2>
    <p style="margin:0; font-size:15px; color:#cbd5e1; line-height:1.6;">
      해당 클럽은 운영이 종료되었거나 삭제되었습니다.<br>
      올바른 클럽 주소로 다시 접속해 주세요.
    </p>
  </div>
  <script>
    try {
      const deletedId = ${JSON.stringify(safeId)};
      if (deletedId) {
        Object.keys(localStorage).forEach(k => {
          if (k.includes(deletedId)) localStorage.removeItem(k);
        });
        const cur = localStorage.getItem('currentUser');
        if (cur && cur.includes(deletedId)) localStorage.removeItem('currentUser');
      }
      sessionStorage.clear();
    } catch (e) {}
  </script>
</body>
</html>`);
    }
    next();
});

// 정적 파일 및 라우팅 설정
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ⚙️ [멀티 테넌트] 클럽별 환경 설정 조회 API
// ==========================================
app.get('/api/config', (req, res) => {
    const clubId = String(req.query.clubId || req.query.club || 'unjeong').trim();
    const targetClub = (clubs && (clubs[clubId] || clubs[clubId.toLowerCase()])) || null;

    if (!targetClub) {
        return res.status(404).json({ error: 'club_deleted', message: '존재하지 않거나 삭제된 클럽입니다.' });
    }
    if (targetClub.config) {
        return res.json(targetClub.config);
    }
    if (clubId !== 'unjeong') {
        return res.json({});
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

// 1. 공지사항 목록 조회 API (구장별 필터링 및 기존 데이터 호환)
app.get('/api/notices', (req, res) => {
    const clubId = String(req.query.clubId || req.query.club || 'unjeong').trim();

    const sql = `
        SELECT * FROM notices
        WHERE clubId = ? OR (? = 'unjeong' AND (clubId IS NULL OR clubId = ''))
        ORDER BY id DESC
    `;

    db.all(sql, [clubId, clubId], (err, rows) => {
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
    const clubId = String(reqClubId || club || 'unjeong').trim();

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
    const { title, content, clubId: reqClubId, club } = req.body;
    const clubId = reqClubId || club || req.query.clubId || req.query.club;

    const sql = clubId
        ? `UPDATE notices SET title = ?, content = ? WHERE id = ? AND (clubId = ? OR (? = 'unjeong' AND (clubId IS NULL OR clubId = '')))`
        : `UPDATE notices SET title = ?, content = ? WHERE id = ?`;
    const params = clubId ? [title, content, noticeId, clubId, clubId] : [title, content, noticeId];

    db.run(sql, params, function(err) {
        if (err) {
            console.error('❌ 공지사항 수정 실패:', err.message);
            return res.status(500).json({ success: false, message: '공지사항 수정에 실패했습니다.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: '해당 공지사항을 찾을 수 없습니다.' });
        }
        if (clubId) {
            io.to(`club_${clubId}`).emit('noticeUpdated', { id: noticeId, title, content, clubId });
        }
        res.json({ success: true, message: '공지사항이 수정되었습니다.' });
    });
});

// 4. 공지사항 삭제 API
app.delete('/api/notices/:id', (req, res) => {
    const noticeId = req.params.id;
    const clubId = (req.body && (req.body.clubId || req.body.club)) || req.query.clubId || req.query.club;

    const sql = clubId
        ? `DELETE FROM notices WHERE id = ? AND (clubId = ? OR (? = 'unjeong' AND (clubId IS NULL OR clubId = '')))`
        : `DELETE FROM notices WHERE id = ?`;
    const params = clubId ? [noticeId, clubId, clubId] : [noticeId];

    db.run(sql, params, function(err) {
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

// 1. 회원 목록 조회 API (구장별 필터링 및 기존 데이터 호환 적용)
app.get('/api/members', (req, res) => {
    const clubId = String(req.query.clubId || req.query.club || 'unjeong').trim();

    const sql = `
        SELECT id, username, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt, club_id,
               COALESCE(NULLIF(member_status, ''), 'active') AS member_status,
               COALESCE(status_memo, '') AS status_memo,
               COALESCE(status_end_date, '') AS status_end_date,
               COALESCE(status_updated_at, '') AS status_updated_at 
        FROM regular_members 
        WHERE club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = ''))
        ORDER BY name ASC
    `;

    db.all(sql, [clubId, clubId], (err, rows) => {
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

// 2. 로그인 처리 API (구장별 엄격 격리 및 하이픈/공백/일괄등록 계정 완벽 호환)
app.post('/api/login', (req, res) => {
    const { username: rawUsername, password, clubId: reqClubId, club } = req.body;
    const targetClubId = String(reqClubId || club || 'unjeong').trim();
    const cleanInput = String(rawUsername || '').trim();

    if (!cleanInput) {
        return res.json({ success: false, message: '아이디(전화번호)를 입력해주세요.' });
    }

    const digits = cleanInput.replace(/[^0-9]/g, '');
    const formattedPhone = digits.length === 11
        ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`
        : (digits.length === 10
            ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`
            : cleanInput);

    const sql = `
        SELECT * FROM regular_members 
        WHERE (
            username = ? 
            OR id = ? 
            OR phone = ? 
            OR phone = ?
            OR (? != '' AND (
                REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? 
                OR REPLACE(REPLACE(username, '-', ''), ' ', '') = ?
                OR username = ?
                OR id = ?
                OR id = ?
            ))
        )
        AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
        LIMIT 1
    `;

    const params = [
        cleanInput,
        cleanInput,
        cleanInput,
        formattedPhone,
        digits,
        digits,
        digits,
        `user_${digits}`,
        `reg_${digits}`,
        `reg_${targetClubId}_${digits}`,
        targetClubId,
        targetClubId
    ];

    db.get(sql, params, (err, user) => {
        if (err) {
            console.error('❌ 로그인 DB 조회 에러:', err.message);
            return res.status(500).json({ success: false, message: '서버 에러가 발생했습니다.' });
        }

        if (!user) {
            return res.json({ success: false, message: '해당 클럽에 등록되지 않은 회원입니다. 가입 신청 후 승인을 받거나 일일회원으로 입장해 주세요.' });
        }

        if (String(user.password).trim() === String(password || '').trim()) {
            const { password: _, ...userInfo } = user;
            if (userInfo.name) userInfo.name = String(userInfo.name).trim();
            if (userInfo.phone) userInfo.phone = String(userInfo.phone).trim();
            if (!userInfo.club_id) userInfo.club_id = targetClubId;
            res.json({ success: true, user: userInfo });
        } else {
            res.json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    });
});

// 🏷️ [회원 상태 관리] 한국시간(KST) 날짜/일시 헬퍼
function getMemberKstDate() {
    const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    return `${nowKr.getFullYear()}-${String(nowKr.getMonth() + 1).padStart(2, '0')}-${String(nowKr.getDate()).padStart(2, '0')}`;
}
function getMemberKstDateTime() {
    const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    return `${getMemberKstDate()} ${String(nowKr.getHours()).padStart(2, '0')}:${String(nowKr.getMinutes()).padStart(2, '0')}`;
}

// 🏷️ 1. [관리자 직접] 정회원 상태 변경 API (활동/병가/휴면/탈퇴 + 발생일자 기록)
app.post('/api/member/status', (req, res) => {
    const { id, member_status, status_memo, status_end_date, clubId: reqClubId, club } = req.body || {};
    const allowedStatuses = ['active', 'sick', 'dormant', 'withdrawn'];

    if (!id) {
        return res.status(400).json({ success: false, message: '회원 고유 ID가 누락되었습니다.' });
    }
    if (!allowedStatuses.includes(member_status)) {
        return res.status(400).json({ success: false, message: '올바르지 않은 회원 상태값입니다.' });
    }

    const targetClubId = String(reqClubId || club || '').trim();
    const cleanMemo = member_status === 'active' ? '' : String(status_memo || '').trim().slice(0, 100);
    const cleanEndDate = (member_status === 'sick' || member_status === 'dormant')
        ? String(status_end_date || '').trim().slice(0, 20)
        : '';
    const todayKst = getMemberKstDate();

    const query = targetClubId
        ? `UPDATE regular_members
           SET member_status = ?, status_memo = ?, status_end_date = ?, status_updated_at = ?
           WHERE id = ? AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))`
        : `UPDATE regular_members
           SET member_status = ?, status_memo = ?, status_end_date = ?, status_updated_at = ?
           WHERE id = ?`;

    const params = targetClubId
        ? [member_status, cleanMemo, cleanEndDate, todayKst, id, targetClubId, targetClubId]
        : [member_status, cleanMemo, cleanEndDate, todayKst, id];

    db.run(query, params, function(err) {
        if (err) {
            console.error('❌ 회원 상태 변경 실패:', err.message);
            return res.status(500).json({ success: false, message: '회원 상태 변경 중 오류가 발생했습니다.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: '해당 클럽에서 회원을 찾을 수 없습니다.' });
        }
        // 관리자가 직접 상태를 변경하면 해당 회원의 기존 대기 신청 건도 정리
        db.run(
            `UPDATE member_status_requests SET request_status = 'handled' WHERE member_id = ? AND request_status = 'pending'`,
            [id],
            () => {}
        );
        const labelMap = { active: '활동(정회원)', sick: '병가', dormant: '휴면', withdrawn: '탈퇴' };
        res.json({ success: true, message: `회원 상태가 [${labelMap[member_status]}]으로 변경되었습니다. (${todayKst})` });
    });
});

// 🏷️ 2. [회원 신청] 병가·휴면·탈퇴 및 복귀·재입회 신청 접수 API
app.post('/api/member/status-request', (req, res) => {
    const { name, phone, requestedStatus, endDate, reason, clubId: reqClubId, club } = req.body || {};
    const targetClubId = String(reqClubId || club || 'unjeong').trim();
    const cleanName = String(name || '').trim();
    const phoneDigits = String(phone || '').replace(/[^0-9]/g, '');
    const allowedStatuses = ['active', 'sick', 'dormant', 'withdrawn'];

    if (!cleanName || phoneDigits.length < 10) {
        return res.status(400).json({ success: false, message: '회원 이름과 전화번호를 정확히 확인해 주세요.' });
    }
    if (!allowedStatuses.includes(requestedStatus)) {
        return res.status(400).json({ success: false, message: '올바르지 않은 신청 구분입니다.' });
    }

    const findMemberSql = `
        SELECT id, name, phone, COALESCE(NULLIF(member_status, ''), 'active') AS member_status
        FROM regular_members
        WHERE TRIM(name) = ?
          AND REPLACE(REPLACE(phone, '-', ''), ' ', '') = ?
          AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
        LIMIT 1
    `;

    db.get(findMemberSql, [cleanName, phoneDigits, targetClubId, targetClubId], (err, member) => {
        if (err) {
            return res.status(500).json({ success: false, message: '회원 조회 중 오류가 발생했습니다.' });
        }
        if (!member) {
            return res.status(404).json({ success: false, message: '해당 클럽에 등록된 정회원 정보를 찾을 수 없습니다.' });
        }

        const currentStatus = member.member_status || 'active';
        if (currentStatus === requestedStatus) {
            return res.status(400).json({ success: false, message: '이미 동일한 상태입니다.' });
        }
        if (currentStatus !== 'active' && requestedStatus !== 'active') {
            return res.status(400).json({ success: false, message: '현재 상태에서는 정회원 복귀(또는 재입회) 신청만 가능합니다.' });
        }

        // 동일 회원의 대기 중인 신청 중복 방지
        db.get(
            `SELECT id FROM member_status_requests WHERE member_id = ? AND club_id = ? AND request_status = 'pending' LIMIT 1`,
            [member.id, targetClubId],
            (dupErr, existing) => {
                if (existing) {
                    return res.status(400).json({ success: false, message: '이미 운영진 승인 대기 중인 신청 건이 있습니다.' });
                }

                const cleanEndDate = (requestedStatus === 'sick' || requestedStatus === 'dormant')
                    ? String(endDate || '').trim().slice(0, 20)
                    : '';
                const cleanReason = String(reason || '').trim().slice(0, 100);
                const createdAt = getMemberKstDateTime();

                db.run(
                    `INSERT INTO member_status_requests (member_id, club_id, name, phone, current_status, requested_status, end_date, reason, request_status, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                    [member.id, targetClubId, member.name, member.phone, currentStatus, requestedStatus, cleanEndDate, cleanReason, createdAt],
                    (insErr) => {
                        if (insErr) {
                            console.error('❌ 상태 변경 신청 저장 실패:', insErr.message);
                            return res.status(500).json({ success: false, message: '신청 접수 중 오류가 발생했습니다.' });
                        }
                        const reqLabel = requestedStatus === 'active'
                            ? (currentStatus === 'withdrawn' ? '정회원 재입회' : '정회원 복귀')
                            : ({ sick: '병가', dormant: '휴면', withdrawn: '탈퇴' }[requestedStatus]);
                        res.json({ success: true, message: `[${reqLabel}] 신청이 접수되었습니다. 운영진 승인 후 반영됩니다.` });
                    }
                );
            }
        );
    });
});

// 🏷️ 3. [관리자 조회] 복귀 및 상태 변경 대기 신청 목록 조회 API
app.get('/api/admin/status-requests', (req, res) => {
    const clubId = String(req.query.club || req.query.clubId || 'unjeong').trim();
    const sql = `
        SELECT id, member_id, club_id, name, phone, current_status, requested_status, end_date, reason, created_at
        FROM member_status_requests
        WHERE request_status = 'pending'
          AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
        ORDER BY id DESC
    `;
    db.all(sql, [clubId, clubId], (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, message: '신청 목록을 불러오지 못했습니다.' });
        }
        res.json({ success: true, data: rows || [] });
    });
});

// 🏷️ 4. [관리자 처리] 복귀 및 상태 변경 신청 승인/반려 API
app.post('/api/admin/process-status-request', (req, res) => {
    const { requestId, action, clubId: reqClubId, club } = req.body || {};
    const targetClubId = String(reqClubId || club || 'unjeong').trim();

    if (!requestId || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, message: '요청 정보가 올바르지 않습니다.' });
    }

    db.get(
        `SELECT * FROM member_status_requests
         WHERE id = ? AND request_status = 'pending'
           AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))`,
        [requestId, targetClubId, targetClubId],
        (err, reqRow) => {
            if (err || !reqRow) {
                return res.status(404).json({ success: false, message: '이미 처리되었거나 존재하지 않는 신청입니다.' });
            }

            if (action === 'reject') {
                return db.run(
                    `UPDATE member_status_requests SET request_status = 'rejected' WHERE id = ?`,
                    [requestId],
                    () => res.json({ success: true, message: `'${reqRow.name}' 님의 신청을 반려했습니다.` })
                );
            }

            const todayKst = getMemberKstDate();
            const isReturn = reqRow.requested_status === 'active';
            const nextMemo = isReturn ? '' : (reqRow.reason || '');
            const nextEndDate = (reqRow.requested_status === 'sick' || reqRow.requested_status === 'dormant')
                ? (reqRow.end_date || '')
                : '';

            db.run(
                `UPDATE regular_members
                 SET member_status = ?, status_memo = ?, status_end_date = ?, status_updated_at = ?
                 WHERE id = ?`,
                [reqRow.requested_status, nextMemo, nextEndDate, todayKst, reqRow.member_id],
                (updErr) => {
                    if (updErr) {
                        console.error('❌ 신청 승인 반영 실패:', updErr.message);
                        return res.status(500).json({ success: false, message: '승인 처리 중 오류가 발생했습니다.' });
                    }
                    db.run(
                        `UPDATE member_status_requests SET request_status = 'approved' WHERE id = ?`,
                        [requestId],
                        () => {
                            const labelMap = { active: '활동(정회원 복귀)', sick: '병가', dormant: '휴면', withdrawn: '탈퇴' };
                            res.json({
                                success: true,
                                message: `'${reqRow.name}' 님의 [${labelMap[reqRow.requested_status]}] 신청이 승인되었습니다. (${todayKst})`
                            });
                        }
                    );
                }
            );
        }
    );
});

// =========================================================================
// 💬 [고객지원 · FAQ · 문의/오류 제보 · 오픈채팅] 독립 REST API
// =========================================================================
function getSupportKstDateTime() {
    const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const y = nowKr.getFullYear();
    const m = String(nowKr.getMonth() + 1).padStart(2, '0');
    const d = String(nowKr.getDate()).padStart(2, '0');
    const hh = String(nowKr.getHours()).padStart(2, '0');
    const mm = String(nowKr.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
}

// 1. 사용자용 FAQ 목록 + 카카오톡 오픈채팅 URL 조회
app.get('/api/support/init', (req, res) => {
    db.all(`SELECT id, category, question, answer, created_at FROM support_faqs ORDER BY id ASC`, [], (faqErr, faqs) => {
        if (faqErr) {
            return res.status(500).json({ success: false, message: 'FAQ 조회 실패' });
        }
        db.get(`SELECT value FROM platform_settings WHERE key = 'kakao_open_chat_url'`, [], (setErr, setRow) => {
            res.json({
                success: true,
                faqs: faqs || [],
                kakaoOpenChatUrl: (setRow && setRow.value) ? String(setRow.value).trim() : ''
            });
        });
    });
});

// 2. 사용자 문의 · 오류 제보 접수
app.post('/api/support/inquiry', (req, res) => {
    const { clubId, memberName, memberPhone, isGuest, category, content, deviceInfo, wifiInfo } = req.body || {};
    const targetClubId = String(clubId || 'unjeong').trim();
    const allowedCats = ['question', 'bug', 'feature', 'club'];
    const cleanCategory = allowedCats.includes(category) ? category : 'question';
    const cleanContent = String(content || '').trim().slice(0, 1000);
    const cleanName = String(memberName || '비로그인 사용자').trim().slice(0, 40);
    const cleanPhone = String(memberPhone || '').trim().slice(0, 30);
    const cleanDevice = String(deviceInfo || '').trim().slice(0, 180);
    const cleanWifi = String(wifiInfo || '').trim().slice(0, 80);

    if (cleanContent.length < 2) {
        return res.status(400).json({ success: false, message: '문의 또는 제보 내용을 2자 이상 입력해 주세요.' });
    }

    const clubObj = (typeof getClub === 'function') ? getClub(targetClubId) : null;
    const clubName = (clubObj && (clubObj.clubName || clubObj.name)) || targetClubId;
    const createdAt = getSupportKstDateTime();

    db.run(
        `INSERT INTO user_inquiries (club_id, club_name, member_name, member_phone, is_guest, category, content, device_info, wifi_info, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [targetClubId, clubName, cleanName, cleanPhone, isGuest ? 1 : 0, cleanCategory, cleanContent, cleanDevice, cleanWifi, createdAt],
        function(err) {
            if (err) {
                console.error('❌ 문의 접수 저장 실패:', err.message);
                return res.status(500).json({ success: false, message: '문의 접수 중 오류가 발생했습니다.' });
            }
            res.json({ success: true, id: this.lastID, message: '문의가 정상적으로 접수되었습니다. 확인 후 답변드리겠습니다.' });
        }
    );
});

// 3. 사용자 본인 문의 내역 및 답변 조회
app.get('/api/support/my-inquiries', (req, res) => {
    const clubId = String(req.query.club || req.query.clubId || 'unjeong').trim();
    const rawPhone = String(req.query.phone || '').replace(/[^0-9]/g, '');
    const rawName = String(req.query.name || '').trim();

    if (!rawPhone && !rawName) {
        return res.json({ success: true, data: [] });
    }

    const sql = rawPhone
        ? `SELECT id, category, content, status, reply, replied_by, created_at, replied_at
           FROM user_inquiries
           WHERE club_id = ? AND REPLACE(REPLACE(member_phone, '-', ''), ' ', '') = ?
           ORDER BY id DESC LIMIT 30`
        : `SELECT id, category, content, status, reply, replied_by, created_at, replied_at
           FROM user_inquiries
           WHERE club_id = ? AND TRIM(member_name) = ?
           ORDER BY id DESC LIMIT 30`;

    db.all(sql, [clubId, rawPhone || rawName], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: '내 문의 내역 조회 실패' });
        res.json({ success: true, data: rows || [] });
    });
});

// 4. [클럽 관리자] 해당 구장의 '클럽 운영 문의' 조회
app.get('/api/admin/inquiries', (req, res) => {
    const clubId = String(req.query.club || req.query.clubId || 'unjeong').trim();
    db.all(
        `SELECT id, member_name, member_phone, is_guest, category, content, device_info, wifi_info, status, reply, replied_by, created_at, replied_at
         FROM user_inquiries
         WHERE club_id = ? AND category = 'club'
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC LIMIT 50`,
        [clubId],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: '문의 목록 조회 실패' });
            res.json({ success: true, data: rows || [] });
        }
    );
});

// 5. [클럽 관리자] 클럽 운영 문의 답변 저장
app.post('/api/admin/inquiries/reply', (req, res) => {
    const { id, reply, clubId } = req.body || {};
    const targetClubId = String(clubId || 'unjeong').trim();
    const cleanReply = String(reply || '').trim().slice(0, 1000);
    if (!id || !cleanReply) {
        return res.status(400).json({ success: false, message: '답변 내용을 입력해 주세요.' });
    }
    const repliedAt = getSupportKstDateTime();
    db.run(
        `UPDATE user_inquiries SET reply = ?, status = 'answered', replied_by = '클럽 운영진', replied_at = ?
         WHERE id = ? AND club_id = ? AND category = 'club'`,
        [cleanReply, repliedAt, id, targetClubId],
        function(err) {
            if (err || this.changes === 0) {
                return res.status(500).json({ success: false, message: '답변 저장에 실패했습니다.' });
            }
            res.json({ success: true, message: '답변이 저장되었습니다.' });
        }
    );
});

// 6. [클럽 관리자] 클럽 운영 문의 삭제
app.post('/api/admin/inquiries/delete', (req, res) => {
    const { id, clubId } = req.body || {};
    const targetClubId = String(clubId || 'unjeong').trim();
    if (!id) return res.status(400).json({ success: false, message: 'ID가 누락되었습니다.' });
    db.run(`DELETE FROM user_inquiries WHERE id = ? AND club_id = ? AND category = 'club'`, [id, targetClubId], (err) => {
        if (err) return res.status(500).json({ success: false, message: '삭제 실패' });
        res.json({ success: true, message: '문의가 삭제되었습니다.' });
    });
});

// 회원 정보 수정 API (파라미터 누락 버그 수정 및 전화번호 정규화/멀티테넌트 적용)
app.post('/api/member/update', (req, res) => {
    const { id, phone: rawPhone, grade, address: rawAddress, clubId: reqClubId, club } = req.body;

    if (!id) {
        return res.status(400).json({ success: false, message: '회원 고유 ID가 누락되었습니다.' });
    }

    // 💡 전화번호 정규화 (하이픈 표준 포맷 유지) 및 주소 공백 제거
    const phoneDigits = String(rawPhone || '').replace(/[^0-9]/g, '');
    let formattedPhone = String(rawPhone || '').trim();
    if (phoneDigits.length === 11) {
        formattedPhone = `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 7)}-${phoneDigits.slice(7, 11)}`;
    } else if (phoneDigits.length === 10) {
        formattedPhone = `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6, 10)}`;
    }
    const cleanAddress = String(rawAddress || '').trim();
    const targetClubId = String(reqClubId || club || '').trim();

    // 💡 username이 기존 전화번호 형태였던 경우 함께 갱신하되, user_ 로 시작하는 일괄등록 계정은 유지
    // 💡 누락되었던 4번째 파라미터(id)를 정확히 매칭하고, clubId가 전달된 경우 해당 구장 회원만 안전하게 수정
    const query = targetClubId
        ? `UPDATE regular_members 
           SET phone = ?, 
               username = CASE WHEN username LIKE 'user_%' THEN username ELSE ? END, 
               grade = ?, 
               address = ? 
           WHERE id = ? AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))`
        : `UPDATE regular_members 
           SET phone = ?, 
               username = CASE WHEN username LIKE 'user_%' THEN username ELSE ? END, 
               grade = ?, 
               address = ? 
           WHERE id = ?`;

    const params = targetClubId
        ? [formattedPhone, formattedPhone, grade, cleanAddress, id, targetClubId, targetClubId]
        : [formattedPhone, formattedPhone, grade, cleanAddress, id];

    db.run(query, params, function(err) {
        if (err) {
            console.error('❌ 회원 정보 수정 실패:', err.message);
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(400).json({ success: false, message: '이미 해당 클럽에 등록된 전화번호입니다.' });
            }
            return res.status(500).json({ success: false, message: '수정 중 오류가 발생했습니다.' });
        }
        res.json({ success: true, message: '회원 정보가 수정되었습니다.' });
    });
});

// 3. 🧹 [디버깅 로그가 강화된 슬롯 청소 및 자동 방 폭파 함수]
async function cleanupUser(usernameOrObj, clubId = null) {
    if (!usernameOrObj) {
        console.log("⚠️ [청소 중단] 전달된 유저 정보가 없습니다.");
        return;
    }

    let targetId = '';
    let targetName = '';
    // 🏢 [멀티테넌트 수정] 전달된 회원 객체/JSON 내부의 clubId도 함께 추출
    let embeddedClubId = null;

    if (typeof usernameOrObj === 'object' && usernameOrObj !== null) {
        targetId = usernameOrObj.id || usernameOrObj.phone || '';
        targetName = usernameOrObj.name || '';
        embeddedClubId = usernameOrObj.clubId || null;
    } else if (typeof usernameOrObj === 'string') {
        if (usernameOrObj.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(usernameOrObj);
                targetId = parsed.id || parsed.phone || '';
                targetName = parsed.name || '';
                embeddedClubId = parsed.clubId || null;
            } catch (e) {
                targetId = usernameOrObj;
                targetName = usernameOrObj;
            }
        } else {
            targetId = usernameOrObj;
            targetName = usernameOrObj;
        }
    }

    // 🏢 [멀티테넌트 수정] 명시적 clubId -> 객체 내장 clubId 순으로 최종 구장 확정
    const resolvedClubId = (clubId && String(clubId).trim()) || (embeddedClubId && String(embeddedClubId).trim()) || null;

    const cleanId = String(targetId).replace(/^user_/, '').trim();
    const hyphenId = cleanId.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');

    let dbRow = null;
    if (targetId === '010-0000-0000' || targetName === '관리자' || targetId === '관리자') {
        dbRow = { id: '010-0000-0000', name: '관리자' };
    } else {
        try {
            // 🏢 [멀티테넌트 수정] 특정 구장 청소 시 해당 구장(club_id) 소속 회원만 조회하여 타 구장 동명이인 오매칭 차단
            const useClubFilter = Boolean(resolvedClubId && resolvedClubId !== 'all');
            const sql = useClubFilter
                ? `SELECT id, name FROM regular_members WHERE (id = ? OR phone = ? OR phone = ? OR phone = ? OR name = ?) AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))`
                : `SELECT id, name FROM regular_members WHERE id = ? OR phone = ? OR phone = ? OR phone = ? OR name = ?`;
            const params = useClubFilter
                ? [targetId, cleanId, hyphenId, targetId, targetName, resolvedClubId, resolvedClubId]
                : [targetId, cleanId, hyphenId, targetId, targetName];

            dbRow = await new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                });
            });
        } catch (e) {
            console.error('❌ [청소 DB 조회 에러]:', e.message);
        }
    }

    const realId = dbRow ? dbRow.id : targetId;
    const realName = dbRow ? dbRow.name : targetName;
    const pureName = String(realName).replace(/님$/, '').split('/')[0].split('|')[0].trim();
    const purePhone = String(realId).replace(/[^0-9]/g, '');

    if (!resolvedClubId) {
        console.warn(`⚠️ [멀티테넌트 경고] clubId 없이 cleanupUser("${pureName}")가 호출되었습니다.`);
    }

    // 🏢 [멀티테넌트 수정] 실제 존재하는 clubs 키만 대상에 포함 (삭제된 구장 폴백 제거)
    const targetClubs = (resolvedClubId && resolvedClubId !== 'all') 
        ? [resolvedClubId] 
        : (typeof clubs !== 'undefined' && clubs ? Object.keys(clubs) : ['unjeong']);

    console.log(`\n========================================`);
    console.log(`🧹 [청소 시작] 대상: "${pureName}" (ID: ${realId}), 구장:`, targetClubs);

    for (const cid of targetClubs) {
        // 🏢 [멀티테넌트 수정] getClub() 대신 clubs[cid] 직접 조회로 삭제된 구장 자동 부활 차단
        const club = (typeof clubs !== 'undefined' && clubs) ? clubs[cid] : null;
        if (!club) continue;

        const checkMatch = (str) => {
            if (!str) return false;
            const s = typeof str === 'object' ? JSON.stringify(str) : String(str);
            if (pureName && s.includes(pureName)) return true;
            if (purePhone.length >= 7 && s.replace(/[^0-9]/g, '').includes(purePhone)) return true;
            return false;
        };

        // 1️⃣ 게임 대기열 청소
        if (Array.isArray(club.gameQueue)) {
            const validGameQueue = [];
            club.gameQueue.forEach((slot) => {
                if (checkMatch(slot)) {
                    if (slot.userIds && Array.isArray(slot.userIds)) {
                        slot.userIds = slot.userIds.filter(id => id !== realId && !checkMatch(id));
                    }
                    if (slot.players && Array.isArray(slot.players)) {
                        slot.players = slot.players.map(p => checkMatch(p) ? '' : p);
                    }
                }

                const validPlayers = (typeof getValidPlayers === 'function') 
                    ? getValidPlayers(slot.players) 
                    : (slot.players || []).filter(p => p && p !== '');
                
                if (validPlayers.length > 0) {
                    validGameQueue.push(slot);
                }
            });

            club.gameQueue.length = 0;
            club.gameQueue.push(...validGameQueue);
        }

        // 2️⃣ 난타 대기열 청소
        if (Array.isArray(club.nantaQueue)) {
            const validNantaQueue = [];
            club.nantaQueue.forEach((slot) => {
                if (checkMatch(slot)) {
                    if (slot.userIds && Array.isArray(slot.userIds)) {
                        slot.userIds = slot.userIds.filter(id => id !== realId && !checkMatch(id));
                    }
                    if (slot.players && Array.isArray(slot.players)) {
                        slot.players = slot.players.map(p => checkMatch(p) ? '' : p);
                    }
                }

                const validPlayers = (typeof getValidPlayers === 'function') 
                    ? getValidPlayers(slot.players) 
                    : (slot.players || []).filter(p => p && p !== '');
                
                if (validPlayers.length > 0) {
                    validNantaQueue.push(slot);
                }
            });

            club.nantaQueue.length = 0;
            club.nantaQueue.push(...validNantaQueue);
        }

        // 💡 대기방 목록 브로드캐스트
        if (typeof broadcastState === 'function') {
            broadcastState(cid);
        }

        // 💡 [핵심 보강] 상단 4대 현황(게임, 난타, 운동중, 접속자) 카운트 즉시 동기화
        if (typeof broadcastOnlineCount === 'function') {
            broadcastOnlineCount(cid);
        }
    }

    console.log(`========================================\n`);
}

// 4. 로그아웃 API
app.post('/api/logout', async (req, res) => {
    const { username, user, clubId: reqClubId, club } = req.body;
    const target = user || username;

    // 🏢 [멀티테넌트 수정] 요청 본문 또는 user 객체 내부에서 현재 구장 ID(clubId) 추출
    const clubId = reqClubId
        || club
        || (target && typeof target === 'object' ? target.clubId : null)
        || 'unjeong';

    const cleanName = (target && typeof target === 'object')
        ? String(target.name || target.username || target.id || target.phone || '').replace(/님$/, '').split('/')[0].trim()
        : String(target || '').replace(/님$/, '').split('/')[0].trim();

    console.log(`🧹 [로그아웃 요청 수신 - ${clubId}] 유저 데이터 정리 중...`, cleanName || target);

    if (target) {
        // 🏢 [멀티테넌트 수정] 반드시 해당 구장(clubId)을 함께 전달하여 타 구장 대기방 삭제 차단
        await cleanupUser(target, clubId);
    }

    if (cleanName) {
        // 🏢 [멀티테넌트 수정] 해당 구장의 유예/만료 타이머 및 소켓 매핑 즉시 정리
        if (typeof gymSessionManager !== 'undefined' && typeof gymSessionManager.clearUserImmediately === 'function') {
            gymSessionManager.clearUserImmediately(cleanName, clubId);
        }
        if (typeof activeUserSockets !== 'undefined' && activeUserSockets.delete) {
            activeUserSockets.delete(`${clubId}_${cleanName}`);
        }
    }

    if (typeof broadcastOnlineCount === 'function') {
        broadcastOnlineCount(clubId);
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

    // 🏢 [멀티테넌트 수정] 강제 퇴장된 회원의 해당 구장 잔여 타이머 정리 및 전광판 인원 갱신
    const cleanName = String(target).replace(/님$/, '').split('/')[0].trim();
    if (cleanName && typeof gymSessionManager !== 'undefined' && typeof gymSessionManager.clearUserImmediately === 'function') {
        gymSessionManager.clearUserImmediately(cleanName, clubId);
    }
    if (typeof broadcastOnlineCount === 'function') {
        broadcastOnlineCount(clubId);
    }

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
    // 🏢 [멀티테넌트 수정] 구장 ID 누락 호출 추적용 경고 (기존 동작은 안전하게 유지)
    if (!clubId || !String(clubId).trim()) {
        console.warn('⚠️ [멀티테넌트 경고] clubId 없이 getClub()이 호출되어 기본값(unjeong)으로 처리됩니다.');
    }
    const id = (clubId && String(clubId).trim()) || 'unjeong';
    
    // 🏢 기본 한글 클럽 명칭 매핑
    const defaultClubNames = {
        'unjeong': '운정배드민턴클럽',
        'daewon': '대원배드민턴클럽'
    };

    // 🏢 [멀티테넌트 수정] defaultConfig 깊은 복사 헬퍼 (구장 간 배열/객체 참조 공유 차단)
    const cloneDefaultConfig = () => {
        const base = (typeof defaultConfig !== 'undefined')
            ? JSON.parse(JSON.stringify(defaultConfig))
            : {};
        return {
            ...base,
            allowedGymIps: Array.isArray(base.allowedGymIps) && id === 'unjeong' ? [...base.allowedGymIps] : [],
            queueGraceMinutes: base.queueGraceMinutes ?? 30,
            sessionExpireMinutes: base.sessionExpireMinutes ?? 60
        };
    };

    // 🏢 [멀티테넌트 수정] 타 구장 선수 데이터가 섞이지 않은 깨끗한 코트 배열 생성 헬퍼
    const createCleanCourts = () => {
        if (typeof createDefaultCourts === 'function') {
            return createDefaultCourts();
        }
        if (typeof courtsData !== 'undefined' && Array.isArray(courtsData)) {
            return JSON.parse(JSON.stringify(courtsData)).map((c, idx) => ({
                ...c,
                id: c.id || (idx + 1),
                status: 'empty',
                matchType: '',
                players: [],
                startTime: null
            }));
        }
        return [];
    };

    if (!clubs[id]) {
        if (id === 'unjeong') {
            clubs[id] = {
                clubId: id,
                clubName: defaultClubNames[id] || `${id}배드민턴클럽`,
                config: cloneDefaultConfig(),
                courtsData: createCleanCourts(),
                gameQueue: [],
                nantaQueue: [],
                notifications: [],
                slotIdCounter: 1
            };
        } else {
            // 🛡️ 삭제되었거나 마스터에 등록되지 않은 클럽은 clubs 메모리에 재생성하지 않음
            return {
                clubId: id,
                clubName: '',
                isDeleted: true,
                config: {},
                courtsData: [],
                gameQueue: [],
                nantaQueue: [],
                notifications: [],
                slotIdCounter: 1
            };
        }
    } else {
        // 🏢 [멀티테넌트 수정] 마스터 관리자에서 먼저 생성된 클럽이라도 필수 런타임 필드가 누락되지 않도록 자동 보강
        if (!clubs[id].clubId) clubs[id].clubId = id;
        if (!clubs[id].clubName) {
            clubs[id].clubName = (clubs[id].config && clubs[id].config.clubName)
                || defaultClubNames[id]
                || `${id}배드민턴클럽`;
        }
        if (!clubs[id].config || typeof clubs[id].config !== 'object') {
            clubs[id].config = cloneDefaultConfig();
        } else {
            if (typeof clubs[id].config.queueGraceMinutes === 'undefined') clubs[id].config.queueGraceMinutes = 30;
            if (typeof clubs[id].config.sessionExpireMinutes === 'undefined') clubs[id].config.sessionExpireMinutes = 60;
        }
        if (!Array.isArray(clubs[id].courtsData)) clubs[id].courtsData = createCleanCourts();
        if (!Array.isArray(clubs[id].gameQueue)) clubs[id].gameQueue = [];
        if (!Array.isArray(clubs[id].nantaQueue)) clubs[id].nantaQueue = [];
        if (!Array.isArray(clubs[id].notifications)) clubs[id].notifications = [];
        if (typeof clubs[id].slotIdCounter !== 'number') clubs[id].slotIdCounter = 1;
    }

    return clubs[id];
}
// ==========================================
// 5. 유틸리티 및 브로드캐스트 함수
// ==========================================
// ==========================================
// 📡 [멀티 테넌트] 클럽별 실시간 상태 브로드캐스트 (경량화 + 서명 기록)
// ==========================================
function buildClubStateSignature(cid, club, cCourtsData, cGameQueue, cNantaQueue) {
    try {
        const courtsSig = (cCourtsData || []).map(c => ({
            id: c.id,
            type: c.type,
            isEmpty: !!c.isEmpty,
            players: c.players || '',
            teams: c.teams ? [c.teams.teamA, c.teams.teamB] : null,
            sideA: c.sideA ? { e: !!c.sideA.isEmpty, p: c.sideA.players || '', s: c.sideA.startTime || 0 } : null,
            sideB: c.sideB ? { e: !!c.sideB.isEmpty, p: c.sideB.players || '', s: c.sideB.startTime || 0 } : null
        }));
        const mapQueueSig = (q) => (q || []).map(s => ({
            id: s.id,
            p: s.players,
            f: s.fullAt || 0,
            pen: s.penaltyApplied || null
        }));
        return JSON.stringify({
            clean: Boolean(club && club.isCleaningTime),
            courts: courtsSig,
            gq: mapQueueSig(cGameQueue),
            nq: mapQueueSig(cNantaQueue)
        });
    } catch (e) {
        return String(Date.now());
    }
}

// 📡 [신규] 새로 접속한 단일 소켓(관리자·회원·TV)에 초기 상태(코트·대기열·설정) 즉시 1회 전송
function sendStateToSocket(targetSocket, cid) {
    if (!targetSocket || !cid) return;
    const club = (typeof getClub === 'function') ? getClub(cid) : (typeof clubs === 'object' ? clubs[cid] : {});
    if (club && club.isDeleted) return;

    const cCourtsData = (club && Array.isArray(club.courtsData) && club.courtsData.length > 0)
        ? club.courtsData
        : (cid === 'unjeong' && typeof courtsData !== 'undefined' ? courtsData : (club ? club.courtsData : []));

    const cGameQueue = (club && Array.isArray(club.gameQueue))
        ? club.gameQueue
        : (cid === 'unjeong' && typeof gameQueue !== 'undefined' ? gameQueue : []);

    const cNantaQueue = (club && Array.isArray(club.nantaQueue))
        ? club.nantaQueue
        : (cid === 'unjeong' && typeof nantaQueue !== 'undefined' ? nantaQueue : []);

    const cConfig = (club && club.config) || (typeof config !== 'undefined' ? config : {});

    targetSocket.emit('stateUpdated', {
        clubId: (club && club.clubId) || cid,
        clubName: (club && (club.clubName || club.name)) || cid,
        isCleaningTime: Boolean(club && club.isCleaningTime),
        courtsData: cCourtsData || [],
        gameQueue: cGameQueue || [],
        nantaQueue: cNantaQueue || [],
        notifications: [],
        config: cConfig
    });
}

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

        const cConfig = (club && club.config) || (typeof config !== 'undefined' ? config : {});

        // 최신 전송 상태 서명 저장 (1초 루프에서 중복 전송 방지용)
        if (club) {
            club._lastBroadcastSignature = buildClubStateSignature(cid, club, cCourtsData, cGameQueue, cNantaQueue);
        }

        // 💡 notifications는 이미 'newNotification' 소켓으로 개별 실시간 전송되므로 stateUpdated에서는 빈 배열로 경량화
        io.to(`club_${cid}`).emit('stateUpdated', {
            clubId: (club && club.clubId) || cid,
            clubName: (club && (club.clubName || club.name)) || cid,
            isCleaningTime: Boolean(club && club.isCleaningTime),
            courtsData: cCourtsData || [],
            gameQueue: cGameQueue || [],
            nantaQueue: cNantaQueue || [],
            notifications: [],
            config: cConfig
        });

        // 💡 대기열/코트 상태가 실제로 바뀔 때만 상단 전광판(게임/난타 인원) 동기화
        if (typeof broadcastOnlineCount === 'function') {
            broadcastOnlineCount(cid);
        }
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

    // 🏢 [멀티테넌트 수정] 구장 ID 정규화
    const targetClubId = (clubId && String(clubId).trim()) || 'default';

    // 당일 알림 필터 헬퍼
    const filterTodayOnly = (list) => {
        if (!Array.isArray(list)) return [];
        return list.filter(n => {
            if (!n) return false;
            let itemDate = n.date;
            if (!itemDate && n.timestamp) {
                const d = new Date(n.timestamp);
                itemDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
            return itemDate === todayStr;
        });
    };

    // 💡 1. 당일(오늘) 알림만 서버 메모리에 유지 (어제 이전 알림 자동 정리)
    notifications = filterTodayOnly(notifications);

    // 💡 2. 새 알림 객체 생성 (구장 ID 및 대상자 포함)
    const newNoti = { 
        message, 
        clubId: targetClubId,
        targetUser: targetUser || null,
        time: timeStr, 
        date: todayStr,
        timestamp: now.getTime() 
    };

    notifications.unshift(newNoti);
    if (notifications.length > 50) notifications.pop();

    // 🏢 [멀티테넌트 수정] 구장별 독립 알림 배열(clubs[targetClubId].notifications)에도 분리 보관
    if (targetClubId !== 'default' && typeof clubs !== 'undefined' && clubs[targetClubId]) {
        clubs[targetClubId].notifications = filterTodayOnly(clubs[targetClubId].notifications);
        clubs[targetClubId].notifications.unshift(newNoti);
        if (clubs[targetClubId].notifications.length > 50) {
            clubs[targetClubId].notifications.pop();
        }
    }

    // 💡 3. 🏢 [멀티테넌트 수정] 해당 구장 룸(club_${targetClubId})에만 전송 (타 구장 데이터 유출 차단)
    try {
        if (typeof io !== 'undefined' && io) {
            if (targetClubId !== 'default') {
                io.to(`club_${targetClubId}`).emit('newNotification', newNoti);
            } else {
                io.emit('newNotification', newNoti);
            }
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
    // 💡 서버(Render) 시간대와 무관하게 항상 한국 시간(KST) 기준으로 현재 시각 계산
    const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const currentHHMM = `${String(nowKr.getHours()).padStart(2, '0')}:${String(nowKr.getMinutes()).padStart(2, '0')}`;

    // 💡 현재 시각 기준 10초 뒤의 'HH:MM' 계산 (청소 종료 10초 전 사전 알림용)
    const after10SecKr = new Date(nowKr.getTime() + 10000);
    const future10SecHHMM = String(after10SecKr.getHours()).padStart(2, '0') + ':' + String(after10SecKr.getMinutes()).padStart(2, '0');

    // 🏢 [멀티 테넌트] 등록된 각 클럽별로 독립적으로 청소 시간, 대기열 및 코트 타이머 순회
    const clubIdsToRun = (typeof clubs === 'object' && Object.keys(clubs).length > 0) ? Object.keys(clubs) : ['unjeong'];

    clubIdsToRun.forEach(cId => {
        const club = clubs[cId] || {};
        let hasChanged = false; // ⚡ 실제로 화면 갱신이 필요한 상태 변화가 생겼을 때만 true
        
        // 💡 공용 config 기본값과 해당 클럽의 고유 config를 안전하게 병합 (타이머 설정값 누락/NaN 방지)
        const baseConfig = (typeof config !== 'undefined' && config) ? config : {};
        if (!club.config) {
            club.config = JSON.parse(JSON.stringify(baseConfig));
        }
        const clubConfig = club.config;
        const entryTimeoutSec = Number(clubConfig.ENTRY_TIMEOUT_SEC) || Number(baseConfig.ENTRY_TIMEOUT_SEC) || 120;
        const nantaLimitSec = Number(clubConfig.NANTA_COURT_LIMIT_SEC) || Number(baseConfig.NANTA_COURT_LIMIT_SEC) || 600;

        // 클럽별 독립된 청소 상태 관리 (클럽 객체 내부에 isCleaningTime 유지)
        if (typeof club.isCleaningTime === 'undefined') {
            club.isCleaningTime = false;
        }

        const cGameQueue = club.gameQueue || (cId === 'unjeong' ? gameQueue : []);
        const cNantaQueue = club.nantaQueue || (cId === 'unjeong' ? nantaQueue : []);
        const cCourtsData = club.courtsData || (cId === 'unjeong' ? courtsData : []);

        const schedules = clubConfig.cleaningSchedules || [];

        // 💡 빈 스케줄("")은 제외하고 현재 시각에 해당하는 스케줄의 인덱스(0~3)를 탐색
        const activeIdx = schedules.findIndex(s => {
            if (!s || !s.start || !s.end || s.start === s.end) return false;
            return s.start < s.end
                ? (currentHHMM >= s.start && currentHHMM < s.end)
                : (currentHHMM >= s.start || currentHHMM < s.end);
        });
        const activeSchedule = activeIdx !== -1 ? schedules[activeIdx] : null;

        // 💡 10초 뒤에도 여전히 청소 시간인지 확인 (종료 10초 전 감지용)
        const activeAfter10SecIdx = schedules.findIndex(s => {
            if (!s || !s.start || !s.end || s.start === s.end) return false;
            return s.start < s.end
                ? (future10SecHHMM >= s.start && future10SecHHMM < s.end)
                : (future10SecHHMM >= s.start || future10SecHHMM < s.end);
        });

        // 1) 해당 클럽의 청소 시작 시점 감지
        if (activeSchedule && !club.isCleaningTime) {
            club.isCleaningTime = true;
            club.cleaningEndAlertSent = false;
            hasChanged = true;

            const slotNum = activeSchedule.slot || (activeIdx + 1);
            club.activeCleaningSlot = slotNum;

            const customStartMsg = (clubConfig[`cleaningStartMsg_${slotNum}`] && clubConfig[`cleaningStartMsg_${slotNum}`].trim()) ||
                                   (activeSchedule.startMsg && activeSchedule.startMsg.trim()) ||
                                   (clubConfig.cleaningStartMsg && clubConfig.cleaningStartMsg.trim());
            const startMsg = customStartMsg || '구장 청소 및 정비 시간입니다. 잠시 코트 이용을 중단해 주시기 바랍니다.';
           
            pushVoiceAnnouncement(cId, {
                clubId: cId,
                matchType: '공지',
                names: [],
                message: startMsg
            });

            io.to(`club_${cId}`).emit('toastAlert', `🧹 ${startMsg}`);

            const startAlertPayload = {
                clubId: cId,
                type: 'start',
                title: slotNum === 4 ? '🌙 구장 운영 마감 및 휴장 안내' : '🧹 구장 청소 및 코트 정비 시간',
                message: startMsg,
                duration: 120000
            };
            io.to(`tv-room_${cId}`).to(`tv-room-${cId}`).emit('tvCleaningAlert', startAlertPayload);

            if (typeof addNotification === 'function') {
                addNotification(`🧹 [구장 청소 시작] ${startMsg}`, cId);
            }
        }

        // 1-2) 청소 종료 10초 전 시점 감지
        if (club.isCleaningTime && !club.cleaningEndAlertSent && activeAfter10SecIdx === -1) {
            club.cleaningEndAlertSent = true;
            const endedSlotNum = club.activeCleaningSlot || 1;
            const endedScheduleObj = schedules[endedSlotNum - 1] || {};

            const customEndMsg = (clubConfig[`cleaningEndMsg_${endedSlotNum}`] && clubConfig[`cleaningEndMsg_${endedSlotNum}`].trim()) ||
                                 (endedScheduleObj.endMsg && endedScheduleObj.endMsg.trim()) ||
                                 (clubConfig.cleaningEndMsg && clubConfig.cleaningEndMsg.trim());
            const endMsg = customEndMsg || '구장 청소가 완료되었습니다. 코트 이용을 재개해 주시기 바랍니다.';

            pushVoiceAnnouncement(cId, {
                clubId: cId,
                matchType: '공지',
                names: [],
                message: endMsg
            });

            io.to(`club_${cId}`).emit('toastAlert', `🏸 ${endMsg}`);

            const endAlertPayload = {
                clubId: cId,
                type: 'end',
                title: '🏸 구장 청소 완료 안내',
                message: endMsg,
                duration: 10000
            };
            io.to(`tv-room_${cId}`).to(`tv-room-${cId}`).emit('tvCleaningAlert', endAlertPayload);

            if (typeof addNotification === 'function') {
                addNotification(`✅ [구장 청소 종료 안내] ${endMsg}`, cId);
            }
        }

        // 2) 해당 클럽의 실제 청소 종료 시점 감지
        if (!activeSchedule && club.isCleaningTime) {
            club.isCleaningTime = false;
            club.activeCleaningSlot = null;
            club.cleaningEndAlertSent = false;
            hasChanged = true;
        }

        // 3) 청소 진행 중인 경우 해당 클럽의 타이머 동결 처리 (시작 시점 1회 외에는 매초 브로드캐스트 생략)
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

            if (hasChanged && typeof broadcastState === 'function') {
                broadcastState(cId);
            }
            return;
        }

        // -------------------------------------------------------------
        // 아래부터는 기존의 게임 및 난타 대기열/코트 타이머 루프 로직
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
                    hasChanged = true; // ⚡ 카운트다운 최초 시작
                }
                
                const prevRem = slot.remainingSeconds;
                const elapsed = Math.floor((now - slot.fullAt) / 1000);
                slot.remainingSeconds = Math.max(0, entryTimeoutSec - elapsed);

                // 관리자 설정 변경 등으로 남은 시간이 2초 이상 급변한 경우 재동기화
                if (typeof prevRem === 'number' && Math.abs(slot.remainingSeconds - prevRem) > 2) {
                    hasChanged = true;
                }

                const validPlayers = getValidPlayers(slot.players);
                const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                const emptyGameCourts = cCourtsData.filter(c => c.type === 'game' && c.isEmpty);
                const targetCourt = emptyGameCourts[activeTimerCount - 1] || emptyGameCourts[0];
                const courtNum = targetCourt ? targetCourt.id : '';

                // 📱 [1단계: 0초 즉시] 스마트폰 전용 신호('mobileEntryAlert') 발송
                if (!slot.mobileNotified) {
                    slot.mobileNotified = true;
                    io.to(`club_${cId}`).emit('mobileEntryAlert', {
                        clubId: cId,
                        matchType: '게임',
                        courtNumber: courtNum,
                        targetPlayers: memberNames
                    });
                }

                // 📺 [2단계: 10초 경과 시점] 미입장 시 TV 팝업('entryPopupAlert')과 음성 방송 동시 송출
                if (elapsed >= 10 && !slot.announced) {
                    slot.announced = true;

                    pushVoiceAnnouncement(cId, {
                        clubId: cId,
                        courtNumber: courtNum,
                        names: memberNames,
                        matchType: '게임'
                    });

                    io.to(`club_${cId}`).emit('entryPopupAlert', {
                        clubId: cId,
                        matchType: '게임',
                        courtNumber: courtNum,
                        targetPlayers: memberNames
                    });
                }

                if (slot.remainingSeconds === 0) {
                    const targetIdx = cGameQueue.findIndex(s => s.id === slot.id);
                    if (targetIdx !== -1) {
                        const expiredTeam = cGameQueue.splice(targetIdx, 1)[0];
                        hasChanged = true; // ⚡ 시간 초과로 대기방 삭제됨

                        const expiredValidPlayers = getValidPlayers(expiredTeam.players);
                        const expiredMemberNames = expiredValidPlayers.map(p => p.split('/')[0].trim());

                        io.to(`club_${cId}`).emit('tvPopupAlert', {
                            clubId: cId,
                            matchType: '게임',
                            names: expiredMemberNames,
                            message: '입장 시간 초과로 게임 대기방이 삭제되었습니다.<br>게임 대기를 원하시면 다시 등록해 주세요.'
                        });

                        const cancelPersonalMsg = '코트 입장 제한 시간(초과)으로 인해 게임 대기방이 취소되었습니다. 다시 대기 등록을 해주세요.';
                        expiredValidPlayers.forEach(playerStr => {
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
                if (slot.fullAt !== null || slot.remainingSeconds !== null) {
                    hasChanged = true; // ⚡ 카운트다운 중단/초기화
                }
                slot.fullAt = null;
                slot.remainingSeconds = null;
                slot.announced = false;
                slot.mobileNotified = false;
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
                    hasChanged = true; // ⚡ 난타 카운트다운 최초 시작
                }

                const prevRem = slot.remainingSeconds;
                const elapsed = Math.floor((now - slot.fullAt) / 1000);
                slot.remainingSeconds = Math.max(0, entryTimeoutSec - elapsed);

                if (typeof prevRem === 'number' && Math.abs(slot.remainingSeconds - prevRem) > 2) {
                    hasChanged = true;
                }

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

                // 📱 [1단계: 0초 즉시] 스마트폰 전용 신호('mobileEntryAlert') 발송
                if (!slot.mobileNotified) {
                    slot.mobileNotified = true;
                    io.to(`club_${cId}`).emit('mobileEntryAlert', {
                        clubId: cId,
                        matchType: '난타',
                        courtNumber: targetCourtNum,
                        targetPlayers: memberNames
                    });
                }

                // 📺 [2단계: 10초 경과 시점] 미입장 시 TV 팝업('entryPopupAlert')과 음성 방송 동시 송출
                if (elapsed >= 10 && !slot.announced) {
                    slot.announced = true;

                    pushVoiceAnnouncement(cId, {
                        clubId: cId,
                        courtNumber: targetCourtNum,
                        names: memberNames,
                        matchType: '난타'
                    });

                    io.to(`club_${cId}`).emit('entryPopupAlert', {
                        clubId: cId,
                        matchType: '난타',
                        courtNumber: targetCourtNum,
                        targetPlayers: memberNames
                    });
                }

                if (slot.remainingSeconds === 0) {
                    const index = cNantaQueue.findIndex(s => s.id === slot.id);
                    if (index !== -1) {
                        const expiredTeam = cNantaQueue.splice(index, 1)[0];
                        hasChanged = true; // ⚡ 시간 초과로 난타 대기방 삭제됨

                        const expiredValidPlayers = getValidPlayers(expiredTeam.players);
                        const expiredMemberNames = expiredValidPlayers.map(p => p.split('/')[0].trim());

                        io.to(`club_${cId}`).emit('tvPopupAlert', {
                            clubId: cId,
                            matchType: '난타',
                            names: expiredMemberNames,
                            message: '입장 시간 초과로 난타 대기방이 삭제되었습니다.<br>난타 대기를 원하시면 다시 등록해 주세요.'
                        });

                        const cancelPersonalMsg = '코트 입장 제한 시간(초과)으로 인해 난타 대기방이 취소되었습니다. 다시 대기 등록을 해주세요.';
                        expiredValidPlayers.forEach(playerStr => {
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
                if (slot.fullAt !== null || slot.remainingSeconds !== null) {
                    hasChanged = true;
                }
                slot.fullAt = null;
                slot.remainingSeconds = null;
                slot.announced = false;
                slot.mobileNotified = false;
            }
        });

        // 3. 진행 중인 난타 코트 잔여시간 처리
        cCourtsData.forEach(court => {
            if (court.type === 'nanta') {
                ['sideA', 'sideB'].forEach(side => {
                    if (court[side] && !court[side].isEmpty && court[side].startTime) {
                        const prevRem = court[side].remainingSeconds;
                        const elapsed = Math.floor((now - court[side].startTime) / 1000);
                        court[side].remainingSeconds = Math.max(0, nantaLimitSec - elapsed);

                        if (typeof prevRem === 'number' && Math.abs(court[side].remainingSeconds - prevRem) > 2) {
                            hasChanged = true;
                        }
                        
                        if (court[side].remainingSeconds === 60 && !court[side].warned1Min) {
                            court[side].warned1Min = true;
                            const sideName = (side === 'sideA') ? 'A면' : 'B면';
                            
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
                            hasChanged = true; // ⚡ 난타 코트 시간 종료로 자동 비움
                            
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
                            hasChanged = true; // ⚡ 예약된 코트 유형 전환 적용
                        }
                    }
                });
            }
        });

        // 🛡️ 안전망: 다른 핸들러에서 상태가 바뀌었으나 broadcastState가 누락된 경우 자동 감지
        if (!hasChanged && typeof buildClubStateSignature === 'function') {
            const currentSig = buildClubStateSignature(cId, club, cCourtsData, cGameQueue, cNantaQueue);
            if (club._lastBroadcastSignature && club._lastBroadcastSignature !== currentSig) {
                hasChanged = true;
            }
        }

        // 4. 실제 상태 변경이 있을 때만 해당 클럽에 실시간 전송
        if (hasChanged && typeof broadcastState === 'function') {
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

// 💡 [핵심] 서버 기동 시 단 1회 초기화 (connection 바깥에 위치)
 gymSessionManager.init({
    io,
    clubs,
    getClub,
    cleanupUser,
    broadcastState,
    broadcastOnlineCount
});

io.on('connection', (socket) => {

    // 🏢 [멀티 테넌트] 접속한 클라이언트의 클럽 룸 배정 (삭제된 구장은 즉시 차단)
    const rawClubParam = socket.handshake.query && (socket.handshake.query.club || socket.handshake.query.clubId);
    const clientClubId = (rawClubParam && String(rawClubParam).trim()) || 'unjeong';

    if (rawClubParam && !isRegisteredClub(clientClubId)) {
        console.warn(`🚫 [소켓 접속 차단] 존재하지 않거나 삭제된 클럽(${clientClubId})`);
        socket.emit('clubDeleted', {
            clubId: clientClubId,
            message: '운영이 종료되었거나 삭제된 클럽입니다.'
        });
        setTimeout(() => socket.disconnect(true), 150);
        return;
    }

    socket.clubId = clientClubId;
    socket.join(`club_${clientClubId}`);
    console.log(`🏸 [클럽 입장] 소켓(${socket.id})이 club_${clientClubId} 룸에 참여했습니다.`);

    // 📡 [신규] 신규 접속 소켓(관리자·회원·TV)에 초기 코트 현황 및 클럽 설정 즉시 1회 전송
    if (typeof sendStateToSocket === 'function') {
        sendStateToSocket(socket, clientClubId);
    }

    // 📶 [신규] 스마트폰 5G↔Wi-Fi 전환 시 최신 실측 IP 동기화 (토글 OFF 중 망 전환 추적용)
    socket.on('updateClientIp', (data) => {
        if (data && data.clientIp) {
            socket.verifiedClientIp = String(data.clientIp).replace(/^.*:/, '').trim();
        }
    });

    // 🏢 [멀티테넌트 수정] 소켓의 소속 구장 룸을 안전하게 전환하는 헬퍼 (이전 구장 방 잔류 차단)
    const switchSocketClubRoom = (newClubId) => {
        if (!newClubId) return;
        if (socket.clubId && socket.clubId !== newClubId) {
            socket.leave(`club_${socket.clubId}`);
        }
        socket.clubId = newClubId;
        socket.join(`club_${newClubId}`);
    };

    // =================================================================
    // 🛡️ [복구됨] Wi-Fi 상태 기반 접근 제어 가드
    // =================================================================
    const checkWifiGuard = (actionTitle = '기능을 이용') => {
        const clubId = socket.clubId || 'unjeong';
        if (typeof isGymWifiUser === 'function' && !isGymWifiUser(socket, clubId)) {
            // ui.js와 동일한 문구로 통일
            socket.emit('alertMessage', '⚠️ 구장 전용 Wi-Fi에 접속 후 이용해 주세요.');
            return false;
        }
        return true;
    };

    // =================================================================
    // ⏱️ [신규] Wi-Fi 상태 기반 타이머 통합 제어 (유예 & 만료 동시 작동)
    // =================================================================
    const applyWifiTimerLogic = (socket, cleanUsername, clubId) => {
        if (!cleanUsername || cleanUsername === '0100') return;
        const targetClubId = clubId || socket.clubId || clientClubId || 'unjeong';

        socket.finalName = cleanUsername;
        socket.username = cleanUsername;
        switchSocketClubRoom(targetClubId);

        const isWifiMatch = (typeof isGymWifiUser === 'function') ? isGymWifiUser(socket, targetClubId) : true;

        if (isWifiMatch) {
            // ✅ [Wi-Fi 일치] 구장망 접속: 매니저에게 기존 타이머 전면 초기화(취소) 지시
            console.log(`🔄 [타이머 초기화] [${targetClubId}] 유저(${cleanUsername}) Wi-Fi 일치 확인 완료`);
            socket.inGym = true;
            socket.isGymWifi = true;
            socket.inGracePeriod = false;
            if (typeof gymSessionManager !== 'undefined') {
                gymSessionManager.handleConnect(socket, cleanUsername, targetClubId);
            }
        } else {
            // 🚫 [Wi-Fi 불일치] 외부망 접속: 매니저가 이전 구장 접속 여부에 따라 1단계/2단계 타이머 판단
            socket.inGym = false;
            socket.isGymWifi = false;
            if (typeof gymSessionManager !== 'undefined') {
                gymSessionManager.handleDisconnect(socket, cleanUsername, targetClubId);
            }
        }
    };

    // =================================================================
    // ⏱️ [핵심 복구] 초기 핸드셰이크 유저 정보 매핑 (Wi-Fi 일치 시에만 타이머 해제)
    // =================================================================
    const incomingPhone = socket.handshake.query && socket.handshake.query.phone;
    const incomingUser = socket.handshake.query && socket.handshake.query.username;
    const incomingRaw = socket.handshake.query && socket.handshake.query.rawUser;

    const candidateUser = incomingUser || incomingPhone || incomingRaw;

    if (candidateUser) {
        const cleanCandidate = String(candidateUser).replace(/님$/, '').split('/')[0].split('|')[0].trim();
        if (cleanCandidate && cleanCandidate !== '0100') {
            socket.username = cleanCandidate;
            if (typeof userSockets !== 'undefined') {
                userSockets[socket.id] = { username: cleanCandidate, clubId: clientClubId };
            }
        }
    }
    
    // 🔄 [Wi-Fi 재검증 처리]
    socket.on('verifyWifi', (data) => {
        const targetClubId = (data && data.clubId) || socket.clubId || clientClubId || 'unjeong';
        
        const forwarded = socket.handshake.headers['x-forwarded-for'];
        const rawIp = (forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address) || '';
        const clientIp = rawIp.replace(/^.*:/, '').trim();

        const isValid = typeof isGymWifiUser === 'function' ? isGymWifiUser(socket, targetClubId) : true;
        const club = (typeof getClub === 'function') ? getClub(targetClubId) : (typeof clubs !== 'undefined' ? clubs[targetClubId] : null);
        const useWifiRestriction = (club && club.config) ? (club.config.useWifiRestriction !== false) : true;

        console.log(`📡 [Wi-Fi 재검증] [${targetClubId}] IP: ${clientIp}, 결과: ${isValid}`);
        
        socket.emit('wifiStatus', { 
            clubId: targetClubId,
            isGymWifi: isValid,
            clientIp: clientIp,
            useWifiRestriction: useWifiRestriction
        });
    });
    
    // ⏱️ [핵심] Wi-Fi 복귀 시 유예 & 세션 만료 타이머 즉시 초기화 (gymSessionManager 일원화)
    socket.on('cancelDisconnectTimer', async (userData) => {
        const targetClubId = (userData && userData.clubId) || socket.clubId || clientClubId || 'unjeong';
        const rawUser = (userData && (userData.username || userData.name || userData.phone || userData.userKey)) || socket.finalName || socket.username || socket.phone || '';
        let cleanUsername = String(rawUser).replace(/님$/, '').split('/')[0].split('|')[0].trim();

        if (cleanUsername && /^[0-9\-]+$/.test(cleanUsername) && typeof db !== 'undefined') {
            const digits = cleanUsername.replace(/[^0-9]/g, '');
            const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
            try {
                // 🏢 [멀티테넌트 수정] 해당 구장 소속 회원만 이름 조회
                const row = await new Promise((resolve) => {
                    db.get(
                        `SELECT name FROM regular_members WHERE (id = ? OR phone = ? OR phone = ?) AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))`,
                        [cleanUsername, digits, hyphen, targetClubId, targetClubId],
                        (err, res) => resolve(res)
                    );
                });
                if (row && row.name) cleanUsername = row.name;
            } catch (e) {}
        }

        if (!cleanUsername || cleanUsername === '0100') return;

        socket.finalName = cleanUsername;
        socket.username = cleanUsername;
        switchSocketClubRoom(targetClubId);

        const clubTimerKey = `${targetClubId}_${cleanUsername}`;
        if (typeof disconnectTimers !== 'undefined') {
            if (disconnectTimers[clubTimerKey]) {
                clearTimeout(disconnectTimers[clubTimerKey]);
                delete disconnectTimers[clubTimerKey];
            }
            if (disconnectTimers[cleanUsername]) {
                clearTimeout(disconnectTimers[cleanUsername]);
                delete disconnectTimers[cleanUsername];
            }
        }

        if (typeof gymSessionManager !== 'undefined') {
            gymSessionManager.handleConnect(socket, cleanUsername, targetClubId);
        }
    });

    // ⏱️ [핵심] Wi-Fi 이탈 시 1단계(대기방 유예) & 2단계(세션 만료) 타이머 동시 가동 (gymSessionManager 일원화)
    socket.on('startDisconnectTimer', async (userData) => {
        const targetClubId = (userData && userData.clubId) || socket.clubId || clientClubId || 'unjeong';
        const rawUser = (userData && (userData.username || userData.name || userData.phone)) || socket.finalName || socket.username || socket.phone || '';
        let cleanUsername = String(rawUser).replace(/님$/, '').split('/')[0].split('|')[0].trim();

        if (cleanUsername && /^[0-9\-]+$/.test(cleanUsername) && typeof db !== 'undefined') {
            const digits = cleanUsername.replace(/[^0-9]/g, '');
            const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
            try {
                // 🏢 [멀티테넌트 수정] 해당 구장 소속 회원만 이름 조회
                const row = await new Promise((resolve) => {
                    db.get(
                        `SELECT name FROM regular_members WHERE (id = ? OR phone = ? OR phone = ?) AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))`,
                        [cleanUsername, digits, hyphen, targetClubId, targetClubId],
                        (err, res) => resolve(res)
                    );
                });
                if (row && row.name) cleanUsername = row.name;
            } catch (e) {}
        }

        if (!cleanUsername || cleanUsername === '0100') return;

        socket.finalName = cleanUsername;
        socket.username = cleanUsername;
        switchSocketClubRoom(targetClubId);

        if (typeof gymSessionManager !== 'undefined') {
            gymSessionManager.handleDisconnect(socket, cleanUsername, targetClubId);
        }
    });

    // 📶 접속자의 구장 Wi-Fi 여부 및 관리자 제한 설정(ON/OFF) 판별 후 개별 전달
    const initialIsGym = (typeof isGymWifiUser === 'function') ? isGymWifiUser(socket, clientClubId) : true;
    const initialClientIp = (typeof getClientIp === 'function') ? getClientIp(socket) : '';
    const initialClub = (typeof getClub === 'function') ? getClub(clientClubId) : (typeof clubs !== 'undefined' ? clubs[clientClubId] : null);
    const initialUseWifiRestriction = (initialClub && initialClub.config) ? (initialClub.config.useWifiRestriction !== false) : true;

    socket.emit('wifiStatus', { 
        clubId: clientClubId,
        isGymWifi: initialIsGym, 
        clientIp: initialClientIp, 
        useWifiRestriction: initialUseWifiRestriction 
    });

   // 🔔 로그인 사용자 소켓 등록 처리 및 복귀(Reconnect) 라이프사이클 연결
    socket.on('registerUser', async (userData) => {
        if (userData && (userData.phone || userData.name || userData.username)) {
            const rawName = userData.name || userData.username || userData.phone;
            let cleanUsername = String(rawName).replace(/님$/, '').split('/')[0].split('|')[0].trim();
            const cleanPhone = String(userData.phone || cleanUsername).replace(/[^0-9a-zA-Z가-힣_]/g, '');
            const targetClubId = userData.clubId || socket.clubId || clientClubId || 'unjeong';

            // 전화번호만 들어온 경우 DB에서 해당 구장의 진짜 이름 조회
            if (cleanUsername && /^[0-9\-]+$/.test(cleanUsername) && typeof db !== 'undefined') {
                const digits = cleanUsername.replace(/[^0-9]/g, '');
                const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
                try {
                    // 🏢 [멀티테넌트 수정] 구장 조건 포함 조회
                    const row = await new Promise((resolve) => {
                        db.get(
                            `SELECT name FROM regular_members WHERE (id = ? OR phone = ? OR phone = ?) AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))`,
                            [cleanUsername, digits, hyphen, targetClubId, targetClubId],
                            (err, res) => resolve(res)
                        );
                    });
                    if (row && row.name) cleanUsername = row.name;
                } catch (e) {}
            }

            if (!cleanUsername || cleanUsername === '0100') return;

            // 🏢 [멀티테넌트 수정] 구장 전용 개인 채널 + 기존 호환 채널 동시 가입 및 구장 룸 안전 전환
            socket.join(`user_${targetClubId}_${cleanPhone}`);
            socket.join(`user_${cleanPhone}`);
            switchSocketClubRoom(targetClubId);

            socket.userIdentifier = cleanPhone;
            socket.userId = userData.id || cleanPhone;
            socket.username = cleanUsername;
            socket.finalName = cleanUsername;

            if (typeof userSockets !== 'undefined') {
                userSockets[socket.id] = { username: cleanUsername, clubId: targetClubId };
            }
            // 중복 로그인 퇴출은 registerUserSession에서만 단일 처리 (신규 로그인 기기 자가 퇴출 방지)
            if (typeof activeUserSockets !== 'undefined' && activeUserSockets.set) {
                const clubUserKey = `${targetClubId}_${cleanUsername}`;
                if (!activeUserSockets.has(clubUserKey)) {
                    activeUserSockets.set(clubUserKey, socket.id);
                }
            }

            console.log(`👤 [소켓 등록/복귀] 유저(${cleanUsername}), 구장(${targetClubId}), 소켓ID(${socket.id})`);

            applyWifiTimerLogic(socket, cleanUsername, targetClubId);

            if (typeof broadcastOnlineCount === 'function') {
                broadcastOnlineCount(targetClubId);
            }
        }
    });


    // 💡 사용자가 세션을 등록할 때 (자동 복귀 검증 및 신규 로그인 승인)
    socket.on('registerUserSession', async (data) => {
        if (!data) return;

        let rawUsername = '';
        let isAutoRestore = false;

        if (typeof data === 'object' && data !== null) {
            rawUsername = data.name || data.username || data.user || data.id || '';
            isAutoRestore = Boolean(data.isAutoRestore);
        } else {
            rawUsername = String(data);
        }

        let cleanUsername = String(rawUsername).replace(/님$/, '').split('/')[0].split('|')[0].trim();
        if (!cleanUsername || cleanUsername === '0100') return;

        const incomingClubId = (typeof data === 'object' && data.clubId) || socket.clubId || clientClubId || 'unjeong';

        if (/^[0-9\-]+$/.test(cleanUsername) && typeof db !== 'undefined') {
            const digits = cleanUsername.replace(/[^0-9]/g, '');
            const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
            try {
                // 🏢 [멀티테넌트 수정] 해당 구장 소속 회원만 조회
                const row = await new Promise((resolve) => {
                    db.get(
                        `SELECT name FROM regular_members WHERE (id = ? OR phone = ? OR phone = ?) AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))`,
                        [cleanUsername, digits, hyphen, incomingClubId, incomingClubId],
                        (err, res) => resolve(res)
                    );
                });
                if (row && row.name) cleanUsername = row.name;
            } catch (e) {}
        }

        const clubUserKey = `${incomingClubId}_${cleanUsername}`;
        const managerUserKey = `${incomingClubId}:${cleanUsername}`;
        const isExpiredInManager = (typeof gymSessionManager !== 'undefined' && gymSessionManager.expiredUsers && gymSessionManager.expiredUsers.has(managerUserKey));
        // 🏢 [멀티테넌트 수정] 만료 키도 구장별 복합 키 기준으로 확인
        const isExpiredLegacy = (typeof expiredUsers !== 'undefined' && Boolean(expiredUsers[clubUserKey]));

        // 🚨 [세션 만료 검증 분기]
        if (isExpiredInManager || isExpiredLegacy) {
            if (isAutoRestore) {
                setTimeout(() => {
                    if (typeof gymSessionManager !== 'undefined' && gymSessionManager.expiredUsers) gymSessionManager.expiredUsers.delete(managerUserKey);
                    if (typeof expiredUsers !== 'undefined') delete expiredUsers[clubUserKey];
                }, 3000);
                console.log(`[접속 차단] [${incomingClubId}] 유저(${cleanUsername})는 세션이 완전 만료되어 자동 복귀를 차단하고 강제 로그아웃 신호를 전송합니다.`);

                socket.emit('forceSessionExpire', {
                    targetUser: cleanUsername,
                    clubId: incomingClubId,
                    message: '장시간 체육관 Wi-Fi 미접속으로 세션이 만료되었습니다. 다시 로그인해 주세요.'
                });
                return;
            } else {
                if (typeof gymSessionManager !== 'undefined' && gymSessionManager.expiredUsers) gymSessionManager.expiredUsers.delete(managerUserKey);
                if (typeof expiredUsers !== 'undefined') delete expiredUsers[clubUserKey];
                console.log(`[신규 로그인] [${incomingClubId}] 유저(${cleanUsername})가 직접 로그인하여 이전 만료 상태를 초기화하고 정상 접속합니다.`);
            }
        }

        // 🚪 동일 구장 내 중복 로그인 감지 (기존 탭/기기 소켓이 실제로 살아 연결된 경우에만 1회 퇴출 신호 전송)
        if (activeUserSockets.has(clubUserKey)) {
            const oldSocketId = activeUserSockets.get(clubUserKey);
            if (oldSocketId && oldSocketId !== socket.id) {
                const oldSocket = io.sockets.sockets.get(oldSocketId);

                // 🏢 [멀티테넌트 수정] 기존 소켓이 아직 연결(connected) 상태라면 자동 로그인 복구(isAutoRestore)라도 이전 창 종료
                if (oldSocket && oldSocket.connected && !oldSocket.isKicked) {
                    oldSocket.isKicked = true;
                    console.log(`🚪 [중복 로그인 감지] [${incomingClubId}] ${cleanUsername} 기존 세션(${oldSocketId}) 종료 전송`);
                    io.to(oldSocketId).emit('forceLogout', {
                        username: cleanUsername,
                        clubId: incomingClubId,
                        reason: 'duplicate_login',
                        message: '동일 구장에 다른 기기 또는 브라우저에서 로그인하여 이전 창이 종료되었습니다.'
                    });
                }
            }
        }

        // 🏢 [멀티테넌트 수정] 구장별 복합 키 기준으로만 타이머 정리 (타 구장 대기열 간섭 차단)
        if (typeof disconnectTimers !== 'undefined' && disconnectTimers[clubUserKey]) {
            clearTimeout(disconnectTimers[clubUserKey]);
            delete disconnectTimers[clubUserKey];
        }
        if (typeof sessionTimers !== 'undefined' && sessionTimers[clubUserKey]) {
            clearTimeout(sessionTimers[clubUserKey]);
            delete sessionTimers[clubUserKey];
        }

        // 💾 구장별 세션 키 및 진짜 이름으로 소켓 완벽 등록
        socket.connectedAt = Date.now();
        activeUserSockets.set(clubUserKey, socket.id);
        socket.username = cleanUsername;
        socket.finalName = cleanUsername;
        socket.clubUserKey = clubUserKey;
        switchSocketClubRoom(incomingClubId);

        if (typeof userSockets !== 'undefined') {
            userSockets[socket.id] = { username: cleanUsername, clubId: incomingClubId };
        }

        applyWifiTimerLogic(socket, cleanUsername, incomingClubId);

        if (typeof broadcastOnlineCount === 'function') {
            broadcastOnlineCount(incomingClubId);
        }
    });

    // 🏷️ 구장별 회원 게임 성향 전체 조회
    socket.on('getGameStyles', (data) => {
        const targetClubId = (data && data.clubId) || socket.clubId || clientClubId || 'unjeong';
        if (typeof db === 'undefined') return;

        db.all(`SELECT member_name, tags, memo FROM member_game_styles WHERE club_id = ?`, [targetClubId], (err, rows) => {
            if (err || !rows) return;
            const stylesMap = {};
            rows.forEach((r) => {
                let parsedTags = [];
                try { parsedTags = JSON.parse(r.tags || '[]'); } catch (e) {}
                if ((Array.isArray(parsedTags) && parsedTags.length > 0) || (r.memo && r.memo.trim() !== '')) {
                    stylesMap[r.member_name] = {
                        tags: parsedTags,
                        memo: r.memo || ''
                    };
                }
            });
            socket.emit('gameStylesUpdated', { clubId: targetClubId, styles: stylesMap });
        });
    });

    // 🏷️ 내 게임 성향 저장/초기화 및 같은 구장 실시간 브로드캐스트
    socket.on('saveGameStyle', (data, callback) => {
        if (!data || !data.memberName || typeof db === 'undefined') {
            if (typeof callback === 'function') callback({ ok: false });
            return;
        }
        const targetClubId = data.clubId || socket.clubId || clientClubId || 'unjeong';
        const cleanName = String(data.memberName).replace(/\(일일\)/g, '').replace(/님$/, '').trim();
        const safeTags = Array.isArray(data.tags) ? data.tags.slice(0, 2).map(t => String(t).slice(0, 30)) : [];
        const safeMemo = String(data.memo || '').trim().slice(0, 40);
        const nowIso = new Date().toISOString();

        const broadcastClubStyles = () => {
            db.all(`SELECT member_name, tags, memo FROM member_game_styles WHERE club_id = ?`, [targetClubId], (err, rows) => {
                if (!err && rows) {
                    const stylesMap = {};
                    rows.forEach((r) => {
                        let parsedTags = [];
                        try { parsedTags = JSON.parse(r.tags || '[]'); } catch (e) {}
                        if ((Array.isArray(parsedTags) && parsedTags.length > 0) || (r.memo && r.memo.trim() !== '')) {
                            stylesMap[r.member_name] = { tags: parsedTags, memo: r.memo || '' };
                        }
                    });
                    io.to(`club_${targetClubId}`).emit('gameStylesUpdated', { clubId: targetClubId, styles: stylesMap });
                }
                if (typeof callback === 'function') callback({ ok: true });
            });
        };

        if (safeTags.length === 0 && safeMemo === '') {
            db.run(`DELETE FROM member_game_styles WHERE club_id = ? AND member_name = ?`, [targetClubId, cleanName], broadcastClubStyles);
        } else {
            db.run(
                `INSERT INTO member_game_styles (club_id, member_name, tags, memo, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(club_id, member_name) DO UPDATE SET
                    tags = excluded.tags,
                    memo = excluded.memo,
                    updated_at = excluded.updated_at`,
                [targetClubId, cleanName, JSON.stringify(safeTags), safeMemo, nowIso],
                broadcastClubStyles
            );
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
    
    // 🔑 [수정] 정회원 로그인 처리 소켓 이벤트 (클럽별 회원 분리)
    socket.on('loginMember', ({ name, phone, clubId }, callback) => {
        const trimmedName = name ? name.trim() : '';
        const cleanInputPhone = phone ? phone.replace(/[^0-9]/g, '') : '';
        // 🏢 [멀티테넌트 수정] 클라이언트가 전달한 clubId를 최우선 사용하고, 없을 때만 socket.clubId 참조 ('unjeong' 임의 폴백 제거)
        const currentClubId = (clubId && String(clubId).trim()) || socket.clubId;

        if (!currentClubId) {
            return callback({ success: false, message: '접속 구장 정보를 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요.' });
        }

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
                return callback({ success: false, message: '해당 클럽에 등록된 정회원 정보가 없습니다.' });
            }

            // 🏷️ [회원 상태 관리] 병가·휴면·탈퇴 회원은 정회원 로그인 차단 후 복귀/일일회원 팝업 안내
            const memberStatus = (row.member_status && String(row.member_status).trim()) || 'active';
            if (memberStatus !== 'active') {
                return db.get(
                    `SELECT id FROM member_status_requests
                     WHERE member_id = ? AND club_id = ? AND requested_status = 'active' AND request_status = 'pending'
                     LIMIT 1`,
                    [row.id, currentClubId],
                    (reqErr, pendingReq) => {
                        const labelMap = { sick: '병가', dormant: '휴면', withdrawn: '탈퇴' };
                        const label = labelMap[memberStatus] || memberStatus;
                        const endInfo = row.status_end_date ? ` (예정일: ~${row.status_end_date})` : '';
                        const msg = memberStatus === 'withdrawn'
                            ? '탈퇴 처리된 회원입니다. 간편 재입회 신청 또는 일일회원으로 입장해 주세요.'
                            : `현재 [${label}] 상태인 회원입니다.${endInfo} 복귀 신청 또는 일일회원으로 입장해 주세요.`;
                        return callback({
                            success: false,
                            statusBlocked: true,
                            memberStatus,
                            hasPendingReturn: Boolean(pendingReq),
                            memberInfo: {
                                id: row.id,
                                name: row.name,
                                phone: row.phone,
                                clubId: currentClubId,
                                statusEndDate: row.status_end_date || '',
                                statusUpdatedAt: row.status_updated_at || '',
                                statusMemo: row.status_memo || ''
                            },
                            message: msg
                        });
                    }
                );
            }

            // 🏢 [멀티테넌트 수정] 로그인 성공 시 현재 소켓의 구장 소속을 실제 로그인 구장으로 확정
            if (socket.clubId && socket.clubId !== currentClubId) {
                socket.leave(`club_${socket.clubId}`);
            }
            socket.clubId = currentClubId;
            socket.join(`club_${currentClubId}`);

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

    // 🔑 일일회원 로그인 처리 소켓 이벤트 (입력값 서버 검증, DB 자동 저장 및 재방문 연동)
    socket.on('loginGuest', (payload = {}, callback) => {
        const reply = (res) => {
            if (typeof callback === 'function') callback(res);
        };

        const { name, phone, payCode, gender, ageGroup, grade, clubId } = payload || {};

        // 1) 입력값 정제 및 서버 측 최종 유효성 검증
        const cleanName = String(name || '')
            .replace(/\([^)]*\)/g, '')
            .replace(/[^가-힣a-zA-Z]/g, '')
            .trim();
        const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
        const cleanPayCode = String(payCode || '').replace(/[^0-9]/g, '');

        if (cleanName.length < 2) {
            return reply({ success: false, message: '이름은 한글 또는 영문 2자 이상 정확히 입력해 주세요.' });
        }
        if (cleanPhone.length < 10 || cleanPhone.length > 11) {
            return reply({ success: false, message: '전화번호는 숫자 10~11자리로 정확히 입력해 주세요.' });
        }
        if (!/^\d{6}$/.test(cleanPayCode)) {
            return reply({ success: false, message: '유효한 결제승인번호 숫자 6자리를 입력해 주세요.' });
        }

        // TODO: 추후 키오스크/PG 결제승인번호 API 연동 시 cleanPayCode 검증 로직 추가 위치

        // 🏢 [멀티테넌트] 클라이언트가 전달한 clubId를 최우선 사용하고, 없을 때만 socket.clubId 참조
        const currentClubId = (clubId && String(clubId).trim()) || socket.clubId;
        if (!currentClubId) {
            return reply({ success: false, message: '접속 구장 정보를 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요.' });
        }

        // 선택 항목 화이트리스트 정제
        const cleanGender = ['남', '여'].includes(gender) ? gender : '-';
        const cleanAgeGroup = ['10대', '20대', '30대', '40대', '50대', '60대', '70대'].includes(ageGroup) ? ageGroup : '-';

        // 🎯 [급수 표기 정리] '(일)' 접미사 없이 순수 급수만 깔끔하게 생성
        let formattedGrade = '일일';
        if (grade) {
            const rawGrade = String(grade).trim();
            if (rawGrade === '초심' || rawGrade === '일일' || rawGrade.endsWith('조')) {
                formattedGrade = rawGrade;
            } else if (rawGrade !== '일반') {
                formattedGrade = `${rawGrade}조`;
            }
        }

        // 한국 시간(KST) 기준 방문 일시 생성
        const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
        const nowStr = nowKr.getFullYear() + '-' +
            String(nowKr.getMonth() + 1).padStart(2, '0') + '-' +
            String(nowKr.getDate()).padStart(2, '0') + ' ' +
            String(nowKr.getHours()).padStart(2, '0') + ':' +
            String(nowKr.getMinutes()).padStart(2, '0') + ':' +
            String(nowKr.getSeconds()).padStart(2, '0');

        // 1) 기존 daily_guests 테이블에 오늘 방문 기록 추가 (관리자 호환용)
        db.run(
            `INSERT OR REPLACE INTO daily_guests (id, club_id, type, name, phone, gender, ageGroup, grade, visitedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [`guest_${Date.now()}`, currentClubId, '일일회원', cleanName, cleanPhone, cleanGender, cleanAgeGroup, formattedGrade, nowStr],
            () => {}
        );

        // 2) 누적 전적 관리용 guest_members 테이블에 저장 (재방문 시 방문횟수 +1 및 고정 ID 유지)
        const upsertSql = `
            INSERT INTO guest_members (club_id, name, phone, gender, age_group, grade, visit_count, last_visit)
            VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(club_id, name, phone) DO UPDATE SET
                gender = excluded.gender,
                age_group = excluded.age_group,
                grade = excluded.grade,
                visit_count = guest_members.visit_count + 1,
                last_visit = CURRENT_TIMESTAMP
        `;

        db.run(upsertSql, [currentClubId, cleanName, cleanPhone, cleanGender, cleanAgeGroup, formattedGrade], function(err) {
            if (err) {
                console.error('⚠️ 일일회원 DB 저장 오류:', err.message);
            }

            db.get(
                `SELECT id, visit_count FROM guest_members WHERE club_id = ? AND name = ? AND phone = ?`,
                [currentClubId, cleanName, cleanPhone],
                (selectErr, row) => {
                    // 🏢 [멀티테넌트] 일일회원 입장 성공 시 현재 소켓의 구장 소속 확정
                    if (socket.clubId && socket.clubId !== currentClubId) {
                        socket.leave(`club_${socket.clubId}`);
                    }
                    socket.clubId = currentClubId;
                    socket.join(`club_${currentClubId}`);

                    const guestId = (row && row.id) ? `guest_${row.id}` : `guest_${Date.now()}`;

                    const user = {
                        id: guestId,
                        clubId: currentClubId,
                        username: guestId,
                        name: cleanName,
                        rawName: cleanName,
                        displayName: cleanName,
                        gender: cleanGender,
                        ageGroup: cleanAgeGroup,
                        grade: formattedGrade,
                        level: formattedGrade,
                        isGuest: true,
                        phone: cleanPhone,
                        visitCount: row ? row.visit_count : 1
                    };

                    console.log(`👤 [일일회원 입장/DB저장] 구장:${currentClubId}, 이름:${cleanName}, ID:${guestId}, 누적방문:${user.visitCount}회`);
                    reply({ success: true, user });
                }
            );
        });
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

            // 📡 3. 해당 클럽 방(club_${clubId})에 접속 중인 사용자들에게 Wi-Fi 인증 상태·토글 설정·타이머 즉시 동기화
            const roomSockets = io.sockets.adapter.rooms.get(`club_${clubId}`);
            const restrictionOn = club.config.useWifiRestriction !== false;
            if (roomSockets) {
                roomSockets.forEach((sId) => {
                    const s = io.sockets.sockets.get(sId);
                    if (s) {
                        const isGym = (typeof isGymWifiUser === 'function') ? isGymWifiUser(s, clubId) : true;
                        const currentIp = s.verifiedClientIp || (typeof getClientIp === 'function' ? getClientIp(s) : '');
                        s.inGym = isGym;
                        s.isGymWifi = isGym;

                        // ⏱️ 로그인 회원은 토글 변경에 맞춰 유예·만료 타이머 상태도 즉시 반영
                        if (s.finalName && s.finalName !== '0100' && typeof gymSessionManager !== 'undefined') {
                            if (isGym) {
                                s.inGracePeriod = false;
                                gymSessionManager.handleConnect(s, s.finalName, clubId);
                            } else {
                                gymSessionManager.handleDisconnect(s, s.finalName, clubId);
                            }
                        }

                        s.emit('wifiStatus', {
                            clubId: clubId,
                            isGymWifi: isGym,
                            clientIp: currentIp,
                            useWifiRestriction: restrictionOn
                        });
                    }
                });
            }
            if (typeof broadcastOnlineCount === 'function') {
                broadcastOnlineCount(clubId);
            }
        } catch (err) {
            console.error('Wi-Fi 설정 변경 에러:', err);
        }
    });

    socket.on('verifyAdminPassword', (payload, callback) => {
        if (typeof callback !== 'function') return;

        // 🏢 [멀티테넌트 수정] 문자열 또는 { password, clubId } 객체 모두 호환 처리
        const inputPw = (payload && typeof payload === 'object')
            ? String(payload.password || '')
            : String(payload || '');

        const targetClubId = (payload && typeof payload === 'object' && payload.clubId)
            || socket.clubId
            || (typeof clientClubId !== 'undefined' ? clientClubId : null)
            || 'unjeong';

        // 🏢 [멀티테넌트 수정] 해당 구장(targetClubId) 전용 config의 ADMIN_PASSWORD 조회
        const targetClub = (typeof clubs !== 'undefined' && clubs) ? clubs[targetClubId] : null;
        const clubPassword = (targetClub && targetClub.config && targetClub.config.ADMIN_PASSWORD)
            || (typeof config !== 'undefined' && config.ADMIN_PASSWORD)
            || '1234';

        if (inputPw === String(clubPassword)) {
            callback({ success: true, clubId: targetClubId });
        } else {
            callback({ success: false });
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

                // 💡 전달된 필드만 안전하게 개별 갱신
                if (newConfig.ENTRY_TIMEOUT_SEC !== undefined) targetConfig.ENTRY_TIMEOUT_SEC = newConfig.ENTRY_TIMEOUT_SEC;
                if (newConfig.NANTA_COURT_LIMIT_SEC !== undefined) targetConfig.NANTA_COURT_LIMIT_SEC = newConfig.NANTA_COURT_LIMIT_SEC;
                if (newConfig.ADMIN_PASSWORD !== undefined && newConfig.ADMIN_PASSWORD.trim() !== '') {
                    targetConfig.ADMIN_PASSWORD = newConfig.ADMIN_PASSWORD;
                }

                // ⏱️ 유예 시간 및 세션 만료 시간 관리자 설정 갱신 (숫자형 강제 변환)
                if (newConfig.queueGraceMinutes !== undefined) {
                    targetConfig.queueGraceMinutes = Number(newConfig.queueGraceMinutes);
                }
                if (newConfig.sessionExpireMinutes !== undefined) {
                    targetConfig.sessionExpireMinutes = Number(newConfig.sessionExpireMinutes);
                }

                // 💡 [추가] 연속 게임 제한 시간 (분 단위) 관리자 설정 갱신
                if (newConfig.continuousGameLimitMinutes !== undefined) {
                    targetConfig.continuousGameLimitMinutes = Number(newConfig.continuousGameLimitMinutes);
                }

                // 🏟️ 코트 설정(개수, 코트 목록) 갱신
                if (newConfig.courts !== undefined) {
                    clubs[clubId].courts = newConfig.courts;
                }
                if (newConfig.courtCount !== undefined) {
                    clubs[clubId].courtCount = Number(newConfig.courtCount);
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

                console.log(`📌 [클럽별 설정 안전 갱신] 클럽: ${clubId} (유예: ${targetConfig.queueGraceMinutes}분, 만료: ${targetConfig.sessionExpireMinutes}분)`);

                // 💾 1. clubs-data.json 디스크 파일 영구 저장 (서버 재시작 대비)
                if (typeof saveClubsData === 'function') {
                    saveClubsData();
                }
                if (typeof saveConfigToFile === 'function') {
                    saveConfigToFile();
                }

                // 📡 2. 클라이언트 실시간 동기화 (전체 룸에 새 설정 전송)
                if (typeof io !== 'undefined') {
                    io.to(`club_${clubId}`).to(`tv-room_${clubId}`).to(`tv-room-${clubId}`).emit('syncConfig', targetConfig);
                }
                if (typeof broadcastState === 'function') {
                    broadcastState(clubId);
                }
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
        const currentClubId = socket.clubId || 'unjeong';
        const club = getClub(currentClubId);

        // 🛡️ 공통 Wi-Fi 검증
        if (!checkWifiGuard('방을 개설')) return;

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
        const currentClubId = socket.clubId || 'unjeong';
        const club = getClub(currentClubId);

        // 🛡️ 공통 Wi-Fi 검증
        if (!checkWifiGuard('방을 개설')) return;

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
        // 🛡️ 공통 Wi-Fi 검증
        if (!checkWifiGuard('대기 방에 입장')) return;

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
        const slotIdx = queue ? queue.findIndex(s => s.id === slotId) : -1;
        const slot = slotIdx !== -1 ? queue[slotIdx] : null;
        
        if (slot && index >= 0 && index < slot.players.length) {
            slot.players[index] = name;
            if (!slot.penaltyApplied) slot.penaltyApplied = [false, false, false, false];

            // 💡 [추가] 게임 대기방 참여 시 '연속 게임 제한 시간' 이내인지 검사하여 1순위 뒤로 이동
            if (type === 'game' && cleanName && club.lastFinishedTimes && club.lastFinishedTimes[cleanName]) {
                const limitMinutes = (club.config && club.config.continuousGameLimitMinutes !== undefined)
                    ? Number(club.config.continuousGameLimitMinutes)
                    : 5;
                const limitMs = limitMinutes * 60 * 1000;
                const elapsedMs = Date.now() - club.lastFinishedTimes[cleanName];

                if (limitMs > 0 && elapsedMs < limitMs) {
                    // 이 자리(index)의 회원으로 인해 페널티가 적용되었음을 기록
                    slot.penaltyApplied[index] = true;

                    // 현재 순위가 맨 마지막이 아니라면 1순위 뒤로 이동
                    if (slotIdx < queue.length - 1) {
                        const [movedSlot] = queue.splice(slotIdx, 1);
                        queue.splice(slotIdx + 1, 0, movedSlot);
                    }

                    if (typeof addNotification === 'function') {
                        addNotification(`⏳ [순위 조정] ${cleanName} 님이 연속 게임 제한 시간(${limitMinutes}분) 내 참여하여 대기방이 1순위 뒤로 이동했습니다.`, currentClubId);
                    }
                } else {
                    slot.penaltyApplied[index] = false;
                }
            } else {
                slot.penaltyApplied[index] = false;
            }

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
            penaltyApplied: [false, false, false, false], // 💡 자리별 페널티 꼬리표 초기화
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
        const currentClubId = socket.clubId || 'unjeong';
        const club = getClub(currentClubId);
        const queue = type === 'game' ? club.gameQueue : club.nantaQueue;
        const slotIdx = queue.findIndex(s => s.id === slotId);

        if (slotIdx !== -1) {
            const slot = queue[slotIdx];
            const exitingPlayer = slot.players[index] || '';
            const cleanName = exitingPlayer.split('/')[0].trim();

            // 💡 퇴장하는 자리(index)에 페널티 표시가 있었는지 확인 후 초기화
            const hadPenalty = Boolean(slot.penaltyApplied && slot.penaltyApplied[index]);
            if (slot.penaltyApplied) {
                slot.penaltyApplied[index] = false;
            }

            slot.players[index] = '';
            
            // 해당 자리의 userId도 함께 정리 (대기열 중복 방지 해제)
            if (slot.userIds && slot.userIds[index]) {
                slot.userIds[index] = null;
            }
            
            if (getValidPlayers(slot.players).length === 0) {
                queue.splice(slotIdx, 1);
            } else if (type === 'game' && hadPenalty && slotIdx > 0) {
                // 💡 [추가] 페널티로 순위가 밀리게 했던 회원이 퇴장하면 대기방을 다시 1순위 앞으로 복구
                const [restoredSlot] = queue.splice(slotIdx, 1);
                queue.splice(slotIdx - 1, 0, restoredSlot);

                if (typeof addNotification === 'function') {
                    addNotification(`↩️ [순위 복구] ${cleanName} 님의 퇴장으로 대기방 순위가 1순위 앞으로 복구되었습니다.`, currentClubId);
                }
            }

            // ✅ 해당 클럽에만 상태 갱신 전송
            broadcastState(currentClubId);
        }
    });

    // 🏟️ [코트 입장 처리] (멀티 테넌트 + 자동 팀 밸런싱 반영)
    socket.on('enterCourtFromSlot', async ({ type, slotId }) => {
        const currentClubId = socket.clubId || 'unjeong';
        const lockKey = `${currentClubId}:${type}:${slotId}`;
        if (enteringCourtLocks.has(lockKey)) return;
        enteringCourtLocks.add(lockKey);

        try {
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

                // ⚖️ 자동 팀 밸런싱 계산 (오류 시에도 코트 입장은 정상 진행)
                let balancedTeams = null;
                try {
                    balancedTeams = await buildBalancedTeamsForCourt(currentClubId, validPlayers);
                } catch (balanceErr) {
                    console.error('팀 밸런싱 계산 에러 (기본 순서로 입장):', balanceErr);
                }

                // await 이후 최신 슬롯/코트 상태 재확인
                const latestSlotIdx = queue.findIndex(s => s.id === slotId);
                if (latestSlotIdx === -1 || !emptyCourt.isEmpty) return;

                emptyCourt.isEmpty = false;
                emptyCourt.teams = balancedTeams;
                emptyCourt.players = balancedTeams
                    ? [...balancedTeams.teamA, ...balancedTeams.teamB].join(', ')
                    : validPlayers.join(', ');
                emptyCourt.startTime = Date.now();
                emptyCourt.remainingSeconds = 0;

                queue.splice(latestSlotIdx, 1);

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
                    const mixedTag = balancedTeams && balancedTeams.isMixedDoubles ? ' (혼복 자동편성)' : '';
                    addNotification(`🏟️ [코트 입장] 게임 코트 (${emptyCourt.id}번)에 팀이 입장했습니다.${mixedTag}`, currentClubId);
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
        } finally {
            enteringCourtLocks.delete(lockKey);
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

    // 🏁 [게임 코트 종료] (코트 즉시 비우기 + 스코어 입력 모달 호출)
    socket.on('endGameCourt', ({ courtId }) => {
        try {
            const currentClubId = socket.clubId || 'unjeong';
            const club = clubs[currentClubId] || clubs['unjeong'];
            const clubCourts = club.courtsData || [];

            const court = clubCourts.find(c => c.id === courtId && c.type === 'game');
            if (court) {
                // 💡 코트를 비우기 전에 방금 게임한 선수 명단 및 팀 정보 백업 (스코어 입력창 전달용)
                const finishedPlayersRaw = court.players || '';
                const finishedTeams = court.teams || null;
                const finishedPlayersList = finishedPlayersRaw
                    .split(',')
                    .map(p => p.split('/')[0].trim())
                    .filter(Boolean);

                // 방금 게임을 마친 선수들의 종료 시각 기록
                if (finishedPlayersRaw) {
                    if (!club.lastFinishedTimes) club.lastFinishedTimes = {};
                    const now = Date.now();
                    finishedPlayersList.forEach(cleanName => {
                        club.lastFinishedTimes[cleanName] = now;
                    });
                }

                // ⚡ [최우선 처리] 코트 즉시 비우기 (다음 대기팀 즉시 배정 가능)
                court.isEmpty = true;
                court.players = '';
                court.teams = null;
                court.startTime = null;
                court.remainingSeconds = 0;

                if (typeof addNotification === 'function') {
                    addNotification(`🏁 [게임 종료] ${court.id}번 코트 게임이 종료되었습니다.`, currentClubId);
                }
                if (typeof broadcastState === 'function') {
                    broadcastState(currentClubId);
                }

                // 🎯 버튼을 누른 기기 화면으로 스코어 입력창 오픈 신호 전송
                if (finishedPlayersList.length >= 2) {
                    socket.emit('openScoreModal', {
                        clubId: currentClubId,
                        courtId: court.id,
                        actionType: 'end',
                        players: finishedPlayersList,
                        rawPlayers: finishedPlayersRaw.split(',').map(p => p.trim()).filter(Boolean),
                        teams: finishedTeams
                    });
                }
            }
        } catch (err) {
            console.error('게임 종료 처리 에러:', err);
        }
    });

    // 🔄 [한게임 더 연장] (코트 즉시 비우기 + 대기열 재등록 + 스코어 입력 모달 호출)
    socket.on('extendGameCourt', ({ courtId }) => {
        try {
            const currentClubId = socket.clubId || 'unjeong';
            const club = clubs[currentClubId] || clubs['unjeong'];
            const clubCourts = club.courtsData || [];

            const court = clubCourts.find(c => c.id === courtId && c.type === 'game');
            if (!court || court.isEmpty || !court.players) return;

            const playersArr = court.players.split(',').map(p => p.trim()).filter(Boolean);
            if (playersArr.length === 0) return;

            const finishedTeams = court.teams || null;
            const finishedPlayersList = playersArr.map(p => p.split('/')[0].trim()).filter(Boolean);

            // 한게임 더 클릭 시에도 방금 게임을 마친 선수들의 종료 시각 기록
            if (!club.lastFinishedTimes) club.lastFinishedTimes = {};
            const now = Date.now();
            finishedPlayersList.forEach(cleanName => {
                club.lastFinishedTimes[cleanName] = now;
            });

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
                penaltyApplied: [false, false, false, false],
                createdAt: Date.now(),
                fullAt: null,
                remainingSeconds: null
            };

            if (!club.gameQueue) club.gameQueue = [];
            club.gameQueue.push(newSlot);

            // ⚡ [최우선 처리] 코트 즉시 비우기
            court.isEmpty = true;
            court.players = '';
            court.teams = null;
            court.startTime = null;
            court.remainingSeconds = 0;

            if (typeof addNotification === 'function') {
                addNotification(`🔄 [한게임 더] ${court.id}번 코트 팀이 대기열 최후순위로 재등록되었습니다.`, currentClubId);
            }
            if (typeof broadcastState === 'function') {
                broadcastState(currentClubId);
            }

            // 🎯 버튼을 누른 기기 화면으로 스코어 입력창 오픈 신호 전송
            if (finishedPlayersList.length >= 2) {
                socket.emit('openScoreModal', {
                    clubId: currentClubId,
                    courtId: court.id,
                    actionType: 'extend',
                    players: finishedPlayersList,
                    rawPlayers: playersArr,
                    teams: finishedTeams
                });
            }
        } catch (err) {
            console.error('한게임 더 처리 에러:', err);
        }
    });

    // 💾 [스코어 및 전적 DB 저장] 화면에서 점수 입력 후 '저장' 클릭 시 실행 (구장별 완전 격리 및 중복 차단)
    if (!global._recentScoreLocks) global._recentScoreLocks = new Map();

    socket.on('saveMatchScore', (data, callback) => {
        try {
            const currentClubId = String((data && data.clubId) || socket.clubId || 'unjeong').trim();
            const courtNumber = parseInt(data && data.courtId, 10) || 0;
            const rawMatchType = (data && data.matchType) ? String(data.matchType).trim() : '자유';
            const matchType = (rawMatchType === '자유복식') ? '자유' : rawMatchType;
            const scoreA = parseInt(data && data.scoreA, 10) || 0;
            const scoreB = parseInt(data && data.scoreB, 10) || 0;

            const normalizeName = (n) => String(n || '').replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
            const teamA = (Array.isArray(data && data.teamA) ? data.teamA : []).map(normalizeName).filter(Boolean);
            const teamB = (Array.isArray(data && data.teamB) ? data.teamB : []).map(normalizeName).filter(Boolean);
            const saverName = normalizeName(data && data.saverName) || '다른 플레이어';

            if (teamA.length === 0 || teamB.length === 0) {
                if (callback) callback({ success: false, message: 'A팀과 B팀 선수를 선택해 주세요.' });
                return;
            }

            // 🔒 [중복 입력 방지] 같은 구장의 같은 참가자 4명이 1분 이내에 중복 저장 시 먼저 저장한 회원명 안내
            const playersKey = [...teamA, ...teamB].sort().join('|');
            const lockKey = `${currentClubId}__${playersKey}`;
            const nowMs = Date.now();
            const DUPLICATE_LIMIT_MS = 60 * 1000;

            // 만료된 잠금 메모리 정리
            for (const [k, v] of global._recentScoreLocks.entries()) {
                if ((nowMs - v.time) >= DUPLICATE_LIMIT_MS) {
                    global._recentScoreLocks.delete(k);
                }
            }

            const prevLock = global._recentScoreLocks.get(lockKey);
            if (prevLock && (nowMs - prevLock.time) < DUPLICATE_LIMIT_MS) {
                if (callback) {
                    callback({
                        success: false,
                        message: `⚠️ 이미 [${prevLock.saverName}] 회원이 이 경기의 스코어(${prevLock.scoreA} : ${prevLock.scoreB})를 먼저 등록했습니다.\n(먼저 저장된 기록만 반영됩니다.)`
                    });
                }
                return;
            }

            global._recentScoreLocks.set(lockKey, { time: nowMs, courtNumber, saverName, scoreA, scoreB });

            let winnerTeam = 'DRAW';
            if (scoreA > scoreB) winnerTeam = 'A';
            else if (scoreB > scoreA) winnerTeam = 'B';

            // 한국 시간(KST) 기준 현재 일시 기록
            const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
            const playedAtStr = nowKr.getFullYear() + '-' +
                String(nowKr.getMonth() + 1).padStart(2, '0') + '-' +
                String(nowKr.getDate()).padStart(2, '0') + ' ' +
                String(nowKr.getHours()).padStart(2, '0') + ':' +
                String(nowKr.getMinutes()).padStart(2, '0') + ':' +
                String(nowKr.getSeconds()).padStart(2, '0');

            const insertSql = `
                INSERT INTO match_records 
                (club_id, court_number, match_type, team_a_p1, team_a_p2, team_b_p1, team_b_p2, score_a, score_b, winner_team, played_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            db.run(
                insertSql,
                [
                    currentClubId,
                    courtNumber,
                    matchType,
                    teamA[0] || '',
                    teamA[1] || '',
                    teamB[0] || '',
                    teamB[1] || '',
                    scoreA,
                    scoreB,
                    winnerTeam,
                    playedAtStr
                ],
                function(err) {
                    if (err) {
                        global._recentScoreLocks.delete(lockKey);
                        console.error('❌ 경기 전적 저장 실패:', err.message);
                        if (callback) callback({ success: false, message: '전적 저장 중 오류가 발생했습니다.' });
                    } else {
                        console.log(`🏆 [전적 저장 완료] 구장:${currentClubId}, 저장자:${saverName}, 종목:${matchType}, ${teamA.join(',')} (${scoreA}) vs ${teamB.join(',')} (${scoreB})`);
                        const noticeMsg = `🏆 [전적 기록] ${courtNumber}번 코트 (${matchType}) ${teamA.join('·')} [${scoreA} : ${scoreB}] ${teamB.join('·')}`;
                        if (typeof addNotificationForClub === 'function') {
                            addNotificationForClub(currentClubId, noticeMsg);
                        } else if (typeof addNotification === 'function') {
                            addNotification(noticeMsg, currentClubId);
                        }

                        // 같은 구장 룸(club_${currentClubId})의 다른 플레이어들에게만 저장 완료 알림 전송
                        socket.to(`club_${currentClubId}`).emit('matchScoreSavedNotice', {
                            clubId: currentClubId,
                            courtId: courtNumber,
                            playersKey: playersKey,
                            saverName: saverName,
                            scoreA: scoreA,
                            scoreB: scoreB
                        });

                        if (callback) callback({ success: true, recordId: this.lastID });
                    }
                }
            );
        } catch (err) {
            console.error('saveMatchScore 처리 에러:', err);
            if (callback) callback({ success: false, message: '서버 오류가 발생했습니다.' });
        }
    });

    // =========================================================================
    // 📊 [최종] 구장별 전적 통계 산출 및 다중 조건 이벤트 타이틀 관리
    // =========================================================================

    // DB 테이블(custom_titles)에 포상 상품 컬럼(prize_info) 자동 추가 안전장치
   const ensureCustomTitlesSchema = (done) => {
        const createSql = `
            CREATE TABLE IF NOT EXISTS custom_titles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                club_id TEXT DEFAULT 'unjeong',
                title_name TEXT NOT NULL,
                description TEXT DEFAULT '',
                prize_info TEXT DEFAULT '', -- 🎁 포상 상품 컬럼 추가
                target_match_type TEXT DEFAULT 'ALL',
                min_games INTEGER DEFAULT 3,
                metric_type TEXT DEFAULT 'most_wins',
                badge_theme TEXT DEFAULT 'gold',
                manual_winner TEXT DEFAULT NULL,
                status TEXT DEFAULT 'pending',
                condition_json TEXT DEFAULT NULL,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;
        db.run(createSql, () => {
            const alterQueries = [
                `ALTER TABLE custom_titles ADD COLUMN description TEXT DEFAULT ''`,
                `ALTER TABLE custom_titles ADD COLUMN prize_info TEXT DEFAULT ''`, // 기존 테이블 마이그레이션 대비
                `ALTER TABLE custom_titles ADD COLUMN manual_winner TEXT DEFAULT NULL`,
                `ALTER TABLE custom_titles ADD COLUMN status TEXT DEFAULT 'pending'`,
                `ALTER TABLE custom_titles ADD COLUMN condition_json TEXT DEFAULT NULL`
            ];
            let idx = 0;
            const runNext = () => {
                if (idx >= alterQueries.length) return done && done();
                db.run(alterQueries[idx++], () => runNext());
            };
            runNext();
        });
    };

    // 💡 다중 조건(7대 축: 개인/파트너, 종목, 성별, 급수조합, 연령대조합, 최소경기수, 9대 지표) 후보 필터링 엔진
    const evaluateEventTitleCandidates = (cond, regularPlayers, regularPairs) => {
        const scope = cond.scope || 'player'; // 'player' (개인) | 'pair' (파트너)
        const targetType = cond.targetMatchType || 'ALL';
        const gradeFilter = cond.gradeFilter || 'ALL';
        const ageFilter = cond.ageFilter || 'ALL';
        const genderFilter = cond.genderFilter || 'ALL';
        const minG = Math.max(1, Number(cond.minGames) || 1);
        const metric = cond.metricType || 'most_wins';

        const getGradeRank = (g) => {
            const map = { 'S조': 6, 'A조': 5, 'B조': 4, 'C조': 3, 'D조': 2, '초심': 1 };
            return map[g] || 0;
        };

        let list = [];

        if (scope === 'pair') {
            // 1) 파트너(복식 2인 페어) 부문 필터링
            list = regularPairs.filter(pr => {
                if (genderFilter === '남' && (pr.p1Gender !== '남' || pr.p2Gender !== '남')) return false;
                if (genderFilter === '여' && (pr.p1Gender !== '여' || pr.p2Gender !== '여')) return false;

                const r1 = getGradeRank(pr.p1Grade);
                const r2 = getGradeRank(pr.p2Grade);
                if (gradeFilter === 'PAIR_SAME') {
                    if (!pr.p1Grade || pr.p1Grade !== pr.p2Grade) return false;
                } else if (gradeFilter === 'PAIR_MENTOR') {
                    // 멘토(A·B·S조: 4이상) + 멘티(C·D·초심: 1~3)
                    const isMentorMentee = (r1 >= 4 && r2 >= 1 && r2 <= 3) || (r2 >= 4 && r1 >= 1 && r1 <= 3);
                    if (!isMentorMentee) return false;
                } else if (gradeFilter === 'PAIR_LOW') {
                    // 두 명 모두 초심·D조 (1~2)
                    if (r1 < 1 || r1 > 2 || r2 < 1 || r2 > 2) return false;
                } else if (gradeFilter === 'PAIR_MID_LOW') {
                    // 두 명 모두 초심·D·C조 (1~3)
                    if (r1 < 1 || r1 > 3 || r2 < 1 || r2 > 3) return false;
                } else if (['초심', 'D조', 'C조', 'B조', 'A조'].includes(gradeFilter)) {
                    if (pr.p1Grade !== gradeFilter && pr.p2Grade !== gradeFilter) return false;
                }

                const a1 = parseInt(pr.p1Age, 10) || 0;
                const a2 = parseInt(pr.p2Age, 10) || 0;
                if (ageFilter === 'PAIR_DIFF_AGE') {
                    if (!a1 || !a2 || a1 === a2) return false;
                } else if (ageFilter === 'PAIR_GAP_20') {
                    if (!a1 || !a2 || Math.abs(a1 - a2) < 20) return false;
                } else if (ageFilter === 'PAIR_SAME_AGE') {
                    if (!a1 || !a2 || a1 !== a2) return false;
                } else if (['10', '20', '30', '40', '50', '60'].includes(ageFilter)) {
                    const targetAge = parseInt(ageFilter, 10);
                    if (targetAge === 60) {
                        if (a1 < 60 && a2 < 60) return false;
                    } else {
                        if (a1 !== targetAge && a2 !== targetAge) return false;
                    }
                }
                return true;
            }).map(pr => {
                const stat = (targetType !== 'ALL' && pr.byType && pr.byType[targetType]) ? pr.byType[targetType] : pr;
                const games = stat.games || 0;
                const wins = stat.wins || 0;
                const losses = typeof stat.losses === 'number' ? stat.losses : Math.max(0, games - wins);
                const winRate = games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
                const pointDiff = (stat.pointsFor || 0) - (stat.pointsAgainst || 0);

                // 파트너 2인 이름 및 급수 안전 조합 (undefined 방지)
                const p1Name = String(pr.player1 || pr.p1Name || (pr.players && pr.players[0]) || '').trim();
                const p2Name = String(pr.player2 || pr.p2Name || (pr.players && pr.players[1]) || '').trim();
                const p1Formatted = pr.p1Formatted || (pr.p1Grade ? `${p1Name}(${pr.p1Grade})` : p1Name);
                const p2Formatted = pr.p2Formatted || (pr.p2Grade ? `${p2Name}(${pr.p2Grade})` : p2Name);

                return {
                    ...pr,
                    displayName: `${p1Formatted} & ${p2Formatted}`,
                    evalGames: games,
                    evalWins: wins,
                    evalLosses: losses,
                    evalWinRate: winRate,
                    evalClutchWins: stat.clutchWins || 0,
                    evalBigWins: stat.bigWins || 0,
                    evalMaxStreak: stat.maxStreak || 0,
                    evalPointDiff: pointDiff
                };
            });
        } else {
            // 2) 개인 부문 필터링
            list = regularPlayers.filter(p => {
                if (genderFilter !== 'ALL' && p.gender !== genderFilter) return false;

                const g = p.grade || '';
                if (gradeFilter === 'LOW_CD') {
                    if (g !== '초심' && g !== 'D조') return false;
                } else if (gradeFilter === 'LOW_CDC') {
                    if (g !== '초심' && g !== 'D조' && g !== 'C조') return false;
                } else if (['초심', 'D조', 'C조', 'B조', 'A조'].includes(gradeFilter)) {
                    if (g !== gradeFilter) return false;
                }

                const ageNum = parseInt(p.ageGroup, 10) || 0;
                    if (ageFilter === 'YOUTH_2030' && ageNum !== 10 && ageNum !== 20 && ageNum !== 30) return false;
                    if (ageFilter === 'SENIOR_5060' && ageNum < 50) return false;
                    if (['10', '20', '30', '40', '50', '60'].includes(ageFilter)) {
                const tAge = parseInt(ageFilter, 10);
                    if (tAge === 60 ? ageNum < 60 : ageNum !== tAge) return false;
                }
                return true;
            }).map(p => {
                const stat = (targetType !== 'ALL' && p.byType && p.byType[targetType]) ? p.byType[targetType] : p;
                const games = stat.games || 0;
                const wins = stat.wins || 0;
                const losses = stat.losses || 0;
                const winRate = games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
                const pointDiff = (stat.pointsFor || 0) - (stat.pointsAgainst || 0);
                return {
                    ...p,
                    displayName: `${p.name}${p.grade ? '(' + p.grade + ')' : ''}`,
                    evalGames: games,
                    evalWins: wins,
                    evalLosses: losses,
                    evalWinRate: winRate,
                    evalClutchWins: stat.clutchWins || 0,
                    evalBigWins: stat.bigWins || 0,
                    evalMaxStreak: stat.maxStreak || 0,
                    evalPointDiff: pointDiff
                };
            });
        }

        let qualified = list.filter(item => item.evalGames >= minG);

        if (metric === 'most_wins') {
            qualified = qualified.filter(i => i.evalWins > 0)
                .sort((a, b) => (b.evalWins - a.evalWins) || (b.evalWinRate - a.evalWinRate) || (b.evalGames - a.evalGames));
            qualified.forEach(i => { i.metricText = `${i.evalWins}승 (${i.evalWinRate}%)`; });
        } else if (metric === 'win_rate') {
            qualified = qualified.filter(i => i.evalWins > 0)
                .sort((a, b) => (b.evalWinRate - a.evalWinRate) || (b.evalWins - a.evalWins) || (b.evalGames - a.evalGames));
            qualified.forEach(i => { i.metricText = `승률 ${i.evalWinRate}% (${i.evalWins}승 ${i.evalLosses}패)`; });
        } else if (metric === 'win_rate_100') {
            qualified = qualified.filter(i => i.evalWinRate === 100 && i.evalWins > 0)
                .sort((a, b) => (b.evalWins - a.evalWins) || (b.evalPointDiff - a.evalPointDiff));
            qualified.forEach(i => { i.metricText = `${i.evalWins}전 전승 (100%)`; });
        } else if (metric === 'most_games') {
            qualified = qualified.sort((a, b) => (b.evalGames - a.evalGames) || (b.evalWins - a.evalWins));
            qualified.forEach(i => { i.metricText = `${i.evalGames}경기 출전 (${i.evalWins}승)`; });
        } else if (metric === 'clutch_wins') {
            qualified = qualified.filter(i => i.evalClutchWins > 0)
                .sort((a, b) => (b.evalClutchWins - a.evalClutchWins) || (b.evalWins - a.evalWins));
            qualified.forEach(i => { i.metricText = `접전 ${i.evalClutchWins}승 (총 ${i.evalWins}승)`; });
        } else if (metric === 'big_wins') {
            qualified = qualified.filter(i => i.evalBigWins > 0)
                .sort((a, b) => (b.evalBigWins - a.evalBigWins) || (b.evalPointDiff - a.evalPointDiff));
            qualified.forEach(i => { i.metricText = `대승 ${i.evalBigWins}회 (득실 ${i.evalPointDiff >= 0 ? '+' + i.evalPointDiff : i.evalPointDiff})`; });
        } else if (metric === 'max_streak') {
            qualified = qualified.filter(i => i.evalMaxStreak > 0)
                .sort((a, b) => (b.evalMaxStreak - a.evalMaxStreak) || (b.evalWins - a.evalWins));
            qualified.forEach(i => { i.metricText = `최대 ${i.evalMaxStreak}연승`; });
        } else if (metric === 'point_diff') {
            qualified = qualified.sort((a, b) => (b.evalPointDiff - a.evalPointDiff) || (b.evalWins - a.evalWins));
            qualified.forEach(i => { i.metricText = `득실 ${i.evalPointDiff >= 0 ? '+' + i.evalPointDiff : i.evalPointDiff} (${i.evalWins}승)`; });
        } else if (metric === 'most_losses') {
            qualified = qualified.filter(i => i.evalLosses > 0)
                .sort((a, b) => (b.evalLosses - a.evalLosses) || (b.evalGames - a.evalGames));
            qualified.forEach(i => { i.metricText = `${i.evalGames}전 ${i.evalLosses}패 (열정 출전)`; });
        }

        return qualified;
    };

    // 1) 전적 통계 및 타이틀 랭킹 조회 (멀티테넌트 구장별 완전 격리 적용)
    socket.on('getMatchStats', (params, callback) => {
        try {
            const currentClubId = String((params && params.clubId) || socket.clubId || 'unjeong').trim();
            const period = (params && params.period) || 'all'; // 'month', 'last_month', '3months', 'all', 'YYYY-MM'
            const minGamesDefault = parseInt((params && params.minGames) || 10, 10);

            // 기간 필터 조건 생성 (한국 시간 기준)
            const nowKr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
            const curYear = nowKr.getFullYear();
            const curMonthNum = nowKr.getMonth() + 1;
            const curMonth = String(curMonthNum).padStart(2, '0');
            const currentMonthPrefix = `${curYear}-${curMonth}`;

            let dateFilterSql = '';
            let queryParams = [currentClubId, currentClubId];

            if (period === 'month') {
                dateFilterSql = ` AND strftime('%Y-%m', played_at) = ?`;
                queryParams.push(currentMonthPrefix);
            } else if (period === 'last_month') {
                const lastDate = new Date(curYear, curMonthNum - 2, 1);
                const lastYear = lastDate.getFullYear();
                const lastMonth = String(lastDate.getMonth() + 1).padStart(2, '0');
                dateFilterSql = ` AND strftime('%Y-%m', played_at) = ?`;
                queryParams.push(`${lastYear}-${lastMonth}`);
            } else if (period === '3months') {
                const threeMonthsAgo = new Date(curYear, curMonthNum - 3, 1);
                const startYear = threeMonthsAgo.getFullYear();
                const startMonth = String(threeMonthsAgo.getMonth() + 1).padStart(2, '0');
                const startStr = `${startYear}-${startMonth}-01 00:00:00`;
                dateFilterSql = ` AND played_at >= ?`;
                queryParams.push(startStr);
            } else if (/^\d{4}-\d{2}$/.test(period)) {
                dateFilterSql = ` AND strftime('%Y-%m', played_at) = ?`;
                queryParams.push(period);
            } else if (period === 'quarter') {
                const qStartMonth = Math.floor(nowKr.getMonth() / 3) * 3 + 1;
                const qEndMonth = qStartMonth + 2;
                const startStr = `${curYear}-${String(qStartMonth).padStart(2, '0')}-01 00:00:00`;
                const endStr = `${curYear}-${String(qEndMonth).padStart(2, '0')}-31 23:59:59`;
                dateFilterSql = ` AND played_at BETWEEN ? AND ?`;
                queryParams.push(startStr, endStr);
            }

            // 현재 구장(currentClubId) 전용 회원 프로필 통합 조회
            const loadMemberProfiles = (done) => {
                const profileMap = {};
                const normalizeGrade = (g) => {
                    if (!g) return '';
                    let str = String(g).trim().toUpperCase();
                    if (!str || str === '-' || str === '미정' || str === 'NULL' || str === 'UNDEFINED') return '';
                    if (str.includes('초심')) return '초심';
                    const match = str.match(/[SABCD]/);
                    if (match) return match[0] + '조';
                    return str.endsWith('조') ? str : str + '조';
                };

                const normalizeAgeDecade = (rawAge) => {
                    if (!rawAge) return '';
                    const numStr = String(rawAge).replace(/[^0-9]/g, '');
                    if (!numStr) return '';
                    const num = parseInt(numStr, 10);
                    if (num >= 1930 && num <= curYear) {
                        const korAge = curYear - num;
                        return String(Math.floor(korAge / 10) * 10);
                    }
                    if (num >= 10 && num <= 99) {
                        return String(Math.floor(num / 10) * 10);
                    }
                    return '';
                };

                const registerProfile = (row, sourceHint = '') => {
                    if (!row || typeof row !== 'object') return;
                    const name = String(
                        row.name || row.member_name || row.user_name || row.userName || 
                        row.player_name || row.playerName || row.kor_name || ''
                    ).trim().replace(/\([^)]*\)/g, '').trim();
                    if (!name) return;

                    const rawGrade = row.grade || row.level || row.rank || row.tier || row.skill || row.user_grade || row.member_grade || row.class || '';
                    const grade = normalizeGrade(rawGrade);
                    const rawGender = String(row.gender || row.sex || row.user_gender || '').trim();
                    const gender = rawGender.includes('여') || rawGender.toUpperCase() === 'F' ? '여' : (rawGender.includes('남') || rawGender.toUpperCase() === 'M' ? '남' : rawGender);
                    const rawAge = row.age_group || row.ageGroup || row.age || row.decade || row.birth_year || row.birthYear || '';
                    const ageGroup = normalizeAgeDecade(rawAge);

                    const explicitType = String(row.member_type || row.memberType || row.type || row.role || '').trim();
                    const rawStr = JSON.stringify(row).toUpperCase();
                    const isExplicitGuest = row.isGuest === true || row.isDaily === true || row.guest === true || row.isRegular === false ||
                        explicitType.includes('일일') || explicitType.includes('게스트') || explicitType.toUpperCase().includes('GUEST') ||
                        rawStr.includes('일일') || rawStr.includes('게스트') || rawStr.includes('GUEST') || rawStr.includes('비회원') ||
                        sourceHint === 'GUEST';

                    const isExplicitRegular = explicitType === '정회원' || explicitType.toUpperCase() === 'REGULAR' || sourceHint === 'REGULAR';

                    const prev = profileMap[name] || {};
                    let finalType = prev.memberType || '';

                    // 한 번이라도 일일회원으로 확인되면 다른 데이터 때문에 정회원으로 바뀌지 않게 고정
                    if (isExplicitGuest || prev.isLockedGuest) {
                        finalType = '일일회원';
                    } else if (isExplicitRegular || prev.isLockedRegular) {
                        finalType = '정회원';
                    } else if (!finalType) {
                        finalType = (sourceHint === 'TRANSIENT') ? '일일회원' : '정회원';
                    }

                    profileMap[name] = {
                        grade: grade || prev.grade || '',
                        gender: gender || prev.gender || '',
                        ageGroup: ageGroup || prev.ageGroup || '',
                        memberType: finalType,
                        isLockedGuest: Boolean(isExplicitGuest || prev.isLockedGuest),
                        isLockedRegular: Boolean(!isExplicitGuest && !prev.isLockedGuest && (isExplicitRegular || prev.isLockedRegular))
                    };
                };

                try {
                    const fs = require('fs');
                    const path = require('path');
                    const clubsJsonPath = (typeof CLUBS_DATA_FILE !== 'undefined') ? CLUBS_DATA_FILE : path.join(__dirname, 'clubs-data.json');
                    if (fs.existsSync(clubsJsonPath)) {
                        const clubsData = JSON.parse(fs.readFileSync(clubsJsonPath, 'utf8'));
                        const scanObj = (obj, parentKey = '') => {
                            if (!obj || typeof obj !== 'object') return;
                            const pk = String(parentKey).toUpperCase();
                            let hint = '';
                            if (pk.includes('DAILY') || pk.includes('GUEST') || pk.includes('TEMP') || pk.includes('일일') || pk.includes('게스트')) {
                                hint = 'GUEST';
                            } else if (pk.includes('WAIT') || pk.includes('QUEUE') || pk.includes('COURT') || pk.includes('SESSION') || pk.includes('MATCH') || pk.includes('GAME')) {
                                hint = 'TRANSIENT';
                            } else if (pk === 'MEMBERS' || pk === 'REGULAR' || pk === 'REGULARMEMBERS' || pk === 'CLUBMEMBERS') {
                                hint = 'REGULAR';
                            }

                            if (Array.isArray(obj)) {
                                obj.forEach(item => scanObj(item, parentKey));
                            } else {
                                if (obj.name && (obj.grade || obj.level || obj.rank || obj.gender || obj.memberType || obj.type)) {
                                    registerProfile(obj, hint);
                                }
                                Object.entries(obj).forEach(([k, val]) => {
                                    if (typeof val === 'object') scanObj(val, k);
                                });
                            }
                        };

                        // 현재 구장(currentClubId) 데이터만 선별 스캔 (타 구장 데이터 유입 차단)
                        if (clubsData && clubsData.clubs && clubsData.clubs[currentClubId]) {
                            scanObj(clubsData.clubs[currentClubId]);
                        } else if (clubsData && clubsData[currentClubId] && typeof clubsData[currentClubId] === 'object') {
                            scanObj(clubsData[currentClubId]);
                        } else if (currentClubId === 'unjeong') {
                            scanObj(clubsData);
                        }
                    }

                    // 레거시 userDictionary.js는 기본 구장(unjeong)에만 적용
                    if (currentClubId === 'unjeong') {
                        const dictPath = path.join(__dirname, 'userDictionary.js');
                        if (fs.existsSync(dictPath)) {
                            const dictData = require(dictPath);
                            if (typeof dictData === 'object') {
                                Object.entries(dictData).forEach(([k, v]) => {
                                    if (typeof v === 'object') registerProfile({ name: v.name || k, ...v }, 'REGULAR');
                                });
                            }
                        }
                    }
                } catch (e) {}

                db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('match_records', 'custom_titles', 'notices')`, [], (tErr, tables) => {
                    if (tErr || !Array.isArray(tables) || tables.length === 0) {
                        return done(profileMap);
                    }
                    let pending = tables.length;
                    tables.forEach(tbl => {
                        const tableName = tbl.name;
                        const tblUpper = String(tableName).toUpperCase();
                        let hint = '';
                        if (tblUpper.includes('DAILY') || tblUpper.includes('GUEST') || tblUpper.includes('TEMP')) {
                            hint = 'GUEST';
                        } else if (tblUpper.includes('WAIT') || tblUpper.includes('QUEUE') || tblUpper.includes('COURT') || tblUpper.includes('SESSION') || tblUpper.includes('LOG')) {
                            hint = 'TRANSIENT';
                        }
                        db.all(`SELECT * FROM "${tableName}"`, [], (rErr, tRows) => {
                            if (!rErr && Array.isArray(tRows)) {
                                tRows.forEach(row => {
                                    const rowClub = String(row.club_id || row.clubId || '').trim();
                                    const isBelongToClub = (rowClub === currentClubId) || (currentClubId === 'unjeong' && rowClub === '');
                                    if (isBelongToClub) {
                                        registerProfile(row, hint);
                                    }
                                });
                            }
                            pending -= 1;
                            if (pending === 0) return done(profileMap);
                        });
                    });
                });
            };

            // 경기 레코드 배열로부터 개인·파트너 통계를 생성하는 공통 함수 (출석일 및 공식 랭킹 자격 판별 포함)
            const buildStatsFromRows = (matchRows, profileMap) => {
                const playerMap = {};
                const pairMap = {};

                const createEmptyTypeStat = () => ({
                    games: 0, wins: 0, losses: 0, draws: 0,
                    pointsFor: 0, pointsAgainst: 0,
                    clutchWins: 0, bigWins: 0, currentStreak: 0, maxStreak: 0
                });

                const initPlayer = (name) => {
                    if (!name) return null;
                    const cleanName = String(name).trim();
                    const bareName = cleanName.replace(/\([^)]*\)/g, '').trim();
                    if (!playerMap[cleanName]) {
                        const prof = profileMap[cleanName] || profileMap[bareName];
                        playerMap[cleanName] = {
                            name: cleanName,
                            grade: (prof && prof.grade) || '',
                            gender: (prof && prof.gender) || '',
                            ageGroup: (prof && prof.ageGroup) || '',
                            memberType: prof ? (prof.memberType || '정회원') : '일일회원',
                            _dates: {},
                            ...createEmptyTypeStat(),
                            byType: {
                                '남복': createEmptyTypeStat(),
                                '여복': createEmptyTypeStat(),
                                '혼복': createEmptyTypeStat()
                            }
                        };
                    }
                    return playerMap[cleanName];
                };

                const applyStatUpdate = (targetObj, isWin, isLoss, isDraw, myScore, oppScore) => {
                    targetObj.games += 1;
                    targetObj.pointsFor += myScore;
                    targetObj.pointsAgainst += oppScore;
                    if (isWin) {
                        targetObj.wins += 1;
                        targetObj.currentStreak += 1;
                        if (targetObj.currentStreak > targetObj.maxStreak) targetObj.maxStreak = targetObj.currentStreak;
                        if (Math.abs(myScore - oppScore) <= 2) targetObj.clutchWins += 1;
                        if ((myScore - oppScore) >= 10) targetObj.bigWins += 1;
                    } else if (isLoss) {
                        targetObj.losses += 1;
                        targetObj.currentStreak = 0;
                    } else if (isDraw) {
                        targetObj.draws += 1;
                    }
                };

                const updatePlayerRecord = (name, isWin, isLoss, isDraw, myScore, oppScore, matchType, playDate) => {
                    const p = initPlayer(name);
                    if (!p) return;
                    if (playDate) p._dates[playDate] = true;
                    applyStatUpdate(p, isWin, isLoss, isDraw, myScore, oppScore);
                    if (!p.byType[matchType]) p.byType[matchType] = createEmptyTypeStat();
                    applyStatUpdate(p.byType[matchType], isWin, isLoss, isDraw, myScore, oppScore);
                };

                const updatePairRecord = (p1, p2, isWin, isLoss, isDraw, myScore, oppScore, matchType) => {
                    if (!p1 || !p2) return;
                    const sortedPair = [String(p1).trim(), String(p2).trim()].sort();
                    const n1 = sortedPair[0];
                    const n2 = sortedPair[1];
                    const pairKey = `${n1} & ${n2}`;

                    if (!pairMap[pairKey]) {
                        const prof1 = profileMap[n1] || profileMap[n1.replace(/\([^)]*\)/g, '').trim()];
                        const prof2 = profileMap[n2] || profileMap[n2.replace(/\([^)]*\)/g, '').trim()];
                        pairMap[pairKey] = {
                            pairName: pairKey,
                            player1: n1,
                            player2: n2,
                            players: sortedPair,
                            p1Grade: (prof1 && prof1.grade) || '',
                            p2Grade: (prof2 && prof2.grade) || '',
                            p1Gender: (prof1 && prof1.gender) || '',
                            p2Gender: (prof2 && prof2.gender) || '',
                            p1Age: (prof1 && prof1.ageGroup) || '',
                            p2Age: (prof2 && prof2.ageGroup) || '',
                            p1Type: prof1 ? (prof1.memberType || '정회원') : '일일회원',
                            p2Type: prof2 ? (prof2.memberType || '정회원') : '일일회원',
                            p1Formatted: `${n1}${prof1 && prof1.grade ? '(' + prof1.grade + ')' : ''}`,
                            p2Formatted: `${n2}${prof2 && prof2.grade ? '(' + prof2.grade + ')' : ''}`,
                            ...createEmptyTypeStat(),
                            byType: {
                                '남복': createEmptyTypeStat(),
                                '여복': createEmptyTypeStat(),
                                '혼복': createEmptyTypeStat()
                            }
                        };
                    }
                    const pr = pairMap[pairKey];
                    applyStatUpdate(pr, isWin, isLoss, isDraw, myScore, oppScore);
                    if (!pr.byType[matchType]) pr.byType[matchType] = createEmptyTypeStat();
                    applyStatUpdate(pr.byType[matchType], isWin, isLoss, isDraw, myScore, oppScore);
                };

                (matchRows || []).forEach(r => {
                    const rawMType = r.match_type || '자유';
                    const mType = (rawMType === '자유복식') ? '자유' : rawMType;
                    const sA = Number(r.score_a) || 0;
                    const sB = Number(r.score_b) || 0;
                    const aWin = r.winner_team === 'A';
                    const bWin = r.winner_team === 'B';
                    const isDraw = r.winner_team === 'DRAW';
                    const playDate = String(r.played_at || '').trim().slice(0, 10);

                    const teamA = [r.team_a_p1, r.team_a_p2].filter(Boolean);
                    const teamB = [r.team_b_p1, r.team_b_p2].filter(Boolean);

                    teamA.forEach(p => updatePlayerRecord(p, aWin, bWin, isDraw, sA, sB, mType, playDate));
                    teamB.forEach(p => updatePlayerRecord(p, bWin, aWin, isDraw, sB, sA, mType, playDate));

                    if (teamA.length === 2) updatePairRecord(teamA[0], teamA[1], aWin, bWin, isDraw, sA, sB, mType);
                    if (teamB.length === 2) updatePairRecord(teamB[0], teamB[1], bWin, aWin, isDraw, sB, sA, mType);
                });

                // 공식 랭킹 기본 정렬: 승률 1순위 -> 다승 2순위 -> 득실차 3순위 -> 총득점 4순위
                const playersStats = Object.values(playerMap).map(p => {
                    const winRate = p.games > 0 ? Math.round((p.wins / p.games) * 1000) / 10 : 0;
                    const pointDiff = p.pointsFor - p.pointsAgainst;
                    const attendDays = Object.keys(p._dates || {}).length;
                    const isQualified = (attendDays >= 5 && p.games >= 15);
                    const { _dates, ...rest } = p;
                    return { ...rest, winRate, pointDiff, attendDays, isQualified };
                }).sort((a, b) => (b.winRate - a.winRate) || (b.wins - a.wins) || (b.pointDiff - a.pointDiff) || (b.pointsFor - a.pointsFor));

                const pairStats = Object.values(pairMap).map(pair => {
                    const winRate = pair.games > 0 ? Math.round((pair.wins / pair.games) * 1000) / 10 : 0;
                    const pointDiff = pair.pointsFor - pair.pointsAgainst;
                    const isQualified = (pair.games >= 3);
                    return { ...pair, winRate, pointDiff, isQualified };
                }).sort((a, b) => (b.winRate - a.winRate) || (b.wins - a.wins) || (b.pointDiff - a.pointDiff) || (b.pointsFor - a.pointsFor));

                const isRegular = (mType) => {
                    const u = String(mType || '정회원').toUpperCase();
                    return !u.includes('일일') && !u.includes('게스트') && !u.includes('GUEST');
                };

                const nowKrDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })).getDate();
                const isGraceDays = nowKrDate <= 5;

                const allRegPlayers = playersStats.filter(p => isRegular(p.memberType));
                const qualifiedRegPlayers = allRegPlayers.filter(p => p.isQualified);
                const regularPlayers = (!isGraceDays && qualifiedRegPlayers.length > 0) ? qualifiedRegPlayers : allRegPlayers;

                const allRegPairs = pairStats.filter(pr => isRegular(pr.p1Type) && isRegular(pr.p2Type));
                const qualifiedRegPairs = allRegPairs.filter(pr => pr.isQualified);
                const regularPairs = (!isGraceDays && qualifiedRegPairs.length > 0) ? qualifiedRegPairs : allRegPairs;

                return { playersStats, pairStats, regularPlayers, regularPairs };
            };

            ensureCustomTitlesSchema(() => {
                loadMemberProfiles((profileMap) => {
                    const sql = `SELECT * FROM match_records WHERE (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))${dateFilterSql} ORDER BY played_at ASC`;

                    db.all(sql, queryParams, (err, rows) => {
                        if (err) {
                            console.error('전적 조회 실패:', err.message);
                            return callback && callback({ success: false, message: '전적 조회 실패' });
                        }

                        // 1) 사용자가 선택한 기간(period)의 공식 랭킹 통계 산출
                        const periodBuilt = buildStatsFromRows(rows, profileMap);

                        // 2) 이달의 이벤트 타이틀은 기간 탭과 무관하게 항상 '이번 달' 기록 기준으로 고정 평가
                        const evaluateTitlesWithMonthRows = (monthRows) => {
                            const monthBuilt = (period === 'month') ? periodBuilt : buildStatsFromRows(monthRows, profileMap);

                            const allKnownNames = new Set([
                                ...Object.keys(profileMap),
                                ...(periodBuilt.playersStats || []).map(p => p.name)
                            ]);
                            const membersList = Array.from(allKnownNames).map(name => {
                                const bare = String(name).replace(/\([^)]*\)/g, '').trim();
                                const prof = profileMap[name] || profileMap[bare];
                                return prof ? { name, ...prof } : { name, grade: '', gender: '', ageGroup: '', memberType: '일일회원' };
                            });

                            const titleSql = `SELECT * FROM custom_titles WHERE (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = ''))) AND is_active = 1 ORDER BY id DESC`;
                            db.all(titleSql, [currentClubId, currentClubId], (tErr, customRows) => {
                                const customTitlesEvaluated = (customRows || []).map(ct => {
                                    let parsedCond = {};
                                    try {
                                        if (ct.condition_json) parsedCond = JSON.parse(ct.condition_json);
                                    } catch (e) {}

                                    const cond = {
                                        scope: parsedCond.scope || 'player',
                                        targetMatchType: ct.target_match_type || parsedCond.targetMatchType || 'ALL',
                                        gradeFilter: parsedCond.gradeFilter || 'ALL',
                                        ageFilter: parsedCond.ageFilter || 'ALL',
                                        genderFilter: parsedCond.genderFilter || 'ALL',
                                        minGames: Number(ct.min_games || parsedCond.minGames) || 1,
                                        metricType: ct.metric_type || parsedCond.metricType || 'most_wins'
                                    };

                                    const candidates = evaluateEventTitleCandidates(cond, monthBuilt.regularPlayers, monthBuilt.regularPairs);
                                    const topCandidate = candidates[0] || null;
                                    const autoWinnerText = topCandidate ? `${topCandidate.displayName} · ${topCandidate.metricText}` : '집계 중';

                                    const manualWinner = (ct.manual_winner && String(ct.manual_winner).trim()) || '';
                                    const status = ct.status || (manualWinner ? 'published' : 'pending');

                                    return {
                                        id: ct.id,
                                        titleName: ct.title_name,
                                        description: ct.description || parsedCond.description || '',
                                        prizeInfo: ct.prize_info || parsedCond.prizeInfo || '',
                                        status: status,
                                        manualWinner: manualWinner,
                                        autoWinner: autoWinnerText,
                                        theme: ct.badge_theme || 'gold',
                                        winner: manualWinner || (status === 'published' ? autoWinnerText : '집계 중'),
                                        condition: cond
                                    };
                                });

                                if (callback) {
                                    callback({
                                        success: true,
                                        period,
                                        totalMatches: (rows || []).length,
                                        members: membersList,
                                        playersStats: periodBuilt.playersStats,
                                        pairStats: periodBuilt.pairStats,
                                        pairsStats: periodBuilt.pairStats,
                                        defaultTitles: [],
                                        customTitles: customTitlesEvaluated,
                                        recentMatches: (rows || []).slice(-20).reverse()
                                    });
                                }
                            });
                        };

                        if (period === 'month') {
                            evaluateTitlesWithMonthRows(rows);
                        } else {
                            db.all(
                                `SELECT * FROM match_records WHERE (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = ''))) AND strftime('%Y-%m', played_at) = ? ORDER BY played_at ASC`,
                                [currentClubId, currentClubId, currentMonthPrefix],
                                (mErr, mRows) => evaluateTitlesWithMonthRows(mRows || [])
                            );
                        }
                    });
                });
            });
        } catch (err) {
            console.error('getMatchStats 처리 에러:', err);
            if (callback) callback({ success: false, message: '통계 계산 중 오류가 발생했습니다.' });
        }
    });

    // 1) [관리자 전용] 이벤트 타이틀 등록 및 수정 (구장별 완전 격리)
    socket.on('saveCustomTitle', (data, callback) => {
        try {
            const clubId = String((data && data.clubId) || socket.clubId || 'unjeong').trim();
            const {
                id, titleName, description, prizeInfo, targetMatchType, minGames,
                metricType, badgeTheme, manualWinner, status, condition
            } = data || {};

            if (!titleName || !String(titleName).trim()) {
                return callback && callback({ success: false, message: '타이틀명을 입력해 주세요.' });
            }

            const condObj = condition || {
                scope: 'player',
                targetMatchType: targetMatchType || 'ALL',
                gradeFilter: 'ALL',
                ageFilter: 'ALL',
                genderFilter: 'ALL',
                minGames: Number(minGames) || 3,
                metricType: metricType || 'most_wins'
            };
            const condJsonStr = JSON.stringify(condObj);
            const cleanStatus = status || (manualWinner ? 'published' : 'pending');

            ensureCustomTitlesSchema(() => {
                if (id) {
                    db.run(
                        `UPDATE custom_titles 
                         SET title_name = ?, description = ?, prize_info = ?, target_match_type = ?, min_games = ?, metric_type = ?, badge_theme = ?, manual_winner = ?, status = ?, condition_json = ?, club_id = ?
                         WHERE id = ? AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))`,
                        [
                            String(titleName).trim(),
                            description || '',
                            prizeInfo || '',
                            condObj.targetMatchType || 'ALL',
                            Number(condObj.minGames) || 3,
                            condObj.metricType || 'most_wins',
                            badgeTheme || 'gold',
                            manualWinner || null,
                            cleanStatus,
                            condJsonStr,
                            clubId,
                            id,
                            clubId,
                            clubId
                        ],
                        function(err) {
                            if (err) return callback && callback({ success: false, message: '타이틀 수정 실패' });
                            callback && callback({ success: true, message: '이벤트 타이틀이 수정되었습니다.' });
                        }
                    );
                } else {
                    db.run(
                        `INSERT INTO custom_titles (club_id, title_name, description, prize_info, target_match_type, min_games, metric_type, badge_theme, manual_winner, status, condition_json, is_active)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                        [
                            clubId,
                            String(titleName).trim(),
                            description || '',
                            prizeInfo || '',
                            condObj.targetMatchType || 'ALL',
                            Number(condObj.minGames) || 3,
                            condObj.metricType || 'most_wins',
                            badgeTheme || 'gold',
                            manualWinner || null,
                            cleanStatus,
                            condJsonStr
                        ],
                        function(err) {
                            if (err) return callback && callback({ success: false, message: '타이틀 등록 실패' });
                            callback && callback({ success: true, message: '이벤트 타이틀이 등록되었습니다.' });
                        }
                    );
                }
            });
        } catch (e) {
            callback && callback({ success: false, message: '서버 처리 중 오류 발생' });
        }
    });

    // 2) [관리자 전용] 간편 커스텀 타이틀 생성
    socket.on('createCustomTitle', (data, callback) => {
        const currentClubId = String((data && data.clubId) || socket.clubId || 'unjeong').trim();
        const titleName = ((data && data.titleName) || '').trim();
        const metricType = (data && data.metricType) || 'most_wins';
        const targetMatchType = (data && data.targetMatchType) || 'ALL';
        const minGames = parseInt((data && data.minGames), 10) || 3;
        const badgeTheme = (data && data.badgeTheme) || 'gold';

        if (!titleName) {
            return callback && callback({ success: false, message: '타이틀 이름을 입력해 주세요.' });
        }

        ensureCustomTitlesSchema(() => {
            const sql = `
                INSERT INTO custom_titles (club_id, title_name, metric_type, target_match_type, min_games, badge_theme, is_active)
                VALUES (?, ?, ?, ?, ?, ?, 1)
            `;
            db.run(sql, [currentClubId, titleName, metricType, targetMatchType, minGames, badgeTheme], function(err) {
                if (err) {
                    console.error('❌ 커스텀 타이틀 생성 실패:', err.message);
                    return callback && callback({ success: false, message: '타이틀 생성 실패' });
                }
                if (callback) callback({ success: true, id: this.lastID });
            });
        });
    });

    // 3) [관리자 전용] 이벤트 타이틀 삭제 (중복 리스너 단일화 및 구장 격리)
    socket.on('deleteCustomTitle', (data, callback) => {
        try {
            const clubId = String((data && data.clubId) || socket.clubId || 'unjeong').trim();
            const id = data && data.id;
            if (!id) {
                return callback && callback({ success: false, message: '삭제할 타이틀 ID가 없습니다.' });
            }

            const sql = `
                DELETE FROM custom_titles 
                WHERE id = ? AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
            `;
            db.run(sql, [id, clubId, clubId], (err) => {
                if (err) return callback && callback({ success: false, message: '삭제 실패' });
                callback && callback({ success: true });
            });
        } catch (e) {
            callback && callback({ success: false, message: '서버 오류' });
        }
    });

    // 4) [관리자 전용] 대기 방 및 코트 강제 퇴장 처리 (구장별 알림 격리 적용)
    socket.on('adminForceExit', ({ targetType, targetId, index, clubId: reqClubId } = {}) => {
        try {
            const clubId = String(reqClubId || socket.clubId || 'unjeong').trim();
            const club = getClub(clubId);
            if (!club) return;

            const notifyClub = (msg) => {
                if (typeof addNotificationForClub === 'function') {
                    addNotificationForClub(clubId, msg);
                } else if (typeof addNotification === 'function') {
                    addNotification(msg);
                }
            };

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

                    notifyClub(`⚠️ [관리자 강제퇴장] ${kickedName} 님이 대기 방에서 강제 퇴장되었습니다.`);
                    broadcastState(clubId);
                }
            } else if (targetType === 'court') {
                const court = club.courtsData.find(c => c.id === targetId);
                if (court) {
                    if (court.type === 'game') {
                        court.isEmpty = true;
                        court.players = '';
                        court.startTime = null;
                        court.remainingSeconds = 0;
                        notifyClub(`⚠️ [관리자 강제퇴장] 게임 코트(${court.id}번)가 강제 종료 및 비워졌습니다.`);
                    } else if (court.type === 'nanta') {
                        if (index === 'A' && court.sideA) {
                            court.sideA = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                        } else if (index === 'B' && court.sideB) {
                            court.sideB = { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 };
                        }
                        notifyClub(`⚠️ [관리자 강제퇴장] 난타 코트(${court.id}번 - ${index}면)가 강제 비워졌습니다.`);
                    }
                    broadcastState(clubId);
                }
            }
        } catch (err) {
            console.error('관리자 강제 퇴장 처리 에러:', err);
        }
    });

    // 🤝 [방 통합 처리] (멀티 테넌트 반영)
    socket.on('mergeSlot', ({ mySlotId, targetSlotId }) => {
        // 🛡️ 공통 Wi-Fi 검증 (미연결 시 방 통합 차단)
        if (!checkWifiGuard('게임 방을 통합')) return;

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
    // 💡 [완성] 명시적 로그아웃 처리 (타이머 및 대기방 즉시 완전 소멸)
    // =================================================================
    socket.on('explicitLogout', async (userData, callback) => {
        socket.isExplicitLogout = true; // 유예시간 작동 방지 꼬리표
        const isForcedLogout = Boolean(userData && userData.isForcedLogout);
        const targetClubId = (userData && userData.clubId) || socket.clubId || clientClubId || 'unjeong';

        let rawName = socket.finalName || socket.username;
        if (!rawName && userData) {
            rawName = (typeof userData === 'object') ? (userData.name || userData.username || userData.id || userData.phone) : String(userData);
        }

        if (rawName) {
            let cleanUsername = String(rawName).replace(/님$/, '').split('/')[0].split('|')[0].trim();

            // 전화번호 형태라면 DB에서 해당 구장 소속 회원의 진짜 이름으로 변환
            if (cleanUsername && /^[0-9\-]+$/.test(cleanUsername) && typeof db !== 'undefined') {
                const digits = cleanUsername.replace(/[^0-9]/g, '');
                const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
                try {
                    // 🏢 [멀티테넌트 수정] 해당 구장 소속 회원만 조회
                    const row = await new Promise((resolve) => {
                        db.get(
                            `SELECT name FROM regular_members WHERE (id = ? OR phone = ? OR phone = ?) AND (club_id = ? OR (club_id IS NULL AND ? = 'unjeong'))`,
                            [cleanUsername, digits, hyphen, targetClubId, targetClubId],
                            (err, res) => resolve(res)
                        );
                    });
                    if (row && row.name) cleanUsername = row.name;
                } catch (e) {}
            }

            const clubUserKey = `${targetClubId}_${cleanUsername}`;

            // 현재 소켓이 activeUserSockets에 등록된 경우에만 매핑 제거 (새 기기 소켓 보호)
            if (typeof activeUserSockets !== 'undefined' && activeUserSockets.get) {
                if (activeUserSockets.get(clubUserKey) === socket.id) {
                    activeUserSockets.delete(clubUserKey);
                }
            }

            if (!isForcedLogout) {
                console.log(`🚪 [명시적 로그아웃] [${targetClubId}] 유저(${cleanUsername}) 즉시 대기방 삭제 및 모든 타이머 초기화!`);

                // 1. 매니저의 1단계/2단계 타이머 및 상태 즉시 제거
                if (typeof gymSessionManager !== 'undefined' && typeof gymSessionManager.clearUserImmediately === 'function') {
                    gymSessionManager.clearUserImmediately(cleanUsername, targetClubId);
                }

                // 2. 🏢 [멀티테넌트 수정] 구장별 복합 키 기준으로만 구형 타이머 잔재 제거 (타 구장 동명이인 보호)
                if (typeof disconnectTimers !== 'undefined' && disconnectTimers[clubUserKey]) {
                    clearTimeout(disconnectTimers[clubUserKey]);
                    delete disconnectTimers[clubUserKey];
                }

                // 3. 즉시 대기방 폭파 (클럽 ID 포함)
                if (typeof cleanupUser === 'function') {
                    await cleanupUser(cleanUsername, targetClubId);
                }
            } else {
                console.log(`🚪 [중복 로그인 퇴출 완료] [${targetClubId}] 유저(${cleanUsername}) 기존 소켓(${socket.id})만 정리`);
            }
        }

        socket.username = null;
        socket.finalName = null;
        socket.clubUserKey = null;
        if (typeof userSockets !== 'undefined') delete userSockets[socket.id];
        if (typeof broadcastOnlineCount === 'function') broadcastOnlineCount(targetClubId);

        if (typeof callback === 'function') {
            callback();
        }
    });

    // =================================================================
    // 📶 1. 클라이언트 와이파이 상태 변경 수신 (체육관 이탈/복귀 실시간 즉각 감지)
    // =================================================================
    socket.on('updateWifiState', async (data) => {
        const { inGym, clubId, userId, username, phone } = data || {};
        if (data && data.clientIp) {
            socket.verifiedClientIp = String(data.clientIp).replace(/^.*:/, '').trim();
        }
        const targetClubId = clubId || socket.clubId || clientClubId || 'unjeong';

        const rawUser = socket.finalName || username || userId || phone || (typeof userSockets !== 'undefined' && userSockets[socket.id]) || socket.username;
        let rawUsername = '';
        if (rawUser) {
            rawUsername = (typeof rawUser === 'object' && rawUser !== null)
                ? (rawUser.name || rawUser.username || rawUser.id || rawUser.phone || '')
                : String(rawUser);
        }
        let cleanUsername = String(rawUsername).replace(/님$/, '').split('/')[0].split('|')[0].trim();

        // 전화번호 형태라면 DB에서 진짜 이름으로 변환하여 이름표 통일
        if (cleanUsername && /^[0-9\-]+$/.test(cleanUsername) && typeof db !== 'undefined') {
            const digits = cleanUsername.replace(/[^0-9]/g, '');
            const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
            try {
                const row = await new Promise((resolve) => {
                    db.get(`SELECT name FROM regular_members WHERE id = ? OR phone = ? OR phone = ?`, [cleanUsername, digits, hyphen], (err, res) => resolve(res));
                });
                if (row && row.name) cleanUsername = row.name;
            } catch (e) {}
        }

        if (!cleanUsername || cleanUsername === '0100') return;

        socket.finalName = cleanUsername;
        socket.username = cleanUsername;
        socket.clubId = targetClubId;

        if (inGym) {
            // 🟢 체육관 Wi-Fi 정상 복귀 -> 모든 타이머 즉시 초기화 및 운동중 유지
            socket.inGym = true;
            socket.isGymWifi = true;
            socket.inGracePeriod = false;
            socket.verifiedWifi = true;
            if (typeof gymSessionManager !== 'undefined') {
                gymSessionManager.handleConnect(socket, cleanUsername, targetClubId);
            }
        } else {
            // 🔴 체육관 Wi-Fi 이탈 -> gymSessionManager가 구장 이력을 판단해 1단계(유예) & 2단계(만료) 타이머 및 inGracePeriod 제어
            socket.inGym = false;
            socket.isGymWifi = false;
            socket.verifiedWifi = false;
            if (typeof gymSessionManager !== 'undefined') {
                gymSessionManager.handleDisconnect(socket, cleanUsername, targetClubId);
            }
        }
        if (typeof broadcastOnlineCount === 'function') {
            broadcastOnlineCount(targetClubId);
        }
    });

    // =================================================================
    // 🎯 [부품 A] DB 이름 복원 및 타이머 즉각 제어 엔진
    // =================================================================
    socket.on('requestWifiStatus', async (data) => {
        const targetClubId = (data && data.clubId) || socket.clubId || clientClubId || 'unjeong';
        
        // 💡 [수정] guest_ 임시 ID보다 실명(data.name)을 최우선으로 추출
        const nonGuestUsername = (data && data.username && !String(data.username).startsWith('guest_')) ? data.username : '';
        let rawUsername = (data && (data.name || nonGuestUsername || data.phone || data.username))
            ? String(data.name || nonGuestUsername || data.phone || data.username)
            : (socket.finalName || socket.username || '');
        let cleanUsername = rawUsername.replace(/님$/, '').split('/')[0].split('|')[0].trim();
        let finalName = cleanUsername;

        // 만약 cleanUsername이 guest_인데 기존 소켓에 실명이 있다면 실명 유지
        if (finalName.startsWith('guest_') && socket.finalName && !socket.finalName.startsWith('guest_')) {
            finalName = socket.finalName;
        }

        // DB 이름 복원 로직 (전화번호로 타이머 도는 현상 완벽 방지)
        if (cleanUsername) {
            const isPhone = /^[0-9\-]+$/.test(cleanUsername);
            if (isPhone && typeof db !== 'undefined') {
                const digits = cleanUsername.replace(/[^0-9]/g, '');
                const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
                try {
                    const row = await new Promise((resolve) => {
                        db.get(`SELECT name FROM regular_members WHERE id = ? OR phone = ? OR phone = ?`, [cleanUsername, digits, hyphen], (err, res) => resolve(res));
                    });
                    if (row && row.name) finalName = row.name;
                } catch (e) {}
            }
            
            socket.finalName = finalName;
            socket.username = finalName;
            socket.clubId = targetClubId;

            if (typeof userSockets !== 'undefined') {
                userSockets[socket.id] = { username: finalName, clubId: targetClubId };
            }
            socket.join(`club_${targetClubId}`);
        }

        const isGym = (typeof isGymWifiUser === 'function') ? isGymWifiUser(socket, targetClubId) : true;
        const clientIp = (typeof getClientIp === 'function') ? getClientIp(socket) : '';
        const club = (typeof getClub === 'function') ? getClub(targetClubId) : (typeof clubs !== 'undefined' ? clubs[targetClubId] : null);
        const useWifiRestriction = (club && club.config) ? (club.config.useWifiRestriction !== false) : true;

        // 클라이언트에 현재 Wi-Fi 판정 결과 즉시 회신
        socket.emit('wifiStatus', {
            isGymWifi: isGym,
            clientIp: clientIp,
            useWifiRestriction: useWifiRestriction
        });
        
        if (socket.finalName && socket.finalName !== '0100') {
            console.log(`📶 [즉각 트리거] [${targetClubId}] 유저(${socket.finalName}) 실시간 상태: ${isGym ? '🟢 [Wi-Fi 일치]' : '🔴 [Wi-Fi 불일치]'}`);

            if (isGym) {
                socket.inGym = true;
                socket.isGymWifi = true;
                socket.inGracePeriod = false;

                if (typeof gymSessionManager !== 'undefined') {
                    gymSessionManager.handleConnect(socket, socket.finalName, targetClubId);
                }
            } else {
                socket.inGym = false;
                socket.isGymWifi = false;
                // 💡 무조건 inGracePeriod = true로 주지 않고 gymSessionManager가 판별하도록 위임
                if (typeof gymSessionManager !== 'undefined') {
                    gymSessionManager.handleDisconnect(socket, socket.finalName, targetClubId);
                }
            }
        }
    });

    // =================================================================
    // 🧹 [최종 방어] 소켓 통신 단절 시 바통 터치 및 백업 타이머 가동
    // =================================================================
    socket.on('disconnect', async () => {
        let rawName = socket.finalName || socket.username || socket.cleanUsername || '';
        const currentClubId = socket.clubId || 'unjeong';

        if (typeof userSockets !== 'undefined') delete userSockets[socket.id];

        let finalName = String(rawName).replace(/님$/, '').split('/')[0].split('|')[0].trim();
        if (!finalName || finalName === '0100' || finalName.length < 2 || socket.isExplicitLogout) {
            if (typeof broadcastOnlineCount === 'function') broadcastOnlineCount(currentClubId);
            return;
        }

        // 전화번호로 남아있는 경우 DB에서 진짜 이름으로 변환
        if (/^[0-9\-]+$/.test(finalName) && typeof db !== 'undefined') {
            const digits = finalName.replace(/[^0-9]/g, '');
            const hyphen = digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
            try {
                const row = await new Promise((resolve) => {
                    db.get(`SELECT name FROM regular_members WHERE id = ? OR phone = ? OR phone = ?`, [finalName, digits, hyphen], (err, res) => resolve(res));
                });
                if (row && row.name) finalName = row.name;
            } catch (e) {}
        }

        // 💡 이미 LTE 전환 감지 등으로 매니저 타이머가 가동 중이라면 15초 대기 없이 즉시 카운트 유지
        if (typeof gymSessionManager !== 'undefined') {
            const pending = gymSessionManager.getPendingUsers(currentClubId);
            if (pending.graceUsers.includes(finalName) || pending.sessionUsers.includes(finalName)) {
                if (typeof broadcastOnlineCount === 'function') broadcastOnlineCount(currentClubId);
                return;
            }
        }

        console.log(`⏳ [바통 터치 대기] 유저(${finalName}) 통신선 끊김. 5초 내 구장 Wi-Fi 새 통신선 확인 대기...`);

        setTimeout(() => {
            let hasActiveGymWifiSocket = false;

            if (socket.nsp) {
                const allSockets = Array.from(socket.nsp.sockets.values());
                for (let s of allSockets) {
                    if (s.id !== socket.id && (s.finalName === finalName || s.username === finalName)) {
                        if (typeof isGymWifiUser === 'function' && isGymWifiUser(s, currentClubId)) {
                            hasActiveGymWifiSocket = true;
                            break;
                        }
                    }
                }
            }

           if (hasActiveGymWifiSocket) {
                console.log(`🛡️ [바통 터치 성공] 유저(${finalName}) 구장 Wi-Fi 연결이 유지되고 있습니다. 카운트 정상 유지!`);
            } else {
                console.log(`🌙 [수면 모드/통신 단절] 유저(${finalName}) 소켓 끊김 -> 1단계 유예 생략(대기방 보존) & 2단계 세션 만료 타이머 가동!`);
                if (typeof gymSessionManager !== 'undefined') {
                    // 💡 마지막에 true를 전달하여 수면 모드임을 알림
                    gymSessionManager.handleDisconnect(socket, finalName, currentClubId, true);
                }
            }

            if (typeof broadcastOnlineCount === 'function') broadcastOnlineCount(currentClubId);
        }, 5000);
    });

    // ==========================================
    // 👑 [슈퍼 관리자] 멀티 클럽 생성 및 통합 관리
    // ==========================================
    const SUPER_ADMIN_KEY = 'super1234'; // 💡 슈퍼 관리자 마스터 비밀번호

    // 1. 슈퍼 관리자 로그인 및 클럽 목록 + 서버 상태 조회
    socket.on('superAdmin:getClubs', (password, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '마스터 비밀번호가 일치하지 않습니다.' });
        }

        const clubList = Object.keys(clubs).map(cId => {
            const c = clubs[cId];
            const displayName = c.clubName || c.name || cId;
            const courtsArr = Array.isArray(c.courtsData) ? c.courtsData : [];
            const activeCourts = courtsArr.filter(ct => {
                if (!ct || ct.type === 'lesson') return false;
                if (ct.type === 'nanta') {
                    return (ct.sideA && !ct.sideA.isEmpty) || (ct.sideB && !ct.sideB.isEmpty);
                }
                return ct.isEmpty === false;
            }).length;

            return {
                id: cId,
                name: displayName,
                clubName: displayName,
                courtCount: courtsArr.length,
                activeCourts,
                gameQueueCount: Array.isArray(c.gameQueue) ? c.gameQueue.length : 0,
                nantaQueueCount: Array.isArray(c.nantaQueue) ? c.nantaQueue.length : 0,
                useWifi: c.config ? Boolean(c.config.useWifiRestriction) : false,
                allowedGymIps: (c.config && Array.isArray(c.config.allowedGymIps)) ? c.config.allowedGymIps : [],
                adminPassword: (c.config && c.config.ADMIN_PASSWORD) ? String(c.config.ADMIN_PASSWORD) : '1234'
            };
        });

        const serverInfo = {
            uptimeSec: Math.floor(process.uptime()),
            memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            storageMode: (typeof CLUBS_DATA_FILE !== 'undefined' && String(CLUBS_DATA_FILE).startsWith('/var/data'))
                ? '영구 디스크 (/var/data)'
                : '로컬 폴더'
        };

        callback({ success: true, clubs: clubList, serverInfo });

        // 접속 직후 최신 4대 현황 카운트 즉시 브로드캐스트
        if (typeof broadcastOnlineCount === 'function') {
            setTimeout(() => broadcastOnlineCount(), 100);
        }
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

        // 🏢 [멀티테넌트 수정] loadClubsData()와 100% 동일한 구조(name, nextType 포함)로 코트 생성
        const generatedCourts = [];
        for (let i = 1; i <= courtsNum; i++) {
            const courtName = `${i}코트`;
            if (i <= courtsNum - 2) {
                generatedCourts.push({ id: i, name: courtName, type: 'game', nextType: 'game', isEmpty: true, players: '', note: '' });
            } else if (i === courtsNum - 1) {
                generatedCourts.push({
                    id: i,
                    name: courtName,
                    type: 'nanta',
                    nextType: 'nanta',
                    sideA: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                    sideB: { isEmpty: true, players: '', startTime: null, remainingSeconds: 0 },
                    note: ''
                });
            } else {
                generatedCourts.push({ id: i, name: courtName, type: 'lesson', nextType: 'lesson', isEmpty: false, players: '레슨 전용 코트', note: '' });
            }
        }

        // 🏢 [멀티테넌트 수정] 운정클럽과 동일한 필수 런타임 필드 및 분/초 타이머 설정 완비
        clubs[cleanId] = {
            clubId: cleanId,
            clubName: cleanName,
            name: cleanName, // 기존 호환성 유지용
            isActive: true,
            courtCount: courtsNum,
            slotIdCounter: 1,
            config: {
                clubName: cleanName,
                ENTRY_TIMEOUT_SEC: 180,
                NANTA_COURT_LIMIT_SEC: 900,
                ADMIN_PASSWORD: adminPass,
                queueGraceMinutes: 30,
                sessionExpireMinutes: 60,
                continuousGameLimitMinutes: 5,
                DISCONNECT_GRACE_SEC: 1800,
                SESSION_TIMEOUT_SEC: 3600,
                useWifiRestriction: false,
                allowedGymIps: []
            },
            courtsData: generatedCourts,
            courts: generatedCourts,
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

    // 2-1. 기존 클럽 정보 수정 (클럽명, 코트 수, 관리자 비밀번호, Wi-Fi 제한)
    socket.on('superAdmin:updateClub', ({ password, clubId, clubName, courtCount, adminPassword, useWifiRestriction }, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '권한이 없습니다.' });
        }

        const cleanId = String(clubId || '').trim().toLowerCase();
        const targetClub = clubs[cleanId];
        if (!cleanId || !targetClub) {
            return callback({ success: false, message: '존재하지 않는 클럽입니다.' });
        }

        const cleanName = String(clubName || '').trim();
        if (!cleanName) {
            return callback({ success: false, message: '클럽 명칭을 입력해 주세요.' });
        }

        const courtsNum = Math.max(2, Math.min(20, parseInt(courtCount, 10) || targetClub.courtCount || 6));
        const adminPass = String(adminPassword || '').trim();

        if (!targetClub.config) targetClub.config = {};

        // 1. 클럽명 및 관리자 비밀번호 반영
        targetClub.clubName = cleanName;
        targetClub.name = cleanName;
        targetClub.config.clubName = cleanName;
        if (adminPass) {
            targetClub.config.ADMIN_PASSWORD = adminPass;
        }

        // 2. Wi-Fi 제한 ON/OFF 반영
        const prevWifiRestriction = Boolean(targetClub.config.useWifiRestriction);
        if (typeof useWifiRestriction === 'boolean') {
            targetClub.config.useWifiRestriction = useWifiRestriction;
        }

        // 3. 코트 수 변경 시 기존 코트 상태·설정 최대한 보존하며 증감
        const existingCourts = Array.isArray(targetClub.courtsData) ? targetClub.courtsData : [];
        let updatedCourts = existingCourts.slice(0, courtsNum);
        for (let i = updatedCourts.length + 1; i <= courtsNum; i++) {
            updatedCourts.push({
                id: i,
                name: `${i}코트`,
                type: 'game',
                nextType: 'game',
                isEmpty: true,
                players: '',
                note: ''
            });
        }
        updatedCourts = updatedCourts.map((c, idx) => ({
            ...c,
            id: idx + 1,
            name: c.name || `${idx + 1}코트`
        }));

        targetClub.courtsData = updatedCourts;
        targetClub.courts = updatedCourts;
        targetClub.courtCount = updatedCourts.length;

        // 4. 영구 저장 및 해당 클럽(회원·관리자·TV) 실시간 동기화
        if (typeof saveClubsData === 'function') {
            saveClubsData();
        }
        if (typeof broadcastState === 'function') {
            broadcastState(cleanId);
        }
        io.to(`club_${cleanId}`).emit('syncConfig', { ...targetClub.config, clubId: cleanId });

        // Wi-Fi 제한 토글이 바뀐 경우 해당 클럽 접속자들의 Wi-Fi 상태·타이머 즉시 재검증
        if (typeof useWifiRestriction === 'boolean' && prevWifiRestriction !== useWifiRestriction) {
            const roomSockets = io.sockets.adapter.rooms.get(`club_${cleanId}`);
            const restrictionOn = targetClub.config.useWifiRestriction !== false;
            if (roomSockets) {
                roomSockets.forEach((sId) => {
                    const s = io.sockets.sockets.get(sId);
                    if (s) {
                        const isGym = (typeof isGymWifiUser === 'function') ? isGymWifiUser(s, cleanId) : true;
                        const currentIp = s.verifiedClientIp || (typeof getClientIp === 'function' ? getClientIp(s) : '');
                        s.inGym = isGym;
                        s.isGymWifi = isGym;
                        if (s.finalName && s.finalName !== '0100' && typeof gymSessionManager !== 'undefined') {
                            if (isGym) {
                                s.inGracePeriod = false;
                                gymSessionManager.handleConnect(s, s.finalName, cleanId);
                            } else {
                                gymSessionManager.handleDisconnect(s, s.finalName, cleanId);
                            }
                        }
                        s.emit('wifiStatus', {
                            clubId: cleanId,
                            isGymWifi: isGym,
                            clientIp: currentIp,
                            useWifiRestriction: restrictionOn
                        });
                    }
                });
            }
            if (typeof broadcastOnlineCount === 'function') {
                broadcastOnlineCount(cleanId);
            }
        }

        console.log(`👑 [슈퍼 관리자] 클럽 정보 수정 완료: ${cleanName} (${cleanId}), 코트: ${updatedCourts.length}개`);
        callback({ success: true, message: `[${cleanName}] 클럽 정보가 수정되었습니다.` });
    });

    // 2-2. [슈퍼 관리자] 고객지원(문의함 + FAQ + 오픈채팅 URL) 전체 조회
    socket.on('superAdmin:getSupportData', (password, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '권한이 없습니다.' });
        }
        db.all(
            `SELECT * FROM user_inquiries ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC LIMIT 100`,
            [],
            (inqErr, inquiries) => {
                db.all(`SELECT * FROM support_faqs ORDER BY id ASC`, [], (faqErr, faqs) => {
                    db.get(`SELECT value FROM platform_settings WHERE key = 'kakao_open_chat_url'`, [], (setErr, setRow) => {
                        callback({
                            success: true,
                            inquiries: inquiries || [],
                            faqs: faqs || [],
                            kakaoOpenChatUrl: (setRow && setRow.value) ? String(setRow.value).trim() : ''
                        });
                    });
                });
            }
        );
    });

    // 2-3. [슈퍼 관리자] 문의 답변 저장
    socket.on('superAdmin:replyInquiry', ({ password, id, reply }, callback) => {
        if (password !== SUPER_ADMIN_KEY) return callback({ success: false, message: '권한이 없습니다.' });
        const cleanReply = String(reply || '').trim().slice(0, 1000);
        if (!id || !cleanReply) return callback({ success: false, message: '답변 내용을 입력해 주세요.' });
        const repliedAt = getSupportKstDateTime();
        db.run(
            `UPDATE user_inquiries SET reply = ?, status = 'answered', replied_by = '앱 관리자', replied_at = ? WHERE id = ?`,
            [cleanReply, repliedAt, id],
            function(err) {
                if (err) return callback({ success: false, message: '답변 저장 중 오류가 발생했습니다.' });
                callback({ success: true, message: '답변이 등록되었습니다.' });
            }
        );
    });

    // 2-4. [슈퍼 관리자] 문의 삭제
    socket.on('superAdmin:deleteInquiry', ({ password, id }, callback) => {
        if (password !== SUPER_ADMIN_KEY) return callback({ success: false, message: '권한이 없습니다.' });
        db.run(`DELETE FROM user_inquiries WHERE id = ?`, [id], (err) => {
            if (err) return callback({ success: false, message: '삭제 실패' });
            callback({ success: true, message: '문의 내역이 삭제되었습니다.' });
        });
    });

    // 2-5. [슈퍼 관리자] FAQ 추가
    socket.on('superAdmin:addFaq', ({ password, category, question, answer }, callback) => {
        if (password !== SUPER_ADMIN_KEY) return callback({ success: false, message: '권한이 없습니다.' });
        const cleanCat = String(category || '일반').trim().slice(0, 30);
        const cleanQ = String(question || '').trim().slice(0, 200);
        const cleanA = String(answer || '').trim().slice(0, 1000);
        if (!cleanQ || !cleanA) return callback({ success: false, message: '질문과 답변을 모두 입력해 주세요.' });
        const createdAt = getSupportKstDateTime().slice(0, 10);
        db.run(
            `INSERT INTO support_faqs (category, question, answer, created_at) VALUES (?, ?, ?, ?)`,
            [cleanCat, cleanQ, cleanA, createdAt],
            (err) => {
                if (err) return callback({ success: false, message: 'FAQ 등록 실패' });
                callback({ success: true, message: '새 FAQ가 등록되었습니다.' });
            }
        );
    });

    // 2-6. [슈퍼 관리자] FAQ 삭제
    socket.on('superAdmin:deleteFaq', ({ password, id }, callback) => {
        if (password !== SUPER_ADMIN_KEY) return callback({ success: false, message: '권한이 없습니다.' });
        db.run(`DELETE FROM support_faqs WHERE id = ?`, [id], (err) => {
            if (err) return callback({ success: false, message: 'FAQ 삭제 실패' });
            callback({ success: true, message: 'FAQ가 삭제되었습니다.' });
        });
    });

    // 2-7. [슈퍼 관리자] 카카오톡 오픈채팅 링크 저장
    socket.on('superAdmin:saveKakaoUrl', ({ password, url }, callback) => {
        if (password !== SUPER_ADMIN_KEY) return callback({ success: false, message: '권한이 없습니다.' });
        const cleanUrl = String(url || '').trim().slice(0, 300);
        if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
            return callback({ success: false, message: 'https:// 로 시작하는 올바른 주소를 입력해 주세요.' });
        }
        db.run(
            `INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('kakao_open_chat_url', ?)`,
            [cleanUrl],
            (err) => {
                if (err) return callback({ success: false, message: '저장 실패' });
                callback({ success: true, message: cleanUrl ? '카카오톡 오픈채팅 링크가 저장되었습니다.' : '오픈채팅 링크가 해제되었습니다.' });
            }
        );
    });

    // 3. 클럽 삭제
    socket.on('superAdmin:deleteClub', ({ password, clubId }, callback) => {
        if (password !== SUPER_ADMIN_KEY) {
            return callback({ success: false, message: '권한이 없습니다.' });
        }

        const cleanId = String(clubId || '').trim().toLowerCase();
        if (!cleanId || !clubs[cleanId]) {
            return callback({ success: false, message: '존재하지 않는 클럽입니다.' });
        }

        // 🏢 [멀티테넌트 수정] 기본 기준 구장(unjeong) 실수 삭제 보호
        if (cleanId === 'unjeong') {
            return callback({ success: false, message: '기본 기준 클럽(unjeong)은 삭제할 수 없습니다.' });
        }

        const deletedName = clubs[cleanId].clubName || clubs[cleanId].name || cleanId;

        // 🏢 [멀티테넌트 수정] 삭제 대상 구장에 접속 중인 모든 화면(관리자·회원·TV) 즉시 차단
        const deletedPayload = {
            clubId: cleanId,
            clubName: deletedName,
            reason: 'club_deleted',
            message: `[${deletedName}] 클럽이 삭제되어 접속이 종료됩니다.`
        };
        io.to(`club_${cleanId}`).emit('clubDeleted', deletedPayload);
        io.to(`tv-room-${cleanId}`).emit('clubDeleted', deletedPayload);
        io.to(`club_${cleanId}`).emit('forceLogout', deletedPayload);

        // 안내 이벤트 수신 직후 해당 클럽의 모든 소켓 강제 종료
        setTimeout(() => {
            try {
                if (typeof io.in === 'function') {
                    io.in(`club_${cleanId}`).disconnectSockets(true);
                    io.in(`tv-room-${cleanId}`).disconnectSockets(true);
                }
            } catch (e) {
                console.error('[클럽 삭제 소켓 종료 오류]', e);
            }
        }, 300);

        if (typeof activeUserSockets !== 'undefined' && activeUserSockets.keys) {
            for (const key of Array.from(activeUserSockets.keys())) {
                if (key.startsWith(`${cleanId}_`)) {
                    activeUserSockets.delete(key);
                }
            }
        }
        if (typeof clubAudioQueues !== 'undefined') delete clubAudioQueues[cleanId];
        if (typeof clubVoicePlayingState !== 'undefined') delete clubVoicePlayingState[cleanId];

        delete clubs[cleanId];

        if (typeof saveClubsData === 'function') {
            saveClubsData();
        }

        console.log(`👑 [슈퍼 관리자] 클럽 삭제 완료: ${deletedName} (${cleanId})`);
        callback({ success: true, message: `[${deletedName}] 클럽이 삭제되었습니다.` });
    });
});

// 🏢 [멀티 테넌트] 4대 현황(접속자, 운동중, 게임, 난타) 실시간 집계 및 브로드캐스트
function broadcastOnlineCount(targetClubId) {
    if (!io || !io.sockets || !io.sockets.adapter) return;

    // 🏢 [멀티테넌트 수정] 실제 존재하는 clubs 키만 순회 (삭제된 클럽 자동 재생성 방지)
    const allClubIds = (typeof clubs !== 'undefined' && clubs && Object.keys(clubs).length > 0)
        ? Object.keys(clubs)
        : ['unjeong'];
    const superAdminSummary = {};

    allClubIds.forEach((clubId) => {
        const roomName = `club_${clubId}`;
        const room = io.sockets.adapter.rooms.get(roomName);

        const loggedInUsers = new Set();
        const wifiUsers = new Set();

        // 1. 현재 실시간 소켓 연결된 회원 집계
        if (room) {
            room.forEach((socketId) => {
                const userSocket = io.sockets.sockets.get(socketId);
                if (!userSocket) return;

                // 🏢 [멀티테넌트 수정] 다른 구장으로 소속이 바뀐 소켓이 잔류한 경우 집계 제외
                if (userSocket.clubId && userSocket.clubId !== clubId) return;

                const userKey = userSocket.username || 
                                userSocket.userIdentifier || 
                                userSocket.userId || 
                                (userSocket.clubUserKey ? userSocket.clubUserKey.replace(`${clubId}_`, '') : null);

                if (userKey) {
                    loggedInUsers.add(userKey);
                    
                    // 💡 실시간 전달된 socket.inGym 상태 또는 유예시간(inGracePeriod) 중이면 운동중 유지
                    const isCurrentlyInGym = (typeof userSocket.inGym !== 'undefined' || userSocket.inGracePeriod) 
                        ? (userSocket.inGym === true || userSocket.inGracePeriod === true) 
                        : (typeof isGymWifiUser === 'function' && isGymWifiUser(userSocket, clubId));

                    if (isCurrentlyInGym) {
                        wifiUsers.add(userKey);
                    }
                }
            });
        }

        // 2. 🏸 [gymSessionManager 연동] 1단계 유예 및 2단계 세션 유지 회원 정밀 합산
        if (gymSessionManager && typeof gymSessionManager.getPendingUsers === 'function') {
            const { graceUsers, sessionUsers } = gymSessionManager.getPendingUsers(clubId);

            // [1단계: 유예 구간] 접속자 유지 + 운동중 유지 (대기방 보존)
            graceUsers.forEach((user) => {
                loggedInUsers.add(user);
                wifiUsers.add(user);
            });

            // [2단계: 잔여 세션 구간] 대기방은 삭제되었으나 접속자 수는 세션 만료 전까지 유지
            sessionUsers.forEach((user) => {
                loggedInUsers.add(user);
            });
        }

        // 3. 게임(대기열 + 코트) 인원 산출
        let gameCount = 0;
        // 🏢 [멀티테넌트 수정] getClub() 대신 clubs[clubId] 직접 조회로 부수 효과 차단
        const club = (typeof clubs === 'object' && clubs) ? clubs[clubId] : null;
        const cCourts = (club && Array.isArray(club.courtsData)) ? club.courtsData : [];
        const cGameQueue = (club && Array.isArray(club.gameQueue)) ? club.gameQueue : [];
        const cNantaQueue = (club && Array.isArray(club.nantaQueue)) ? club.nantaQueue : [];

        // 3-1. 게임 대기방 인원 계산
        cGameQueue.forEach(item => {
            if (Array.isArray(item.players)) {
                gameCount += item.players.filter(p => p && (typeof p === 'string' ? p.trim() !== '' : p.name)).length;
            } else if (item.players && typeof item.players === 'string') {
                gameCount += item.players.split(',').filter(p => p.trim() !== '').length;
            } else if (item.user || item.username) {
                gameCount += 1;
            }
        });

        // 3-2. 게임 코트 경기자 인원 계산
        cCourts.forEach(c => {
            if (c.type === 'game' && !c.isEmpty && c.players) {
                if (Array.isArray(c.players)) {
                    gameCount += c.players.filter(p => p && (typeof p === 'string' ? p.trim() !== '' : p.name)).length;
                } else if (typeof c.players === 'string') {
                    gameCount += c.players.split(',').filter(p => p.trim() !== '').length;
                }
            }
        });

        // 4. 난타(대기열 + 코트) 인원 산출
        let nantaCount = 0;

        // 4-1. 난타 대기열 인원 계산
        cNantaQueue.forEach(item => {
            if (Array.isArray(item.players)) {
                nantaCount += item.players.filter(p => p && (typeof p === 'string' ? p.trim() !== '' : p.name)).length;
            } else if (item.players && typeof item.players === 'string') {
                nantaCount += item.players.split(',').filter(p => p.trim() !== '').length;
            } else if (item.user || item.username) {
                nantaCount += 1;
            }
        });

        // 4-2. 난타 코트 경기자 인원 계산
        cCourts.forEach(c => {
            if (c.type === 'nanta') {
                if (c.sideA && !c.sideA.isEmpty && c.sideA.players) {
                    nantaCount += (typeof c.sideA.players === 'string') ? c.sideA.players.split(',').filter(p => p.trim() !== '').length : 1;
                }
                if (c.sideB && !c.sideB.isEmpty && c.sideB.players) {
                    nantaCount += (typeof c.sideB.players === 'string') ? c.sideB.players.split(',').filter(p => p.trim() !== '').length : 1;
                }
            }
        });

        const totalConnected = loggedInUsers.size;
        const totalInGym = wifiUsers.size;

        const countPayload = {
            // 🏢 [멀티테넌트 수정] 클라이언트 구장 일치 검증용 clubId 동봉
            clubId: clubId,
            connected: totalConnected,
            inGym: totalInGym,
            game: gameCount,
            nanta: nantaCount,
            // 하위 호환성 유지
            club: totalInGym,
            total: totalConnected
        };

        // 🏢 [멀티테넌트 수정] targetClubId가 지정된 경우 해당 구장 방에만 전송 (미지정 시 전체 구장 개별 전송)
        if (!targetClubId || clubId === targetClubId) {
            io.to(roomName).emit('updateOnlineCount', countPayload);
        }

        // 슈퍼 관리자용 종합 데이터 수집
        superAdminSummary[clubId] = countPayload;
    });

    // 👑 슈퍼 관리자 페이지로 전체 클럽 통계 전송
    io.emit('updateSuperAdminCounts', superAdminSummary);
}

// 1. 전체 회원 명부 CSV 다운로드 라우트 (구장별 격리 적용)
app.get('/api/admin/download-excel', (req, res) => {
    const clubId = String(req.query.club || req.query.clubId || 'unjeong').trim();

    const sql = `
        SELECT * FROM regular_members
        WHERE club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = ''))
        ORDER BY name ASC
    `;

    db.all(sql, [clubId, clubId], (err, rows) => {
        if (err) {
            console.error('회원 조회 에러:', err);
            return res.status(500).send('데이터 조회 실패');
        }

        // CSV 파일 형식 생성 (UTF-8 BOM 추가하여 엑셀에서 한글 깨짐 방지)
        let csvContent = '\uFEFF이름,연락처,성별,생년월일,급수,주소\n';
        rows.forEach(m => {
            csvContent += `"${m.name || ''}","${m.phone || ''}","${m.gender || ''}","${m.birthDate || m.ageGroup || ''}","${m.grade || ''}","${m.address || ''}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=member_list_${encodeURIComponent(clubId)}.csv`);
        res.status(200).send(csvContent);
    });
});

// 2. 회원 명부 일괄 업로드(엑셀/CSV) 라우트 (구장별 격리 및 타 클럽 회원 보호)
app.post('/api/admin/upload-excel', upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.json({ success: false, message: '파일이 업로드되지 않았습니다.' });
    }

    const clubId = String(req.body.clubId || req.query.clubId || req.body.club || req.query.club || 'unjeong').trim();
    const filePath = req.file.path;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineCount = 0;
    const parsedRows = [];

    rl.on('line', (line) => {
        lineCount++;
        if (lineCount === 1) return; // 첫 줄(제목 행) 건너뜀

        const cols = line.split(',').map(val => val.replace(/^["']|["']$/g, '').trim());
        if (cols.length >= 2 && cols[0] && cols[1]) {
            const [name, rawPhone, gender = '', birthDate = '', grade = '초심', address = ''] = cols;

            let cleanPhone = rawPhone.replace(/[^0-9]/g, '');
            if (cleanPhone.length === 10 && cleanPhone.startsWith('10')) {
                cleanPhone = '0' + cleanPhone;
            }
            if (!cleanPhone) return;

            let formattedPhone = cleanPhone;
            if (cleanPhone.length === 11) {
                formattedPhone = `${cleanPhone.slice(0, 3)}-${cleanPhone.slice(3, 7)}-${cleanPhone.slice(7, 11)}`;
            } else if (cleanPhone.length === 10) {
                formattedPhone = `${cleanPhone.slice(0, 3)}-${cleanPhone.slice(3, 6)}-${cleanPhone.slice(6, 10)}`;
            }

            const ageGroup = typeof calculateAgeGroup === 'function' ? calculateAgeGroup(birthDate) : '';
            const uniqueId = `reg_${clubId}_${cleanPhone}`;

            parsedRows.push({
                uniqueId,
                name,
                cleanPhone,
                formattedPhone,
                gender,
                birthDate,
                ageGroup,
                grade: grade || '초심',
                address
            });
        }
    });

    rl.on('close', async () => {
        const runDb = (sql, params = []) => new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        let successCount = 0;
        try {
            await runDb('BEGIN TRANSACTION');

            for (const row of parsedRows) {
                // 💡 현재 구장(clubId)에 이미 등록된 회원만 갱신 (타 구장 동일 번호 회원은 건드리지 않음)
                const updateSql = `
                    UPDATE regular_members
                    SET name = ?, gender = ?, birthDate = ?, ageGroup = ?, grade = ?, phone = ?, address = ?, club_id = ?
                    WHERE (REPLACE(REPLACE(phone, '-', ''), ' ', '') = ? OR phone = ?)
                      AND (club_id = ? OR (? = 'unjeong' AND (club_id IS NULL OR club_id = '')))
                `;
                const upd = await runDb(updateSql, [
                    row.name, row.gender, row.birthDate, row.ageGroup, row.grade,
                    row.formattedPhone, row.address, clubId,
                    row.cleanPhone, row.formattedPhone, clubId, clubId
                ]);

                if (upd.changes > 0) {
                    successCount++;
                } else {
                    const insertSql = `
                        INSERT INTO regular_members (id, type, username, password, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt, club_id)
                        VALUES (?, 'regular', ?, '1234', ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?)
                    `;
                    await runDb(insertSql, [
                        row.uniqueId, row.formattedPhone, row.name, row.gender,
                        row.birthDate, row.ageGroup, row.grade, row.formattedPhone,
                        row.address, clubId
                    ]);
                    successCount++;
                }
            }

            await runDb('COMMIT');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

            console.log(`📁 [회원 명부 일괄 등록 완료 - ${clubId}] 총 ${successCount}명 반영`);
            res.json({ success: true, message: `총 ${successCount}명의 회원이 [${clubId}] 구장에 등록(갱신)되었습니다.` });
        } catch (err) {
            await runDb('ROLLBACK').catch(() => {});
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            console.error('회원 명부 일괄 등록 DB 오류:', err);
            res.json({ success: false, message: 'DB 저장 중 오류가 발생했습니다.' });
        }
    });
});

// ==========================
// 7. 서버 실행
// ==========================
server.listen(PORT, () => {
    console.log(`🚀 배드민턴 클럽 서버가 포트 ${PORT} 에서 실행 중입니다.`);
});