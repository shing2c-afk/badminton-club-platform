/**
 * 📖 프로젝트 공통 유저 사전 및 데이터 정규화 유틸리티
 * - 서버와 클라이언트 간의 데이터 명칭 불일치(아이디, 실명, 별칭 등)를 해결합니다.
 */
const UserDictionary = {

    /**
     * 1. 어떤 형태의 유저 데이터가 들어와도 표준 형태로 변환 (정규화)
     */
    normalize(input) {
        if (!input) return { username: '', altName: '', raw: '' };

        let username = '';
        if (typeof input === 'string') {
            username = input.split('/')[0].trim();
        } else if (typeof input === 'object' && input !== null) {
            username = input.username || input.name || input.id || '';
        }

        // 'user01' <-> '회원01' 상호 호환 별칭 자동 생성
        let altName = username;
        if (username.startsWith('user')) {
            const num = username.replace('user', '');
            altName = `회원${num.padStart(2, '0')}`;
        } else if (username.startsWith('회원')) {
            // 역으로 '회원01'이 들어온 경우 'user01' 매핑 필요 시 대비
            const num = username.replace('회원', '');
            if (!isNaN(num)) {
                // 필요시 추가 변환 가능
            }
        }

        return {
            raw: input,
            username: username,     // 예: "user01" 또는 실명
            altName: altName        // 예: "회원01"
        };
    },

    /**
     * 2. 대기열 슬롯이나 플레이어 데이터 안에 특정 유저의 흔적이 조금이라도 있는지 정밀 비교
     * @param {String|Object} targetUser - 찾고자 하는 유저 (아이디, 객체 등)
     * @param {String|Object} slotItem - 슬롯에 들어있는 데이터 (플레이어 정보 문자열 또는 객체)
     * @param {String} [realName=null] - DB 등에서 조회한 실명이 있다면 추가 검사 보조
     */
    isMatch(targetUser, slotItem, realName = null) {
        if (!targetUser || !slotItem) return false;

        const std = this.normalize(targetUser);
        const slotStr = typeof slotItem === 'object' ? JSON.stringify(slotItem) : String(slotItem);

        // 검사 키워드들 중 하나라도 슬롯 문자열에 포함되어 있으면 매치!
        return (
            slotStr.includes(std.username) || 
            slotStr.includes(std.altName) || 
            (realName && slotStr.includes(realName))
        );
    }
};

// Node.js(서버) 환경과 브라우저(클라이언트) 환경 모두에서 호환되도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UserDictionary;
} else {
    window.UserDictionary = UserDictionary;
}