/**
 * gymSessionManager.js
 * 멀티 테넌트 기반 체육관 이탈/유예/만료/복귀 라이프사이클 전담 매니저 (5단계 마스터 로직 완결판)
 */

class GymSessionManager {
    constructor() {
        // 멀티 테넌트 격리 키 형식: `${clubId}:${cleanUsername}`
        this.graceTimers = new Map();   // 1단계: 대기방 보존 유예 타이머 (운동중 및 대기방 유지)
        this.expireTimers = new Map();  // 2단계: 세션 자동 만료 타이머 (접속자 유지 후 만료 시 강제 로그아웃)
        this.inGymUsers = new Set();    // 💡 실제 구장 Wi-Fi 접속이 확인된 유저 추적
        this.evictedUsers = new Set();  // 1단계 경과로 대기열/운동중에서 제외된 유저 추적
        this.expiredUsers = new Set();  // 2단계 경과로 완전 만료된 유저 추적
        
        // server.js 주입 객체
        this.io = null;
        this.clubs = null;
        this.getClub = null;
        this.cleanupUser = null;
        this.broadcastState = null;
        this.broadcastOnlineCount = null;
    }

    init({ io, clubs, getClub, cleanupUser, broadcastState, broadcastOnlineCount }) {
        this.io = io;
        this.clubs = clubs;
        this.getClub = getClub;
        this.cleanupUser = cleanupUser;
        this.broadcastState = broadcastState;
        this.broadcastOnlineCount = broadcastOnlineCount;
        console.log('🏸 [GymSessionManager] 5단계 마스터 로직 세션 매니저 초기화 완료');
    }

    _normalizeName(raw) {
        if (!raw) return '';
        return String(raw).replace(/님$/, '').split('/')[0].split('|')[0].trim();
    }

    _getKey(clubId, cleanUsername) {
        return `${clubId || 'unjeong'}:${this._normalizeName(cleanUsername)}`;
    }

    /**
     * ⚙️ 관리자 모드에서 설정한 유예시간 / 만료시간 실시간 로드
     */
    _getClubConfig(clubId) {
        const club = (typeof this.getClub === 'function') 
            ? this.getClub(clubId) 
            : (this.clubs ? this.clubs[clubId] : null);
        
        const config = (club && club.config) ? club.config : {};
        
        // 관리자 설정값 우선 적용 (기본값: 유예 30분, 만료 60분)
        let graceMinutes = Number(config.queueGraceMinutes);
        if (isNaN(graceMinutes) || graceMinutes <= 0) graceMinutes = 30;

        let expireMinutes = Number(config.sessionExpireMinutes);
        if (isNaN(expireMinutes) || expireMinutes <= 0) expireMinutes = 60;

        // 만료시간이 유예시간보다 짧게 설정된 경우 안전 동기화
        if (expireMinutes < graceMinutes) {
            expireMinutes = graceMinutes;
        }

        const useWifiRestriction = config.useWifiRestriction !== false;

        return { club, graceMinutes, expireMinutes, useWifiRestriction };
    }

    /**
     * 특정 유저의 현재 클럽 내 모든 활성 소켓 상태 일괄 업데이트
     */
    _updateUserSocketsState(clubId, cleanUsername, stateUpdater) {
        if (!this.io || !this.io.sockets || !this.io.sockets.sockets) return;
        const targetName = this._normalizeName(cleanUsername);
        const cleanPhone = targetName.replace(/[^0-9]/g, '');

        for (const [, s] of this.io.sockets.sockets) {
            if ((s.clubId || 'unjeong') !== clubId) continue;
            const sName = this._normalizeName(s.finalName || s.username || '');
            const sPhone = String(s.userIdentifier || s.phone || '').replace(/[^0-9]/g, '');

            if (sName === targetName || (cleanPhone.length >= 7 && sPhone === cleanPhone)) {
                stateUpdater(s);
            }
        }
    }

    /**
     * 🔴 [2단계 마스터 로직] Wi-Fi 불일치(단절) 감지 시 타이머 제어
     */
    handleDisconnect(socket, rawUsername, clubId) {
        const cleanUsername = this._normalizeName(rawUsername || (socket && (socket.finalName || socket.username)));
        if (!cleanUsername || cleanUsername === '0100') return;

        const targetClubId = clubId || (socket && socket.clubId) || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);
        const { graceMinutes, expireMinutes, useWifiRestriction } = this._getClubConfig(targetClubId);

