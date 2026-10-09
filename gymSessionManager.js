/**
 * gymSessionManager.js
 * 멀티 테넌트 기반 체육관 이탈/유예/만료/복귀 라이프사이클 전담 매니저
 */

class GymSessionManager {
    constructor() {
        // 멀티 테넌트 격리 키 형식: `${clubId}:${cleanUsername}`
        this.graceTimers = new Map();   // 1단계: 대기열 보존 유예 타이머
        this.expireTimers = new Map();  // 2단계: 세션 만료 타이머
        this.evictedUsers = new Set();  // 1단계 경과로 대기열에서 퇴출된 유저 추적 (복귀 시 운동중 +1 복원용)
        
        // server.js 주입 객체
        this.io = null;
        this.clubs = null;
        this.getClub = null;
        this.cleanupUser = null;
        this.broadcastState = null;
        this.broadcastOnlineCount = null;
    }

    /**
     * 의존성 초기 주입 (server.js 시작 시 1회 호출)
     */
    init({ io, clubs, getClub, cleanupUser, broadcastState, broadcastOnlineCount }) {
        this.io = io;
        this.clubs = clubs;
        this.getClub = getClub;
        this.cleanupUser = cleanupUser;
        this.broadcastState = broadcastState;
        this.broadcastOnlineCount = broadcastOnlineCount;
        console.log('🏸 [GymSessionManager] 멀티 테넌트 세션 매니저 초기화 완료');
    }

    _getKey(clubId, cleanUsername) {
        return `${clubId || 'unjeong'}:${cleanUsername}`;
    }

    _getClubConfig(clubId) {
        const club = (typeof this.getClub === 'function') 
            ? this.getClub(clubId) 
            : (this.clubs ? this.clubs[clubId] : null);
        
        const config = (club && club.config) ? club.config : {};
        let graceMinutes = Number(config.queueGraceMinutes) || 10;
        let expireMinutes = Number(config.sessionExpireMinutes) || 30;

        // 예외 방어: 만료시간이 유예시간보다 짧게 역전된 경우 동기화
        if (expireMinutes < graceMinutes) {
            expireMinutes = graceMinutes;
        }

        return { club, graceMinutes, expireMinutes };
    }

    // 💡 [수정] socket 객체를 추가로 받아서 이름과 전화번호 모두를 알아냅니다.
    _isUserInQueue(club, cleanUsername, socket = {}) {
        if (!club || !cleanUsername) return false;

        // 1. 단절 시 넘어온 전화번호 추출 (예: 01011112222)
        const targetPhoneDigits = String(cleanUsername).replace(/[^0-9]/g, '');

        // 2. 소켓에 남아있는 유저 정보에서 진짜 '이름' 추출
        // (소켓에 "홍길동/남/50대/C조"로 들어있어도 "홍길동"만 정확히 잘라냅니다)
        const targetNames = [];
        const searchKeywords = [ cleanUsername, socket.name, socket.userName, socket.userId ].filter(Boolean);
        
        searchKeywords.forEach(val => {
            const pureName = String(val).replace(/님$/, '').split('/')[0].split('|')[0].trim();
            // 숫자가 아닌 순수 한글/영문 이름만 추출
            if (pureName && isNaN(pureName) && pureName.length >= 2) {
                targetNames.push(pureName);
            }
        });

        // 3. 대기방(전체 회원정보 문자열) 샅샅이 검색
        const checkQueue = (queue) => {
            if (!Array.isArray(queue)) return false;
            return queue.some(slot => {
                if (!slot) return false;
                
                // 슬롯 전체 데이터를 문자열로 쫙 폅니다 (예: "홍길동/남/50대/C조")
                const slotStr = JSON.stringify(slot);
                
                // [기본] 전화번호가 숨어있는지 검사
                if (targetPhoneDigits.length >= 7 && slotStr.replace(/[^0-9]/g, '').includes(targetPhoneDigits)) {
                    return true;
                }
                
                // [핵심] "홍길동"라는 이름이 전체 회원정보 안에 포함되어 있는지 검사
                for (const name of targetNames) {
                    if (slotStr.includes(name)) return true;
                }
                
                return false;
            });
        };

        return checkQueue(club.gameQueue) || checkQueue(club.nantaQueue);
    }

    /**
     * 🚪 [이탈 처리] Wi-Fi 단절 또는 소켓 disconnect 발생 시 호출
     */
    handleDisconnect(socket, cleanUsername, clubId) {
        if (!cleanUsername) return;
        const targetClubId = clubId || socket.clubId || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);
        const { club, graceMinutes, expireMinutes } = this._getClubConfig(targetClubId);

        // 이전 잔존 타이머 정리 (흔들림 방지)
        this._clearTimers(userKey);

       // 💡 [수정] 돋보기 함수에 socket을 통째로 넘겨서 진짜 이름을 찾게 돕습니다.
        const inQueue = this._isUserInQueue(club, cleanUsername, socket);

