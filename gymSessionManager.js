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

    _isUserInQueue(club, cleanUsername) {
        if (!club || !cleanUsername) return false;
        
        const pureName = String(cleanUsername).replace(/님$/, '').split('/')[0].split('|')[0].trim();
        const digits = String(cleanUsername).replace(/[^0-9]/g, '');

        const checkQueue = (queue) => {
            if (!Array.isArray(queue)) return false;
            return queue.some(slot => {
                if (!slot) return false;
                
                // 1. players 배열 검사
                if (Array.isArray(slot.players)) {
                    return slot.players.some(p => {
                        if (!p) return false;
                        const pStr = typeof p === 'object' ? JSON.stringify(p) : String(p);
                        const pPureName = pStr.replace(/님$/, '').split('/')[0].split('|')[0].trim();
                        const pDigits = pStr.replace(/[^0-9]/g, '');

                        if (pureName && pPureName.includes(pureName)) return true;
                        if (digits.length >= 7 && pDigits.includes(digits)) return true;
                        return false;
                    });
                }

                // 2. 단일 슬롯 객체 검사
                const slotStr = JSON.stringify(slot);
                if (pureName && slotStr.includes(pureName)) return true;
                if (digits.length >= 7 && slotStr.replace(/[^0-9]/g, '').includes(digits)) return true;

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

        const inQueue = this._isUserInQueue(club, cleanUsername);

        // ==========================================
        // 1단계: 대기열 보존 유예 타이머 가동
        // ==========================================
        if (inQueue) {
            console.log(`⏱️ [대기열 유예 시작] [${targetClubId}] 유저: ${cleanUsername} -> ${graceMinutes}분 타이머 가동`);
            const graceTimer = setTimeout(async () => {
                console.log(`⏰ [유예시간 경과] [${targetClubId}] 유저: ${cleanUsername} 대기열 자동 퇴출 실행`);
                
                // 대기방에서 삭제 (운동중 -1, 게임/난타 -1 반영)
                if (typeof this.cleanupUser === 'function') {
                    await this.cleanupUser(cleanUsername, targetClubId);
                }
                
                // 퇴출 표식 남김 (이후 세션 만료 전 복귀 시 '운동중 +1' 복원 트리거)
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
        // 2단계: 세션 자동 만료 타이머 가동 (이탈 시점 기준 단독 카운트다운)
        // ==========================================
        // 🛡️️ [중복 방지] 기존에 실행 중이던 타이머가 있다면 먼저 취소
        if (this.expireTimers.has(userKey)) {
            clearTimeout(this.expireTimers.get(userKey));
            this.expireTimers.delete(userKey);
        }

        console.log(`⏳ [세션 타이머 시작] [${targetClubId}] 유저: ${cleanUsername} -> ${expireMinutes}분 후 만료 예정`);
        
        const expireTimer = setTimeout(() => {
            console.log(`🔒 [세션 완전 만료] [${targetClubId}] 유저: ${cleanUsername} 강제 로그아웃 신호 전송`);
            
            const expireMsg = `체육관 이탈 후 ${expireMinutes}분이 경과하여 안전을 위해 자동 로그아웃되었습니다.`;
            
            if (this.io) {
                // 🎯 [핵심 수정] 구장 전체(club_) 전송 제거! 해당 유저에게만 단독 타겟팅 전송
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