        // 🚨 [수면 모드 깨어남 방어] 이미 2단계 세션 만료된 유저가 자동 재접속한 경우 즉시 강제 로그아웃
        if (this.expiredUsers.has(userKey)) {
            if (socket) {
                socket.inGym = false;
                socket.inGracePeriod = false;
                socket.emit('forceSessionExpire', {
                    targetUser: cleanUsername,
                    clubId: targetClubId,
                    message: '장시간 체육관 Wi-Fi 미접속으로 세션이 만료되었습니다. 다시 로그인해 주세요.'
                });
                socket.username = null;
                socket.finalName = null;
                socket.clubUserKey = null;
            }
            setTimeout(() => this.expiredUsers.delete(userKey), 3000);
            if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
            return;
        }

        // 관리자 모드에서 Wi-Fi 제한 스위치를 OFF로 끈 경우 타이머를 돌리지 않음
        if (!useWifiRestriction) {
            if (socket) {
                socket.inGym = true;
                socket.inGracePeriod = false;
            }
            if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
            return;
        }

        // 💡 [중복 가동 방지] 이미 해당 유저의 타이머가 돌고 있다면 리셋하지 않고 기존 카운트다운 유지!
        if (this.graceTimers.has(userKey) || this.expireTimers.has(userKey)) {
            const isStillInGrace = this.graceTimers.has(userKey);
            if (socket) {
                socket.inGym = false;
                socket.inGracePeriod = isStillInGrace;
            }
            this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
                s.inGym = false;
                s.inGracePeriod = isStillInGrace;
            });
            console.log(`⏳ [타이머 유지] [${targetClubId}] 유저(${cleanUsername}) 이미 타이머 작동 중 (1단계 유예중: ${isStillInGrace})`);
            if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
            return;
        }

        // 💡 직전에 구장 Wi-Fi에 실제로 접속해 있었던 회원인지 확인
        const wasInGym = this.inGymUsers.has(userKey);
        this.inGymUsers.delete(userKey);
        this.evictedUsers.delete(userKey);

        if (wasInGym) {
            // ✅ 구장 Wi-Fi에 있다가 밖으로 나간 경우: 1단계(유예: 운동중 유지) + 2단계(만료) 동시 가동
            if (socket) {
                socket.inGym = false;
                socket.inGracePeriod = true;
            }
            this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
                s.inGym = false;
                s.inGracePeriod = true;
            });

            console.log(`⏱️ [타이머 동시 시작] [${targetClubId}] 유저: ${cleanUsername} -> 1단계 유예(${graceMinutes}분) & 2단계 만료(${expireMinutes}분) 동시 가동!`);

            const graceTimer = setTimeout(async () => {
                console.log(`⏰ [1단계 유예시간 경과] [${targetClubId}] 유저: ${cleanUsername} -> 대기열 삭제 및 운동중/게임/난타 카운트 차감`);
                
                this.graceTimers.delete(userKey);
                this.evictedUsers.add(userKey);

                // 소켓에서 유예 꼬리표 제거 (운동중 카운트 즉시 차감)
                this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
                    s.inGym = false;
                    s.inGracePeriod = false;
                });

                // 대기열(게임/난타)에서 유저 삭제 및 빈 방 폭파
                if (typeof this.cleanupUser === 'function') {
                    await this.cleanupUser(cleanUsername, targetClubId);
                }

                if (typeof this.broadcastState === 'function') this.broadcastState(targetClubId);
                if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
            }, graceMinutes * 60 * 1000);

            this.graceTimers.set(userKey, graceTimer);
        } else {
            // 🚫 처음부터 구장 밖(외부망)에서 접속한 경우: 1단계 유예(운동중) 없이 2단계(접속자 세션 만료)만 가동!
            if (socket) {
                socket.inGym = false;
                socket.inGracePeriod = false;
            }
            this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
                s.inGym = false;
                s.inGracePeriod = false;
            });
            console.log(`🌐 [외부망 접속] [${targetClubId}] 유저: ${cleanUsername} -> 구장 미접속 상태이므로 운동중 제외(0) & 2단계 세션 만료(${expireMinutes}분)만 가동!`);
        }

        // =================================================================
        // [5단계 마스터 로직] 2차 만료: 세션 자동 만료시간 경과 시점
        // -> 강제 로그아웃 신호 발송 + 접속자(-1) 최종 차감
        // =================================================================
        const expireTimer = setTimeout(async () => {
            console.log(`🔒 [2단계 세션 완전 만료] [${targetClubId}] 유저: ${cleanUsername} -> 강제 로그아웃 및 접속자 카운트 차감`);
            const expireMsg = `체육관 Wi-Fi 이탈 후 ${expireMinutes}분이 경과하여 자동 로그아웃되었습니다.`;

            if (typeof this.cleanupUser === 'function') {
                await this.cleanupUser(cleanUsername, targetClubId);
            }

            this._clearTimers(targetClubId, cleanUsername);
            this.inGymUsers.delete(userKey);
            this.evictedUsers.delete(userKey);
            this.expiredUsers.add(userKey);

            let notifiedActiveSocket = false;

            if (this.io) {
                const cleanPhone = String(cleanUsername).replace(/[^0-9a-zA-Z가-힣_]/g, '');
                const payload = {
                    targetUser: cleanUsername,
                    targetPhone: cleanPhone,
                    clubId: targetClubId,
                    message: expireMsg
                };

                this.io.to(`club_${targetClubId}`).emit('forceSessionExpire', payload);
                this.io.to(`user_${cleanPhone}`).emit('forceSessionExpire', payload);

                this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
                    notifiedActiveSocket = true;
                    s.emit('forceSessionExpire', payload);
                    s.inGym = false;
                    s.inGracePeriod = false;
                    s.username = null;
                    s.finalName = null;
                    s.userIdentifier = null;
                    s.userId = null;
                    s.clubUserKey = null;
                });
            }

            // 현재 화면이 켜져 있어 즉시 로그아웃 신호를 받은 경우 5초 후 만료 기록 정리 (수면 모드인 경우 깨어날 때까지 유지)
            if (notifiedActiveSocket) {
                setTimeout(() => this.expiredUsers.delete(userKey), 5000);
            }

            if (typeof this.broadcastState === 'function') this.broadcastState(targetClubId);
            if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
        }, expireMinutes * 60 * 1000);

        this.expireTimers.set(userKey, expireTimer);

        if (typeof this.broadcastOnlineCount === 'function') {
            this.broadcastOnlineCount(targetClubId);
        }
    }

    /**
     * 🟢 [1단계 & 3단계 마스터 로직] 구장 Wi-Fi 접속/복귀 시 모든 타이머 즉시 초기화 및 상태 복원
     */
    handleConnect(socket, rawUsername, clubId) {
        const cleanUsername = this._normalizeName(rawUsername || (socket && (socket.finalName || socket.username)));
        if (!cleanUsername || cleanUsername === '0100') return;

        const targetClubId = clubId || (socket && socket.clubId) || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);

        // 🚨 [핵심 추가: 수면 모드 깨어남 방어] 이미 2단계 세션 만료된 유저가 자동 복귀한 경우 부활시키지 않고 즉시 강제 로그아웃!
        // (단, 신규 직접 로그인 시에는 server.js의 registerUserSession에서 먼저 expiredUsers를 지워주므로 여기 걸리지 않음)
        if (this.expiredUsers.has(userKey)) {
            if (socket) {
                socket.inGym = false;
                socket.inGracePeriod = false;
                socket.emit('forceSessionExpire', {
                    targetUser: cleanUsername,
                    clubId: targetClubId,
                    message: '장시간 체육관 Wi-Fi 미접속으로 세션이 만료되었습니다. 다시 로그인해 주세요.'
                });
                socket.username = null;
                socket.finalName = null;
                socket.clubUserKey = null;
            }
            setTimeout(() => this.expiredUsers.delete(userKey), 3000);
            if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
            return;
        }

        const hadGraceTimer = this.graceTimers.has(userKey);
        const hadExpireTimer = this.expireTimers.has(userKey);
        const wasEvicted = this.evictedUsers.has(userKey);

        this._clearTimers(targetClubId, cleanUsername);
        this.inGymUsers.add(userKey); // 💡 구장 Wi-Fi 정상 접속 기록
        this.evictedUsers.delete(userKey);
        this.expiredUsers.delete(userKey);

        if (socket) {
            socket.inGym = true;
            socket.isGymWifi = true;
            socket.inGracePeriod = false;
        }
        this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
            s.inGym = true;
            s.isGymWifi = true;
            s.inGracePeriod = false;
        });

        if (hadGraceTimer) {
            console.log(`🎉 [3단계 유예시간 내 복귀] [${targetClubId}] 유저(${cleanUsername}) -> 모든 타이머 초기화 및 대기방/카운트 완벽 유지!`);
        } else if (hadExpireTimer || wasEvicted) {
            console.log(`🔄 [세션 만료 전 복귀] [${targetClubId}] 유저(${cleanUsername}) -> 세션 타이머 초기화 및 운동중 카운트(+1) 복원!`);
        }

        if (typeof this.broadcastState === 'function') this.broadcastState(targetClubId);
        if (typeof this.broadcastOnlineCount === 'function') this.broadcastOnlineCount(targetClubId);
    }

    /**
     * 🚪 명시적 로그아웃 시 잔존 타이머 및 카운트 즉시 완전 제거
     */
    clearUserImmediately(rawUsername, clubId) {
        const cleanUsername = this._normalizeName(rawUsername);
        if (!cleanUsername) return;
        const targetClubId = clubId || 'unjeong';
        const userKey = this._getKey(targetClubId, cleanUsername);

        this._clearTimers(targetClubId, cleanUsername);
        this.inGymUsers.delete(userKey);
        this.evictedUsers.delete(userKey);
        this.expiredUsers.delete(userKey);

        this._updateUserSocketsState(targetClubId, cleanUsername, (s) => {
            s.inGym = false;
            s.inGracePeriod = false;
            s.username = null;
            s.finalName = null;
            s.userIdentifier = null;
            s.userId = null;
            s.clubUserKey = null;
        });
    }

    _clearTimers(targetClubId, cleanUsername) {
        if (!cleanUsername) return;
        const normName = this._normalizeName(cleanUsername);
        const cleanPhone = String(cleanUsername).replace(/[^0-9a-zA-Z가-힣_]/g, '');
        
        const keysToClear = [
            this._getKey(targetClubId, normName),
            this._getKey(targetClubId, cleanPhone),
            `${targetClubId}_${normName}`,
            `${targetClubId}_${cleanPhone}`,
            normName,
            cleanPhone
        ];

        keysToClear.forEach(key => {
            if (this.graceTimers.has(key)) {
                clearTimeout(this.graceTimers.get(key));
                this.graceTimers.delete(key);
                console.log(`🗑️ [타이머 초기화] ${key} -> 1단계 대기방 유예 타이머 취소 완료`);
            }
            if (this.expireTimers.has(key)) {
                clearTimeout(this.expireTimers.get(key));
                this.expireTimers.delete(key);
                console.log(`🗑️ [타이머 초기화] ${key} -> 2단계 세션 만료 타이머 취소 완료`);
            }
        });
    }

    /**
     * 📊 [전광판 카운트 집계용] 현재 1단계 유예 중(운동중+접속자 유지)인 유저와 2단계 세션 대기 중(접속자만 유지)인 유저 반환
     */
    getPendingUsers(clubId) {
        const targetClubId = clubId || 'unjeong';
        const prefix = `${targetClubId}:`;
        
        const graceUsers = [];   // 1단계 유예 중 (접속자 +1, 운동중 +1 유지)
        const sessionUsers = []; // 1단계 만료 후 2단계 세션 유지 중 (접속자 +1만 유지, 운동중은 제외)

        for (const [key] of this.graceTimers) {
            if (key.startsWith(prefix)) {
                graceUsers.push(key.replace(prefix, ''));
            }
        }

        for (const [key] of this.expireTimers) {
            if (key.startsWith(prefix) && !this.graceTimers.has(key)) {
                sessionUsers.push(key.replace(prefix, ''));
            }
        }

        return { graceUsers, sessionUsers };
    }
}

module.exports = new GymSessionManager();