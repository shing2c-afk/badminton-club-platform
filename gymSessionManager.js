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

    /**
     * 🔍 [무적 판독기] 유저가 대기열(Queue)이나 현재 플레이 중인 코트(Court)에 있는지 완벽 검사
     */
    _isUserInQueue(club, cleanUsername, socket) {
        if (!club) return false;
        
        // 1. 유저가 가질 수 있는 모든 식별자(이름, 번호) 영혼까지 끌어모으기
        const searchKeys = [cleanUsername];
        const cleanPhone = String(cleanUsername).replace(/[^0-9]/g, '');
        if (cleanPhone) searchKeys.push(cleanPhone);
        
        if (socket) {
            if (socket.name) searchKeys.push(socket.name);
            if (socket.username) searchKeys.push(socket.username);
            if (socket.userIdentifier) searchKeys.push(socket.userIdentifier);
            if (socket.phone) searchKeys.push(String(socket.phone).replace(/[^0-9]/g, ''));
        }

        const uniqueKeys = [...new Set(searchKeys.filter(Boolean))];

        // 2. 대기열(Queue) 검사
        const inGameQueue = club.gameQueue && club.gameQueue.some(slot => 
            slot.players && slot.players.some(p => uniqueKeys.some(key => p && p.includes(key)))
        );
        const inNantaQueue = club.nantaQueue && club.nantaQueue.some(slot => 
            slot.players && slot.players.some(p => uniqueKeys.some(key => p && p.includes(key)))
        );

        // 3. 💡 코트(Court)에서 실제로 플레이 중인지도 추가로 검사! (매우 중요)
        const inGameCourt = club.courtsData && club.courtsData.some(c => 
            c.type === 'game' && !c.isEmpty && c.players && uniqueKeys.some(key => c.players.includes(key))
        );
        const inNantaCourt = club.courtsData && club.courtsData.some(c => 
            c.type === 'nanta' && (
                (c.sideA && !c.sideA.isEmpty && c.sideA.players && uniqueKeys.some(key => c.sideA.players.includes(key))) ||
                (c.sideB && !c.sideB.isEmpty && c.sideB.players && uniqueKeys.some(key => c.sideB.players.includes(key)))
            )
        );

        const result = inGameQueue || inNantaQueue || inGameCourt || inNantaCourt;
        console.log(`🔍 [상태 판독] 검색키: [${uniqueKeys.join(', ')}] -> 참여중 여부: ${result}`);
        
        return result;
    }

    /**
     * 🚪 [이탈 처리] Wi-Fi 불일치(단절) 시 세션/유예 타이머 동시 시작
     */
    handleDisconnect(socket, cleanUsername, clubId) {
        if (!cleanUsername) return;
        const targetClubId = clubId || socket.clubId || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);
        const { club, graceMinutes, expireMinutes } = this._getClubConfig(targetClubId);

        // 이전 잔존 타이머 정리 (흔들림 방지 - 강력한 버전 호출)
        this._clearTimers(targetClubId, cleanUsername);

        // 💡 돋보기 함수에 socket을 통째로 넘겨서 진짜 이름을 찾게 돕습니다.
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
        
        // 💡 [원상 복구] async 제거, 순수하게 스마트폰 강제 로그아웃 신호만 전송 (청소는 1분 유예 타이머의 역할)
        const expireTimer = setTimeout(() => {
            console.log(`🔒 [세션 완전 만료] [${targetClubId}] 유저: ${cleanUsername} 강제 로그아웃 신호 전송`);
            const expireMsg = `체육관 이탈 후 ${expireMinutes}분이 경과하여 안전을 위해 자동 로그아웃되었습니다.`;
            
            if (this.io) {
                const cleanPhone = String(cleanUsername).replace(/[^0-9a-zA-Z가-힣_]/g, '');
                
                // 1. 기존 룸 방식 유지
                this.io.to(`user_${cleanPhone}`).emit('forceSessionExpire', { message: expireMsg });
                this.io.to(`user_${cleanUsername}`).emit('forceSessionExpire', { message: expireMsg });

                // 2. [핵심 유지] LTE 전환으로 생성된 '새 소켓'을 찾아내어 정확히 조준 타격
                const targetSockets = new Set();
                if (socket && socket.id) targetSockets.add(socket.id);
                
                if (typeof activeUserSockets !== 'undefined' && activeUserSockets.get) {
                    const s1 = activeUserSockets.get(`${targetClubId}_${cleanUsername}`);
                    const s2 = activeUserSockets.get(cleanUsername);
                    if (s1) targetSockets.add(s1);
                    if (s2) targetSockets.add(s2);
                }
                if (typeof userSockets !== 'undefined') {
                    for (const [sId, uInfo] of Object.entries(userSockets)) {
                        const rawName = typeof uInfo === 'object' ? (uInfo.name || uInfo.id || '') : String(uInfo);
                        const pureName = rawName.replace(/님$/, '').split('/')[0].split('|')[0].trim();
                        if (pureName === cleanUsername || pureName === cleanPhone) {
                            targetSockets.add(sId);
                        }
                    }
                }

                targetSockets.forEach(sId => {
                    this.io.to(sId).emit('forceSessionExpire', { message: expireMsg });
                });
                
                console.log(`🎯 [신호 명중] 발송 대상 소켓들:`, Array.from(targetSockets));
            }

            // 💡 [원상 복구] 서버 내부의 cleanupUser는 여기서 하지 않음
            this._clearTimers(targetClubId, cleanUsername);
            this.evictedUsers.delete(userKey);

            if (typeof this.broadcastOnlineCount === 'function') {
                this.broadcastOnlineCount(targetClubId);
            }
        }, expireMinutes * 60 * 1000);

        this.expireTimers.set(userKey, expireTimer);
    }

    /**
     * 🟢 [접속/복귀 처리] Wi-Fi 일치 시 호출 (이름을 handleConnect로 맞춤)
     */
    handleConnect(socket, cleanUsername, clubId) {
        if (!cleanUsername) return;
        const targetClubId = clubId || socket.clubId || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);

        const hadGraceTimer = this.graceTimers.has(userKey);
        const hadExpireTimer = this.expireTimers.has(userKey);
        const wasEvictedFromQueue = this.evictedUsers.has(userKey);

        // 💡 복귀 시점 타이머 즉시 전면 해제 (강력한 청소 함수 호출)
        this._clearTimers(targetClubId, cleanUsername);

        // [시나리오 1] 유예 시간 경과 전 조기 복귀: 대기열 완벽 보존
        if (hadGraceTimer) {
            console.log(`🎉 [유예 복귀 성공] [${targetClubId}] 유저: ${cleanUsername} 대기열 상태 그대로 유지 (타이머 취소됨)`);
        } 
        // [시나리오 2] 유예 시간은 경과하여 대기열은 삭제되었으나, 세션 만료 전 복귀
        else if (hadExpireTimer && wasEvictedFromQueue) {
            console.log(`🔄 [세션 복귀 - 운동중 복원] [${targetClubId}] 유저: ${cleanUsername} 체육관 재입장 확인 -> 운동중 카운트 복원 대기`);
            this.evictedUsers.delete(userKey);

            // 해당 클럽 상태 최신화 브로드캐스트
            if (typeof this.broadcastState === 'function') this.broadcastState(targetClubId);
        }

        if (typeof this.broadcastOnlineCount === 'function') {
            this.broadcastOnlineCount(targetClubId);
        }
    }

    /**
     * 🧹 [타이머 무적 청소기] 식별자 꼬임 방지를 위해 관련된 모든 키를 찾아내어 박살 냄
     */
    _clearTimers(targetClubId, cleanUsername) {
        if (!cleanUsername) return;
        const cleanPhone = String(cleanUsername).replace(/[^0-9a-zA-Z가-힣_]/g, '');
        
        // 발생할 수 있는 모든 이름/전화번호 조합의 식별키 생성
        const keysToClear = [
            this._getKey(targetClubId, cleanUsername),
            this._getKey(targetClubId, cleanPhone),
            `${targetClubId}_${cleanUsername}`,
            `${targetClubId}_${cleanPhone}`,
            cleanUsername,
            cleanPhone
        ];

        // 싹쓸이 검색 후 타이머 강제 종료
        keysToClear.forEach(key => {
            if (this.graceTimers && this.graceTimers.has(key)) {
                clearTimeout(this.graceTimers.get(key));
                this.graceTimers.delete(key);
                console.log(`🗑️ [청소 완료] ${key} 의 유예 타이머 해제`);
            }
            if (this.expireTimers && this.expireTimers.has(key)) {
                clearTimeout(this.expireTimers.get(key));
                this.expireTimers.delete(key);
                console.log(`🗑️ [청소 완료] ${key} 의 세션 타이머 해제`);
            }
        });
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