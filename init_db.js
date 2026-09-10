const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'badminton.db');

console.log('🔄 데이터베이스 초기화 스크립트를 시작합니다...');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 데이터베이스 연결 실패:', err.message);
        return;
    }
    console.log('✅ SQLite 데이터베이스(badminton.db) 연결 성공');
    initDatabase();
});

function initDatabase() {
    db.serialize(() => {
        // 기존 테이블 삭제 후 재생성
        db.run(`DROP TABLE IF EXISTS regular_members`);
        db.run(`DROP TABLE IF EXISTS pending_members`);

        // 1. 정회원 테이블 생성 (phone에 UNIQUE 제약 조건 추가)
        db.run(`
            CREATE TABLE regular_members (
                id TEXT PRIMARY KEY,
                type TEXT,
                username TEXT UNIQUE,
                password TEXT,
                name TEXT,
                phone TEXT UNIQUE,
                gender TEXT,
                birthDate TEXT,
                ageGroup TEXT,
                grade TEXT,
                address TEXT,
                joinedAt TEXT
            )
        `, (err) => {
            if (err) {
                console.error('❌ 정회원 테이블 생성 실패:', err.message);
                return;
            }
            console.log('✅ regular_members 테이블 생성 완료');
        });

        // 2. 승인 대기 회원 테이블 생성
        db.run(`
            CREATE TABLE pending_members (
                id TEXT PRIMARY KEY,
                name TEXT,
                phone TEXT UNIQUE,
                gender TEXT,
                birthDate TEXT,
                ageGroup TEXT,
                grade TEXT,
                address TEXT,
                requestedAt TEXT
            )
        `, (err) => {
            if (err) {
                console.error('❌ 승인 대기 테이블 생성 실패:', err.message);
                return;
            }
            console.log('✅ pending_members (승인 대기) 테이블 생성 완료');
            createAdminAccount();
        });
    });
}

function createAdminAccount() {
    // 기본 관리자 계정 추가
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO regular_members (id, type, username, password, name, phone, gender, birthDate, ageGroup, grade, address, joinedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run("reg_admin", "admin", "admin", "1234", "관리자", "010-0000-0000", "남", "1975-01-01", "50대", "A조", "경기도 파주시", "2023-01-01", (err) => {
        if (err) {
            console.error('❌ 관리자 계정 생성 실패:', err.message);
        } else {
            console.log('✨ 기본 관리자 계정(reg_admin)이 생성되었습니다.');
        }
        stmt.finalize();
        db.close(() => {
            console.log('🔌 데이터베이스 초기화 작업이 완료되었습니다.');
        });
    });
}