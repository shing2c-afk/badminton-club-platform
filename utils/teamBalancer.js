// ============================================================================
// 🏸 오늘민턴 복식 팀 자동 밸런싱 참조 모듈 (utils/teamBalancer.js)
// - 상단 BALANCE_CONFIG의 수치만 수정하여 실전 운영 중 언제든 튜닝 가능합니다.
// ============================================================================

const BALANCE_CONFIG = {
    // 1. 급수별 기본 점수 (최우선 뼈대)
    gradeScores: {
        '초심': 100,
        'D조': 200,
        'C조': 300,
        'B조': 400,
        'A조': 500,
        'S조': 600,
        '자강': 700
    },

    // 일일회원 또는 급수 미입력 회원 기본 점수 (D조~C조 중간 수준)
    guestDefaultScore: 250,

    // 2. 성별 보정 점수 (미입력 시 중립 0점)
    genderAdjust: {
        '남': 20,
        '여': -20
    },

    // 3. 연령대 보정 점수 (40대 기준 0점, 미입력 시 중립 0점)
    ageGroupAdjust: {
        '10대': 15,
        '20대': 25,
        '30대': 15,
        '40대': 0,
        '50대': -15,
        '60대': -30,
        '70대': -45,
        '80대': -55
    },

    // 4. 경기 기록(승률·득실차) 보정 설정
    stats: {
        minGamesForStats: 5,      // 최소 5경기 이상 치른 회원부터 기록 보정 적용
        fullWeightGames: 15,      // 15경기 이상이면 기록 보정 100% 반영 (5~15경기는 비례 반영)
        maxWinRateBonus: 35,      // 승률 보정 최대 폭 (50% 기준 +-35점)
        pointDiffMultiplier: 2.5, // 경기당 평균 득실차 1점당 가감 점수
        maxPointDiffBonus: 25     // 득실차 보정 최대 폭 (+-25점)
    },

    // 5. 남2·여2 혼복 우선 편성 여부
    preferMixedDoubles: true
};

/**
 * 성별 문자열 정규화 ('남', '여', 또는 null)
 */
function normalizeGender(gender) {
    if (!gender) return null;
    const g = String(gender).trim();
    if (g === '남' || g === '남자' || g.toUpperCase() === 'M') return '남';
    if (g === '여' || g === '여자' || g.toUpperCase() === 'F') return '여';
    return null;
}

/**
 * 급수 문자열 정규화 ('A조', '초심' 등)
 */
function normalizeGrade(grade) {
    if (!grade) return null;
    const g = String(grade).trim().toUpperCase();
    if (g === '초심' || g === '입문') return '초심';
    if (g === '자강') return '자강';
    if (['S', 'A', 'B', 'C', 'D'].includes(g)) return `${g}조`;
    return String(grade).trim();
}

/**
 * 연령대 문자열 정규화 ('20대', '40대' 등, 미입력 시 null)
 */
function normalizeAgeGroup(ageGroup, birthDate) {
    if (ageGroup && BALANCE_CONFIG.ageGroupAdjust[String(ageGroup).trim()] !== undefined) {
        return String(ageGroup).trim();
    }
    // ageGroup이 없고 생년월일(8자리)이 있는 경우 자동 계산
    const cleanBirth = String(birthDate || '').replace(/[^0-9]/g, '');
    if (cleanBirth.length === 8) {
        const birthYear = parseInt(cleanBirth.slice(0, 4), 10);
        const currentYear = new Date().getFullYear();
        const age = currentYear - birthYear;
        if (age >= 10 && age < 90) {
            const decade = Math.floor(age / 10) * 10;
            return `${decade}대`;
        }
    }
    return null;
}

/**
 * 개별 플레이어 종합 전투력 점수 계산
 * player 객체 예시: { name, grade, gender, ageGroup, birthDate, wins, losses, pointDiff, isGuest }
 */
