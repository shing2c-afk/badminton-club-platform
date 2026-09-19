const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// 💡 server.js와 동일한 영구 디스크 경로 적용
const DATA_DIR = process.env.RENDER ? '/var/data' : __dirname;
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'badminton.db');

console.log('🔄 데이터베이스 초기화(또는 연결) 스크립트를 시작합니다...');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 데이터베이스 연결 실패:', err.message);
        return;
    }
    console.log('✅ SQLite 데이터베이스 연결 성공:', dbPath);
    initDatabase();
});

function initDatabase() {
    db.serialize(() => {
        // ⚠️ 주의: 기존 데이터를 보존하기 위해 DROP TABLE을 제거하고 CREATE TABLE IF NOT EXISTS 사용

        // 1. 정회원 테이블 생성
        db.run(`
            CREATE TABLE IF NOT EXISTS regular_members (
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
            console.log('✅ regular_members 테이블 준비 완료');
        });

        // 2. 승인 대기 회원 테이블 생성
        db.run(`
            CREATE TABLE IF NOT EXISTS pending_members (
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
            console.log('✅ pending_members (승인 대기) 테이블 준비 완료');
            createAdminAccount();
        });
    });
}

function createAdminAccount() {
    // 기본 관리자 계정 추가 (이미 존재하면 무시 또는 갱신)
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO regular_members (id, type, username, password, name, phone, gender, birthDate, ageGroup, grade, address, joinedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run("reg_admin", "admin", "admin", "1234", "관리자", "010-0000-0000", "남", "1975-01-01", "50대", "A조", "경기도 파주시", "2023-01-01", (err) => {
        if (err) {
            console.error('❌ 관리자 계정 확인/생성 실패:', err.message);
        } else {
            console.log('✨ 기본 관리자 계정(reg_admin)이 안전하게 유지(또는 생성)되었습니다.');
        }
        stmt.finalize();
        db.close(() => {
            console.log('🔌 데이터베이스 초기화 작업이 안전하게 완료되었습니다.');
        });
    });
}