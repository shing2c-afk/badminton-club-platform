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

// 유저네임과 소켓 ID를 매핑하기 위한 객체 (이미 있다면 이어서 사용하세요)
// 유저별 연결 끊김 유예 타이머를 저장할 객체
const disconnectTimers = {};
const userSockets = {};
const expiredUsers = {}; // 유예 시간 초과로 만료된 유저를 기록할 객체
const UserDictionary = require('./userDictionary'); // 파일 경로에 맞게 설정

// 서버 전용 음성 안내 큐 및 상태 관리 변수
let serverAudioQueue = [];
let isVoicePlayingOnServer = false;
// ==========================================
// 🔊 서버 음성 큐 처리 프로세서 (약 10초 간격 순차 발송)
// ==========================================
setInterval(() => {
    // 이미 재생 중이거나 큐에 보낼 데이터가 없으면 대기
    if (isVoicePlayingOnServer || serverAudioQueue.length === 0) {
        return;
    }

    // 큐에서 가장 먼저 들어온 안내 건을 꺼냄
    const nextAnnouncement = serverAudioQueue.shift();
    
    // 재생 상태 플래그 켜기
    isVoicePlayingOnServer = true;

    // TV로 소켓 신호 발송
    io.to('tv-room').emit('requestVoiceAnnouncement', nextAnnouncement);

    // 안내 음성 재생 소요 시간(약 10초) 동안 다음 발송을 차단
    setTimeout(() => {
        isVoicePlayingOnServer = false;
    }, 10000); // 10초 (10000ms)

}, 1000); // 1초마다 큐 상태를 체크

// ==========================
// 2. 서버 및 미들웨어 초기화
// ==========================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server);

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