function calculatePlayerScore(player = {}) {
    const grade = normalizeGrade(player.grade);
    const gender = normalizeGender(player.gender);
    const ageGroup = normalizeAgeGroup(player.ageGroup, player.birthDate);

    // 1) 급수 기본 점수 (미입력/일일회원은 기본값)
    const baseScore = (grade && BALANCE_CONFIG.gradeScores[grade] !== undefined)
        ? BALANCE_CONFIG.gradeScores[grade]
        : BALANCE_CONFIG.guestDefaultScore;

    // 2) 성별 보정 (미입력 시 0)
    const genderScore = (gender && BALANCE_CONFIG.genderAdjust[gender] !== undefined)
        ? BALANCE_CONFIG.genderAdjust[gender]
        : 0;

    // 3) 연령대 보정 (미입력 시 0)
    const ageScore = (ageGroup && BALANCE_CONFIG.ageGroupAdjust[ageGroup] !== undefined)
        ? BALANCE_CONFIG.ageGroupAdjust[ageGroup]
        : 0;

    // 4) 경기 기록 보정 (최소 경기 수 안전장치 적용)
    let statsScore = 0;
    const wins = Number(player.wins) || 0;
    const losses = Number(player.losses) || 0;
    const totalGames = wins + losses;
    const totalPointDiff = Number(player.pointDiff) || 0;

    if (!player.isGuest && totalGames >= BALANCE_CONFIG.stats.minGamesForStats) {
        // 경기 수에 따른 신뢰도 계수 (0.0 ~ 1.0)
        const reliability = Math.min(1, totalGames / BALANCE_CONFIG.stats.fullWeightGames);

        // 승률 보정 (50%를 0점으로 기준)
        const winRate = wins / totalGames;
        const rawWinBonus = (winRate - 0.5) * 2 * BALANCE_CONFIG.stats.maxWinRateBonus;

        // 평균 득실차 보정
        const avgDiff = totalPointDiff / totalGames;
        const rawDiffBonus = Math.max(
            -BALANCE_CONFIG.stats.maxPointDiffBonus,
            Math.min(BALANCE_CONFIG.stats.maxPointDiffBonus, avgDiff * BALANCE_CONFIG.stats.pointDiffMultiplier)
        );

        statsScore = Math.round((rawWinBonus + rawDiffBonus) * reliability);
    }

    const totalScore = Math.round(baseScore + genderScore + ageScore + statsScore);

    return {
        ...player,
        normalizedGender: gender,
        balanceScore: totalScore,
        scoreBreakdown: {
            baseScore,
            genderScore,
            ageScore,
            statsScore
        }
    };
}

/**
 * 4명의 플레이어를 받아 최적의 복식 팀(teamA, teamB)으로 분배
 * @param {Array} players - 4명의 플레이어 객체 배열
 * @returns {Object} { teamA, teamB, teamAScore, teamBScore, scoreDiff, isMixedDoubles }
 */
function balanceTeams(players) {
    if (!Array.isArray(players) || players.length !== 4) {
        return {
            teamA: (players || []).slice(0, 2),
            teamB: (players || []).slice(2, 4),
            teamAScore: 0,
            teamBScore: 0,
            scoreDiff: 0,
            isMixedDoubles: false
        };
    }

    // 각 플레이어 점수 계산
    const scored = players.map(calculatePlayerScore);

    // 남2·여2 여부 판별 (성별 미입력자가 1명이라도 있으면 혼복 규칙 건너뜀)
    const males = scored.filter(p => p.normalizedGender === '남');
    const females = scored.filter(p => p.normalizedGender === '여');
    const isMixedCandidate = BALANCE_CONFIG.preferMixedDoubles && males.length === 2 && females.length === 2;

    let combinations = [];

    if (isMixedCandidate) {
        // 혼복 2가지 조합만 후보로 선정
        combinations = [
            { teamA: [males[0], females[0]], teamB: [males[1], females[1]] },
            { teamA: [males[0], females[1]], teamB: [males[1], females[0]] }
        ];
    } else {
        // 일반 복식 3가지 조합 모두 비교
        combinations = [
            { teamA: [scored[0], scored[1]], teamB: [scored[2], scored[3]] },
            { teamA: [scored[0], scored[2]], teamB: [scored[1], scored[3]] },
            { teamA: [scored[0], scored[3]], teamB: [scored[1], scored[2]] }
        ];
    }

    // 양 팀 총점 차이가 가장 적은 조합 선택
    let best = null;
    for (const combo of combinations) {
        const teamAScore = combo.teamA[0].balanceScore + combo.teamA[1].balanceScore;
        const teamBScore = combo.teamB[0].balanceScore + combo.teamB[1].balanceScore;
        const scoreDiff = Math.abs(teamAScore - teamBScore);

        if (!best || scoreDiff < best.scoreDiff) {
            best = {
                teamA: combo.teamA,
                teamB: combo.teamB,
                teamAScore,
                teamBScore,
                scoreDiff,
                isMixedDoubles: isMixedCandidate
            };
        }
    }

    return best;
}

module.exports = {
    BALANCE_CONFIG,
    calculatePlayerScore,
    balanceTeams
};