        // ==========================================
        // 1단계: 대기열 보존 유예 타이머 가동
        // ==========================================
        if (inQueue) {
            console.log(`⏱️ [대기열 유예 시작] [${targetClubId}] 유저: ${cleanUsername} -> ${graceMinutes}분 타이머 가동`);
            const graceTimer = setTimeout(async () => {
                console.log(`⏰ [유예시간 경과] [${targetClubId}] 유저: ${cleanUsername} 대기열 자동 퇴출 실행`);
                
                // 🚨 [중요 진단용 경고 추가] server.js와 청소 함수가 잘 연결되었는지 확인
                if (typeof this.cleanupUser === 'function') {
                    await this.cleanupUser(cleanUsername, targetClubId);
                } else {
                    console.log(`⚠️ [경고] cleanupUser 함수가 매니저에 연결되지 않아 대기방 삭제가 스킵되었습니다! server.js를 확인하세요.`);
                }
                
                this.evictedUsers.add(userKey);
                this.graceTimers.delete(userKey);

                if (typeof this.broadcastState === 'function') this.broadcastState(targetClubId);
                if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
            }, graceMinutes * 60 * 1000);

            this.graceTimers.set(userKey, graceTimer);
        } else {
            console.log(`📡 [단순 이탈] [${targetClubId}] 유저: ${cleanUsername} (대기열 없음) -> 세션 타이머만 단독 가동`);
        }

        // ==========================================
        // 2단계: 세션 자동 만료 타이머 가동
        // ==========================================
        if (this.expireTimers.has(userKey)) {
            clearTimeout(this.expireTimers.get(userKey));
            this.expireTimers.delete(userKey);
        }

        console.log(`⏳ [세션 타이머 시작] [${targetClubId}] 유저: ${cleanUsername} -> ${expireMinutes}분 후 만료 예정`);
        
        const expireTimer = setTimeout(() => {
            console.log(`🔒 [세션 완전 만료] [${targetClubId}] 유저: ${cleanUsername} 강제 로그아웃 신호 전송`);
            const expireMsg = `체육관 이탈 후 ${expireMinutes}분이 경과하여 안전을 위해 자동 로그아웃되었습니다.`;
            
            if (this.io) {
                const cleanPhone = String(cleanUsername).replace(/[^0-9a-zA-Z가-힣_]/g, '');
                if (socket && socket.id) {
                    this.io.to(socket.id).emit('forceSessionExpire', { message: expireMsg });
                }
                this.io.to(`user_${cleanPhone}`).emit('forceSessionExpire', { message: expireMsg });
                this.io.to(`user_${cleanUsername}`).emit('forceSessionExpire', { message: expireMsg });
            }

            this._clearTimers(userKey);
            this.evictedUsers.delete(userKey);

            if (typeof this.broadcastOnlineCount === 'function') {
                this.broadcastOnlineCount(targetClubId);
            }
        }, expireMinutes * 60 * 1000);

        this.expireTimers.set(userKey, expireTimer);
    }

    /**
     * 🟢 [복귀 처리] Wi-Fi 재연결 또는 소켓 재접속 시 호출
     */
    handleReconnect(socket, cleanUsername, clubId) {
        if (!cleanUsername) return;
        const targetClubId = clubId || socket.clubId || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);

        const hadGraceTimer = this.graceTimers.has(userKey);
        const hadExpireTimer = this.expireTimers.has(userKey);
        const wasEvictedFromQueue = this.evictedUsers.has(userKey);

        // 복귀 시점 타이머 즉시 전면 해제
        this._clearTimers(userKey);

        // [시나리오 1] 유예 시간 경과 전 조기 복귀: 대기열 완벽 보존
        if (hadGraceTimer) {
            console.log(`🎉 [유예 복귀 성공] [${targetClubId}] 유저: ${cleanUsername} 대기열 상태 그대로 유지`);
        } 
        // [시나리오 2] 유예 시간은 경과하여 대기열은 삭제되었으나, 세션 만료 전 복귀
        else if (hadExpireTimer && wasEvictedFromQueue) {
            console.log(`🔄 [세션 복귀 - 운동중 복원] [${targetClubId}] 유저: ${cleanUsername} 체육관 재입장 확인 -> 운동중 카운트 복원 트리거`);
            this.evictedUsers.delete(userKey);

            // 해당 클럽 상태 최신화 브로드캐스트
            if (typeof this.broadcastState === 'function') this.broadcastState(targetClubId);
        }

        if (typeof this.broadcastOnlineCount === 'function') {
            this.broadcastOnlineCount(targetClubId);
        }
    }

    _clearTimers(userKey) {
        if (this.graceTimers.has(userKey)) {
            clearTimeout(this.graceTimers.get(userKey));
            this.graceTimers.delete(userKey);
        }
        if (this.expireTimers.has(userKey)) {
            clearTimeout(this.expireTimers.get(userKey));
            this.expireTimers.delete(userKey);
        }
    }

    /**
     * 📊 [현황 집계 헬퍼] 특정 클럽의 유예 및 잔여 세션 유저 목록 조회
     * broadcastOnlineCount에서 카운트를 정확하게 유지하기 위해 사용
     */
    getPendingUsers(clubId) {
        const targetClubId = clubId || 'unjeong';
        const prefix = `${targetClubId}:`;
        
        const graceUsers = [];   // 1단계 유예 중 (대기방 보존 & 운동중 유지)
        const sessionUsers = []; // 2단계 세션 유지 중 (접속자 수만 유지)

        // 1. 유예 타이머 가동 중인 유저
        for (const [key] of this.graceTimers) {
            if (key.startsWith(prefix)) {
                graceUsers.push(key.replace(prefix, ''));
            }
        }

        // 2. 세션 만료 타이머 가동 중인 유저 (유예가 끝난 2단계 유저)
        for (const [key] of this.expireTimers) {
            if (key.startsWith(prefix) && !this.graceTimers.has(key)) {
                sessionUsers.push(key.replace(prefix, ''));
            }
        }

        return { graceUsers, sessionUsers };
    }
}

module.exports = new GymSessionManager();