// 1. 정회원 가입 신청 접수 API
app.post('/api/register', async (req, res) => {
    try {
        const { name, phone, gender, birthDate, grade, address } = req.body; // 📌 address 받기

        if (!name || !phone || !gender || !birthDate || !grade) {
            return res.status(400).json({ success: false, message: '필수 항목을 모두 입력해주세요.' });
        }

        // 1단계: 이미 정회원(regular_members)으로 등록된 전화번호인지 확인
        db.get(`SELECT * FROM regular_members WHERE phone = ?`, [phone], (err, existingMember) => {
            if (existingMember) {
                return res.status(400).json({ success: false, message: '이미 정회원으로 가입되어 있는 연락처입니다.' });
            }

            // 2단계: 이미 대기 목록(pending_registrations)에 신청되어 있는 전화번호인지 확인
            db.get(`SELECT * FROM pending_registrations WHERE phone = ?`, [phone], (err, existingPending) => {
                if (existingPending) {
                    return res.status(400).json({ success: false, message: '이미 가입 대기 중인 연락처입니다. 관리자 승인을 기다려주세요.' });
                }

                // 3단계: 중복이 없다면 주소까지 포함해서 대기 테이블에 INSERT
                const createdAt = new Date().toISOString();
                const query = `INSERT INTO pending_registrations (name, phone, gender, birthDate, grade, address, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`;
                
                db.run(query, [name, phone, gender, birthDate, grade, address || '', createdAt], function(err) {
                    if (err) {
                        console.error('가입 신청 DB 저장 오류:', err.message);
                        return res.status(500).json({ success: false, message: '데이터베이스 저장 중 오류가 발생했습니다.' });
                    }
                    res.json({ success: true, message: '정회원 가입 신청이 완료되었습니다. 관리자 승인을 기다려주세요.' });
                });
            });
        });
    } catch (error) {
        console.error('가입 신청 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 2. 관리자용: 가입 신청 대기 목록 조회 API (SQLite 조회 구현)
app.get('/api/admin/pending-members', async (req, res) => {
    try {
        db.all(`SELECT * FROM pending_registrations WHERE status = 'pending'`, [], (err, rows) => {
            if (err) {
                console.error('대기 목록 조회 오류:', err.message);
                return res.status(500).json({ success: false, message: '데이터베이스 조회 중 오류가 발생했습니다.' });
            }
            res.json({ success: true, data: rows });
        });
    } catch (error) {
        console.error('대기 목록 조회 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

// 3. 관리자용: 가입 신청 승인 처리 API
app.post('/api/admin/approve-member', async (req, res) => {
    try {
        const { phone, action } = req.body;

        if (!phone || !action) {
            return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
        }

        if (action === 'approve') {
            db.get(`SELECT * FROM pending_registrations WHERE phone = ?`, [phone], (err, user) => {
                if (err || !user) {
                    return res.status(404).json({ success: false, message: '신청 내역을 찾을 수 없습니다.' });
                }

                // 생년월일로부터 연령대 자동 계산 ("50대" 형태로 반환된다고 가정)
                const ageGroup = calculateAgeGroup(user.birthDate);
                const memberId = 'reg_' + Date.now();
                const joinedAt = new Date().toISOString().split('T')[0];
                
                const insertQuery = `
                    INSERT INTO regular_members (id, type, username, password, name, gender, birthDate, ageGroup, grade, phone, address, joinedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                // 물음표 12개에 대응하는 파라미터 12개 정확히 매칭
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
                    joinedAt            // 12. joinedAt
                ];

                db.run(insertQuery, params, (insertErr) => {
                    if (insertErr) {
                        console.error('정회원 테이블 등록 오류:', insertErr.message);
                        if (insertErr.message.includes('UNIQUE constraint failed')) {
                            return res.status(400).json({ success: false, message: '이미 동일한 연락처로 등록된 정회원이 존재합니다.' });
                        }
                        return res.status(500).json({ success: false, message: '정회원 등록 중 오류가 발생했습니다.' });
                    }

                    db.run(`DELETE FROM pending_registrations WHERE phone = ?`, [phone], () => {
                        res.json({ success: true, message: '정회원 가입이 승인되었습니다.' });
                    });
                });
            });
        } else {
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

// 4. 정회원 탈퇴 처리 API (수정본)
app.post('/api/member/withdraw', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, message: '회원 정보를 확인할 수 없습니다.' });
        }

        // 1. regular_members 테이블에서 삭제
        db.run(`DELETE FROM regular_members WHERE phone = ?`, [phone], function(err) {
            if (err) {
                console.error('회원 탈퇴 처리 오류 (regular_members):', err.message);
                return res.status(500).json({ success: false, message: '탈퇴 처리 중 서버 오류가 발생했습니다.' });
            }

            // 2. 혹시 남아있을 수 있는 pending_registrations 대기/신청 데이터도 함께 깔끔하게 삭제
            db.run(`DELETE FROM pending_registrations WHERE phone = ?`, [phone], (pendingErr) => {
                if (pendingErr) {
                    console.error('대기 테이블 정리 오류:', pendingErr.message);
                }

                console.log(`🗑️ [회원 탈퇴 및 이력 정리 완료]: 전화번호 ${phone}`);
                res.json({ success: true, message: '정상적으로 탈퇴 처리되었습니다.' });
            });
        });
    } catch (error) {
        console.error('회원 탈퇴 오류:', error);
        res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
    }
});

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
            phone TEXT UNIQUE,
            address TEXT,
            joinedAt TEXT
        )
    `, (err) => {
        if (!err) {
            // 혹시 기존 테이블에 컬럼이 없어 에러가 나는 경우를 대비해 안전하게 컬럼 추가 시도
            db.run(`ALTER TABLE regular_members ADD COLUMN username TEXT`, () => {});
            db.run(`ALTER TABLE regular_members ADD COLUMN password TEXT`, () => {});
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

    // 📌 정회원 가입 신청 대기 테이블 생성
    db.run(`
        CREATE TABLE IF NOT EXISTS pending_registrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            gender TEXT,
            birthDate TEXT,
            grade TEXT,
            address TEXT, 
            status TEXT DEFAULT 'pending',
            createdAt TEXT NOT NULL
        )
    `, (err) => {
        if (!err) {
            // 📌 테이블이 이미 있거나 해서 address 컬럼이 누락된 경우를 대비해 안전하게 추가 시도
            db.run(`ALTER TABLE pending_registrations ADD COLUMN address TEXT`, () => {});
        }
    });

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

// ==========================
// [추가] 공지사항 관련 API 및 라우트
// ==========================

// 1. 공지사항 목록 조회 API (인덱스 화면 및 게시판용)
app.get('/api/notices', (req, res) => {
    db.all(`SELECT * FROM notices ORDER BY id DESC`, (err, rows) => {
        if (err) {
            console.error('❌ 공지사항 조회 실패:', err.message);
            return res.status(500).json({ success: false, message: '공지사항을 불러오지 못했습니다.' });
        }
        res.json(rows);
    });
});

// 2. 관리자용 공지사항 등록 API
app.post('/api/admin/notice', (req, res) => {
    const { title, content, author } = req.body;
    if (!title || !content) {
        return res.status(400).json({ success: false, message: '제목과 내용을 모두 입력해 주세요.' });
    }

    const createdAt = new Date().toISOString().split('T')[0];
    db.run(`INSERT INTO notices (title, content, author, createdAt) VALUES (?, ?, ?, ?)`,
        [title, content, author || '관리자', createdAt],
        function(err) {
            if (err) {
                console.error('❌ 공지 등록 실패:', err.message);
                return res.status(500).json({ success: false, message: '공지 등록 중 오류가 발생했습니다.' });
            }
            
            const newNotice = { id: this.lastID, title, content, author: author || '관리자', createdAt };

            // 📌 [핵심 추가] 연결된 모든 클라이언트(인덱스, TV 등)에게 실시간 공지 전송!
            io.emit('noticeUpdated', newNotice);

            res.json({ success: true, message: '공지사항이 성공적으로 등록되었습니다.', id: this.lastID });
        }
    );
});

// 3. 공지사항 상세 게시판 페이지 라우트
app.get('/notice', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'notice.html'));
});

// 1. 회원 목록 조회 API (어드민 드롭다운 및 게임방 연동용)
app.get('/api/members', (req, res) => {
    // 📌 ageGroup 계산을 위해 birthDate 컬럼을 함께 조회합니다.
    db.all(`SELECT id, username, name, gender, birthDate, ageGroup, grade, phone, address FROM regular_members`, (err, rows) => {
        if (err) {
            console.error('❌ 회원 목록 조회 실패:', err.message);
            return res.status(500).json({ success: false, error: '데이터베이스 조회 실패', message: '회원 목록을 불러오지 못했습니다.' });
        }

        // 📌 DB에 ageGroup이 누락되어 있거나 비어 있는 경우 생년월일(birthDate)로 실시간 계산
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

// 3. 🧹 [안전하고 완벽한 마스터 키 기반 슬롯 청소 함수]
async function cleanupUser(usernameOrObj) {
    if (!usernameOrObj) return;

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

    console.log(`🧹 [청소 타겟 분석] 입력값:`, usernameOrObj);

    // DB에서 해당 유저의 정확한 정보(이름, ID 등)를 확실하게 조회
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

    console.log(`🎯 [확정된 청소 대상] ID: "${realId}", Name: "${realName}"`);

    // 게임 대기열 정리
    if (typeof gameQueue !== 'undefined' && Array.isArray(gameQueue)) {
        const validGameQueue = gameQueue.filter(slot => {
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

            const hasValidPlayers = slot.players && slot.players.some(p => String(p || '').trim() !== '' && String(p) !== 'undefined');
            const hasValidIds = slot.userIds && slot.userIds.some(id => String(id || '').trim() !== '' && String(id) !== 'undefined');
            return hasValidPlayers || hasValidIds;
        });
        gameQueue.length = 0;
        gameQueue.push(...validGameQueue);
    }

    // 난타 대기열 정리
    if (typeof nantaQueue !== 'undefined' && Array.isArray(nantaQueue)) {
        const validNantaQueue = nantaQueue.filter(slot => {
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

            const hasRemainingPlayers = slot.players && slot.players.some(p => String(p || '').trim() !== '' && String(p) !== 'undefined');
            const hasRemainingIds = slot.userIds && slot.userIds.some(id => String(id || '').trim() !== '' && String(id) !== 'undefined');
            return hasRemainingPlayers || hasRemainingIds;
        });
        nantaQueue.length = 0;
        nantaQueue.push(...validNantaQueue);
    }

    if (typeof broadcastState === 'function') {
        broadcastState();
        console.log('📢 [디버깅] 대기열 청소 후 broadcastState() 실행 완료');
    } else if (typeof io !== 'undefined') {
        io.emit('updateState', { gameQueue, nantaQueue });
        console.log('📢 [디버깅] io.emit을 통한 대기열 상태 강제 브로드캐스트 완료');
    } else {
        console.log('⚠️ [디버깅 경고] 브로드캐스트 수단을 찾을 수 없습니다!');
    }
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

    if (!target) {
        console.log('❌ [관리자 강제 퇴장 실패] 전달된 회원 식별자가 없습니다.', req.body);
        return res.status(400).json({ success: false, message: '퇴장시킬 회원 정보가 없습니다.' });
    }

    console.log(`🚨 [관리자 강제 퇴장 요청] 타겟 식별자:`, target);

    // 비동기 청소 완료를 기다림
    await cleanupUser(target);

    res.json({ success: true, message: `해당 회원을 성공적으로 강제 퇴장 및 정리했습니다.` });
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
            
            // 경과 시간 및 남은 시간 계산 (1번만 선언)
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            // 💡 타이머 시작 후 정확히 30초가 지났을 때 음성 안내 및 개인 팝업 전송
            if (elapsed === 30 && !slot.announced) {
                slot.announced = true;
                const validPlayers = getValidPlayers(slot.players);
                const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                
                // activeTimerCount 순서에 맞는 빈 코트를 정확히 매칭
                const emptyGameCourts = courtsData.filter(c => c.type === 'game' && c.isEmpty);
                const targetCourt = emptyGameCourts[activeTimerCount - 1] || emptyGameCourts[0];
                const courtNum = targetCourt ? targetCourt.id : '';

                // 🚀 음성 안내 큐 푸시
                serverAudioQueue.push({
                    courtNumber: courtNum,
                    names: memberNames,
                    matchType: '게임'
                });

                // 📱 [추가] 해당 대기방 회원들에게 입장 촉구 팝업 전송
                io.emit('entryPopupAlert', {
                    matchType: '게임',
                    courtNumber: courtNum,
                    targetPlayers: memberNames
                });
            }

            // --- 게임 대기열 시간 초과 처리부 ---
            if (slot.remainingSeconds === 0) {
                const targetIdx = gameQueue.findIndex(s => s.id === slot.id);
                if (targetIdx !== -1) {
                    const expiredTeam = gameQueue.splice(targetIdx, 1)[0];
                    const validPlayers = getValidPlayers(expiredTeam.players);
                    const memberNames = validPlayers.map(p => p.split('/')[0].trim());

                    // 🖥️ TV 전광판에 대기방 삭제 팝업 전송
                    io.to('tv-room').emit('tvPopupAlert', {
                        matchType: '게임',
                        names: memberNames,
                        message: '입장 시간 초과로 게임 대기방이 삭제되었습니다.<br>게임 대기를 원하시면 다시 등록해 주세요.'
                    });

                    addNotification(`🗑️ [게임 대기방 삭제] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열에서 삭제되었습니다.`);
                }
            }
        } else {
            slot.fullAt = null;
            slot.remainingSeconds = null;
            slot.announced = false;
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

            // 경과 시간 및 남은 시간 계산
            const elapsed = Math.floor((now - slot.fullAt) / 1000);
            slot.remainingSeconds = Math.max(0, config.ENTRY_TIMEOUT_SEC - elapsed);

            // 💡 난타 타이머 시작 후 정확히 30초가 지났을 때 음성 안내 및 개인 팝업 전송
            if (elapsed === 30 && !slot.announced) {
                slot.announced = true;
                const validPlayers = getValidPlayers(slot.players);
                const memberNames = validPlayers.map(p => p.split('/')[0].trim());
                
                // 비어있는 난타 반코트들을 순서대로 수집하여 activeNantaTimerCount에 맞게 매칭
                let availableSides = [];
                for (let court of courtsData) {
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

                // 🚀 음성 안내 큐 푸시
                serverAudioQueue.push({
                    courtNumber: targetCourtNum,
                    names: memberNames,
                    matchType: '난타'
                });

                // 📱 [추가] 해당 대기방 회원들에게 입장 촉구 팝업 전송
                io.emit('entryPopupAlert', {
                    matchType: '난타',
                    courtNumber: targetCourtNum,
                    targetPlayers: memberNames
                });
            }

            // --- 난타 대기열 시간 초과 처리부 ---
            if (slot.remainingSeconds === 0) {
                const index = nantaQueue.findIndex(s => s.id === slot.id);
                if (index !== -1) {
                    const expiredTeam = nantaQueue.splice(index, 1)[0];
                    const validPlayers = getValidPlayers(expiredTeam.players);
                    const memberNames = validPlayers.map(p => p.split('/')[0].trim());

                    // 🖥️ TV 전광판에 대기방 삭제 팝업 전송
                    io.to('tv-room').emit('tvPopupAlert', {
                        matchType: '난타',
                        names: memberNames,
                        message: '입장 시간 초과로 난타 대기방이 삭제되었습니다.<br>난타 대기를 원하시면 다시 등록해 주세요.'
                    });

                    addNotification(`🗑️ [난타 대기방 삭제] ${expiredTeam.players.join(', ')} 팀의 입장 시간이 초과되어 대기열에서 삭제되었습니다.`);
                }
            }
        } else {
            slot.fullAt = null;
            slot.remainingSeconds = null;
            slot.announced = false;
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

   socket.on('loginMember', ({ name, phone }, callback) => {
        const trimmedName = name ? name.trim() : '';
        const cleanInputPhone = phone ? phone.replace(/[^0-9]/g, '') : '';

        if (!trimmedName || !cleanInputPhone) {
            return callback({ success: false, message: '이름과 전화번호를 모두 입력해 주세요.' });
        }

        const query = `SELECT * FROM regular_members WHERE TRIM(name) = ? AND REPLACE(REPLACE(phone, '-', ''), ' ', '') = ?`;

        db.get(query, [trimmedName, cleanInputPhone], (err, row) => {
            if (err) {
                console.error('❌ 로그인 DB 조회 에러:', err.message);
                return callback({ success: false, message: '서버 에러가 발생했습니다.' });
            }

            if (!row) {
                return callback({ success: false, message: '등록된 정회원 정보가 일치하지 않습니다.' });
            }

            // 값이 없을 경우를 대비한 안전한 기본값 처리
            const genderStr = row.gender ? row.gender : '미입력';
            const ageGroupStr = row.ageGroup ? row.ageGroup : '일반';
            const gradeStr = row.grade ? row.grade : '초심';

            const user = {
                id: row.id,
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

   socket.on('registerUserSession', (userData) => {
        if (userData) {
            // 객체든 문자열이든 안전한 문자열 식별자(userKey) 추출
            let userKey = '';
            if (typeof userData === 'object' && userData !== null) {
                userKey = userData.id || userData.username || userData.name || '';
            } else {
                userKey = String(userData);
            }

            if (!userKey) {
                console.log(`❌ [세션 등록 실패] 유효한 유저 식별자를 찾을 수 없습니다.`);
                return;
            }

            // 만약 유예 시간이 지나서 만료된 유저 명단에 있는 아이디라면?
            if (expiredUsers[userKey]) {
                console.log(`🚫 [세션 만료 차단] 유저 [${userKey}]님은 유예 시간 초과로 만료되어 강제 로그아웃됩니다.`);
                
                // 클라이언트로 강제 로그아웃 신호 전송
                socket.emit('forceLogout', { username: userKey, reason: 'timeout' });
                
                // 만료 명단에서 제거
                delete expiredUsers[userKey];
                return; // 로그인 등록을 더 이상 진행하지 않음
            }

            socket.username = userData;
            userSockets[socket.id] = userKey;
            
            // 정상적인 재접속인 경우 타이머 취소
            if (disconnectTimers[userKey]) {
                clearTimeout(disconnectTimers[userKey]);
                delete disconnectTimers[userKey];
                console.log(`🔄 [재접속 성공] 유저 [${userKey}]님이 유예 시간 내에 돌아와 대기열 유지가 확정되었습니다.`);
            }

            console.log(`👤 [소켓 등록] 유저 ${userKey}의 소켓(ID: ${socket.id})이 매핑되었습니다.`);
        }
    });

    socket.on('disconnect', () => {
    const rawUser = userSockets[socket.id] || socket.username;
    const currentSocketId = socket.id;
    
    if (rawUser) {
        // 객체든 문자열이든 타이머 키로 쓸 수 있는 안전한 문자열 추출
        let userKey = '';
        if (typeof rawUser === 'object' && rawUser !== null) {
            userKey = rawUser.id || rawUser.username || rawUser.name || '';
        } else {
            userKey = String(rawUser);
        }

        if (!userKey) {
            console.log(`🔌 [연결 끊김] 소켓 ID: ${currentSocketId} - 유저 식별자 추출 실패`);
            return;
        }

        console.log(`🔌 [연결 끊김] 소켓 ID: ${currentSocketId} (유저: ${userKey}) 연결 해제됨. 유예 타이머(1분) 작동 시작...`);
        
        // 만약 이 유저 명의로 된 기존 타이머가 있다면 초기화
        if (disconnectTimers[userKey]) {
            clearTimeout(disconnectTimers[userKey]);
        }

        disconnectTimers[userKey] = setTimeout(() => {
            console.log(`⏳ [유예 시간 만료] 유저 [${userKey}]님이 오랜 시간 돌아오지 않아 대기열 퇴장을 진행합니다.`);
            
            // 1. 대기열 및 방 정리 (앞서 만든 강력 청소 함수 호출)
            cleanupUser(rawUser);

            // 2. 만료된 유저 명단에 등록
            expiredUsers[userKey] = true;

            // 3. 타이머 및 매핑 정리
            delete disconnectTimers[userKey];
            delete userSockets[currentSocketId];
        }, 3 * 60 * 1000); // 3분 유예 시간(정해진 시간동안 웹 동작이 없으면 자동 로그아웃처리)
        
    } else {
        console.log(`🔌 [연결 끊김] 매핑된 유저가 없는 소켓 ID: ${socket.id} 연결 해제됨`);
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

// 파일 하단 (기존 API 라우트들 아래)
app.get('/api/admin/members/export', (req, res) => {
    db.all("SELECT * FROM regular_members", [], (err, rows) => {
        if (err) {
            console.error('회원 조회 에러:', err);
            return res.json({ success: false, message: '데이터 조회 실패' });
        }
        res.json({ success: true, members: rows });
    });
});

app.post('/api/admin/members/import', upload.single('csvFile'), async (req, res) => {
    if (!req.file) {
        return res.json({ success: false, message: '파일이 업로드되지 않았습니다.' });
    }

    const filePath = req.file.path;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lineCount = 0;
    let successCount = 0;

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        // phone을 기준으로 충돌(Conflict)이 나면 기존 데이터를 UPDATE하는 강력한 문법
        const stmt = db.prepare(`
            INSERT INTO regular_members (id, type, username, password, name, gender, birthDate, grade, phone, address, joinedAt) 
            VALUES (?, 'regular', ?, '1234', ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(phone) DO UPDATE SET 
                name = excluded.name,
                gender = excluded.gender,
                birthDate = excluded.birthDate,
                grade = excluded.grade,
                address = excluded.address
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

                // 고유 ID와 로그인용 username 생성 (전화번호 뒷자리나 타임스탬프 활용)
                const uniqueId = 'reg_' + cleanPhone;
                const username = 'user_' + cleanPhone;

                stmt.run(uniqueId, username, name, gender, birthDate, grade, cleanPhone, address, (err) => {
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
                res.json({ success: true, message: `총 ${successCount}명의 회원이 등록(갱신)되었습니다.` });
            });
        });
    });
});

// ==========================
// 7. 서버 실행
// ==========================
server.listen(PORT, () => {
    console.log(`🚀 배드민턴 클럽 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});