const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const excelPath = path.resolve(__dirname, 'members.xlsx');
const dbPath = path.resolve(__dirname, 'badminton.db');

console.log('🔄 엑셀 파일 기반 정회원 DB 초기화 스크립트를 시작합니다...');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 데이터베이스 연결 실패:', err.message);
        return;
    }
    console.log('✅ SQLite 데이터베이스(badminton.db) 연결 성공');
    initAndImportData();
});

function initAndImportData() {
    db.serialize(() => {
        // 기존 테이블 삭제 후 재생성
        db.run(`DROP TABLE IF EXISTS regular_members`, (err) => {
            if (err) {
                console.error('❌ 기존 테이블 삭제 실패:', err.message);
                return;
            }

            // [수정] ageGroup 컬럼 추가
            db.run(`
                CREATE TABLE regular_members (
                    id TEXT PRIMARY KEY,
                    type TEXT,
                    name TEXT,
                    phone TEXT,
                    gender TEXT,
                    birthDate TEXT,
                    ageGroup TEXT,
                    grade TEXT,
                    address TEXT,
                    joinedAt TEXT
                )
            `, (err) => {
                if (err) {
                    console.error('❌ 테이블 생성 실패:', err.message);
                    return;
                }
                console.log('✅ regular_members 테이블 새로 생성 완료');
                processExcelData();
            });
        });
    });
}

function processExcelData() {
    try {
        if (!fs.existsSync(excelPath)) {
            console.error(`❌ 엑셀 파일을 찾을 수 없습니다: ${excelPath}`);
            db.close();
            return;
        }

        const workbook = xlsx.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);

        if (!rows || rows.length === 0) {
            console.log('⚠️ 엑셀 파일에 데이터가 없습니다.');
            db.close();
            return;
        }

        console.log(`📦 엑셀에서 ${rows.length}명의 회원 데이터를 읽었습니다. DB 적재를 시작합니다...`);

        // 관리자 계정 추가
        const adminStmt = db.prepare(`
            INSERT OR REPLACE INTO regular_members (id, type, name, phone, gender, birthDate, ageGroup, grade, address, joinedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        adminStmt.run("reg_admin", "admin", "관리자", "010-0000-0000", "남", "1975-01-01", "50대", "A조", "경기도 파주시", "2023-01-01");
        adminStmt.finalize();

        // 엑셀 데이터 매핑 INSERT
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO regular_members (id, type, name, phone, gender, birthDate, ageGroup, grade, address, joinedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        rows.forEach((m, index) => {
            const padNum = String(index + 1).padStart(2, '0');
            const id = `reg_${padNum}`;
            const type = 'regular';
            
            const name = m.name || `회원${index + 1}`;
            const phone = m.phone || m.id || `010-1111-${padNum}${padNum}`;
            const gender = m.gender || '남';
            const birthDate = m.birth || '1990-01-01';
            
            // [추가] 생년월일 기반 연령대 자동 계산 (예: 1990년생 -> 30대)
            const birthYear = parseInt(String(birthDate).substring(0, 4)) || 1990;
            const age = 2026 - birthYear;
            const ageGroup = m.ageGroup || `${Math.floor(age / 10) * 10}대`;

            const grade = m.grade || '초심';
            const address = m.address || '경기도 파주시';
            const joinedAt = '2026-01-01';

            stmt.run(id, type, name, phone, gender, birthDate, ageGroup, grade, address, joinedAt);
        });

        stmt.finalize(() => {
            console.log('✨ 엑셀 회원 데이터가 데이터베이스에 성공적으로 모두 적재되었습니다!');
            db.close();
        });

    } catch (error) {
        console.error('❌ 엑셀 처리 중 에러 발생:', error.message);
        db.close();
    }
}