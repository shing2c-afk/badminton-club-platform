// =================================================================
// 1. 🏢 [멀티 테넌트] URL 우선 ➔ 브라우저 기억(localStorage) ➔ 기본값 식별
// =================================================================
const urlParams = new URLSearchParams(window.location.search);
const currentClubId = urlParams.get('club') || localStorage.getItem('preferredClubId') || 'unjeong';

window.currentClubId = currentClubId;

// =================================================================
// 2. 🏢 [멀티 테넌트] 구장 명칭 동적 반영 (상용 확장형)
// =================================================================
window.applyClubTitle = async function applyClubTitle() {
    // 💡 URL 파라미터를 1순위로 즉시 확인
    const urlClub = new URLSearchParams(window.location.search).get('club');
    const clubId = urlClub || window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';
    window.currentClubId = clubId;

    let displayName = `${clubId} 배드민턴클럽`;

    try {
        let clubs = window.availableClubs;
        if (!clubs || clubs.length === 0) {
            const res = await fetch('/api/clubs');
            const data = await res.json();
            if (data.success && Array.isArray(data.clubs)) {
                clubs = data.clubs;
                window.availableClubs = clubs;
            }
        }

        const matched = clubs?.find(c => c.id === clubId);
        if (matched && matched.name) {
            displayName = matched.name;
        } else if (clubId === 'unjeong') {
            displayName = '운정배드민턴클럽';
        } else if (clubId === 'daewon') {
            displayName = '대원배드민턴클럽';
        }
    } catch (e) {
        if (clubId === 'unjeong') displayName = '운정배드민턴클럽';
        if (clubId === 'daewon') displayName = '대원배드민턴클럽';
    }
    
    // 1. 브라우저 탭 <title> 변경
    document.title = displayName;
    
    // 2. 헤더 중앙 글자 변경 (다양한 ID 태그 지원)
    const headerTitle = document.getElementById('header-club-name') || document.querySelector('.header-title') || document.getElementById('club-name');
    if (headerTitle) {
        headerTitle.textContent = displayName;
    }
};

// 문서 준비 즉시 실행
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.applyClubTitle);
} else {
    window.applyClubTitle();
}

// =================================================================
// 3. 🏢 [멀티 테넌트] 접속 구장 URL 최우선 확정 및 소켓 연결
// =================================================================
const activeClubId = new URLSearchParams(window.location.search).get('club') || localStorage.getItem('preferredClubId') || 'unjeong';

window.currentClubId = activeClubId;
localStorage.setItem('preferredClubId', activeClubId);

let myStoredPhone = localStorage.getItem('userPhone') || localStorage.getItem('phone') || '';
let myStoredName = window.currentUserName || localStorage.getItem('userName') || '';

// 🟢 [안전한 추출] 전체를 뒤지지 않고, 정식으로 저장된 회원 정보만 깔끔하게 꺼냅니다.
const rawUserStorage = localStorage.getItem('currentUser') || localStorage.getItem('user');
if (rawUserStorage) {
    try {
        const parsed = JSON.parse(rawUserStorage);
        if (parsed && typeof parsed === 'object') {
            if (parsed.phone) myStoredPhone = parsed.phone;
            if (parsed.name || parsed.username) myStoredName = parsed.name || parsed.username;
        }
    } catch(e) {}
}

const socket = window.socket || io({
    query: {
        club: activeClubId,
        clubId: activeClubId,
        phone: myStoredPhone,
        username: myStoredName,
        userKey: myStoredPhone || myStoredName
    }
});
window.socket = socket;

// ==========================================
// 📶 체육관 Wi-Fi 접속 상태 보관 및 수신 (유예 기간 연동)
// ==========================================
window.isGymWifiConnected = false;
window.useWifiRestriction = false;
window.wifiGraceTimer = null; // 유예 타이머 보관용

if (localStorage.getItem("useWifiRestriction") === "true") {
    window.useWifiRestriction = true;
}

// ==========================================
// 📶 서버 Wi-Fi 인가 상태 수신 및 양방향 완벽 복귀 동기화
// ==========================================
socket.off('wifiStatus').on('wifiStatus', (data) => {
    if (!data) return;

    const prevWifiStatus = window.isGymWifiConnected;
    const isNowGymWifi = Boolean(data.isGymWifi);
    
    // 💡 최신 인가 상태 전역 변수에 확정 반영
    window.isGymWifiConnected = isNowGymWifi;
    
    // 클럽 고유 키 확인
    const clubId = window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';
    const clubWifiKey = `useWifiRestriction_${clubId}`;

    // Wi-Fi 제한 기능 활성화 여부 반영 (서버값 기준 동기화)
    if (typeof data.useWifiRestriction !== 'undefined') {
        window.useWifiRestriction = Boolean(data.useWifiRestriction);
        localStorage.setItem(clubWifiKey, data.useWifiRestriction ? "true" : "false");
    } else {
        const storedClubSetting = localStorage.getItem(clubWifiKey);
        window.useWifiRestriction = (storedClubSetting !== null) ? (storedClubSetting === 'true') : true;
    }

    console.log(`📶 구장 Wi-Fi 제한 설정: ${window.useWifiRestriction ? 'ON(제한 중)' : 'OFF(자유 이용)'}`);
    console.log(`📶 현재 접속 상태: ${isNowGymWifi ? '인증됨 (구장 내)' : '미인증 (외부 접속)'} (IP: ${data.clientIp || '확인불가'})`);

    // ⏱️ 유저 식별자 추출 (전화번호/이름)
    let currentPhone = localStorage.getItem('userPhone') || localStorage.getItem('phone') || '';
    let currentName = window.currentUserName || localStorage.getItem('userName') || '';

    const rawUserStorage = localStorage.getItem('currentUser') || localStorage.getItem('user');
    if (rawUserStorage) {
        try {
            const parsedUser = JSON.parse(rawUserStorage);
            if (parsedUser && typeof parsedUser === 'object') {
                if (!currentPhone && parsedUser.phone) currentPhone = parsedUser.phone;
                if (!currentName && (parsedUser.name || parsedUser.username)) currentName = parsedUser.name || parsedUser.username;
            }
        } catch (e) {
            if (!currentName) currentName = rawUserStorage;
        }
    }
    
    if (isNowGymWifi) {
        // ==========================================
        // 🟢 체육관 와이파이 정상 복귀 (활성화 복구)
        // ==========================================
        document.body.classList.add('gym-wifi-active');

        // 클라이언트 로컬 타이머 해제
        if (window.wifiGraceTimer) {
            clearTimeout(window.wifiGraceTimer);
            window.wifiGraceTimer = null;
        }

        // ⏱️️ [서버 알림] 1분 미접속 대기열 삭제 타이머 즉시 취소
        if (currentPhone || currentName) {
            socket.emit('cancelDisconnectTimer', {
                phone: currentPhone,
                username: currentName,
                clubId: clubId
            });
            console.log('✅ 체육관 Wi-Fi 복귀: 1분 유예 타이머 해제 신호 전송 완료');
        }

        // UI 버튼 활성화 갱신
        if (typeof updateWifiRestrictedButtons === 'function') {
            updateWifiRestrictedButtons();
        }
    } else {
        // ==========================================
        // 🟡 체육관 와이파이 단절 / LTE 이탈 (잠금 전환)
        // ==========================================
        document.body.classList.remove('gym-wifi-active');

        // 이전이 Wi-Fi 정상 상태였거나 처음 이탈 감지 시 서버 유예 타이머 시작
        if (prevWifiStatus === true || (prevWifiStatus !== false && (currentPhone || currentName))) {
            console.log('🔒 체육관 와이파이 이탈: 유예 타이머 시작 신호 전달 및 화면 비활성화');
            
            if (currentPhone || currentName) {
                socket.emit('startDisconnectTimer', {
                    phone: currentPhone,
                    username: currentName,
                    clubId: clubId
                });
            }
        } else {
            console.log('🔒 외부 접속 상태 유지: 기능 버튼 잠금');
        }

        // UI 버튼 비활성화 갱신
        if (typeof updateWifiRestrictedButtons === 'function') {
            updateWifiRestrictedButtons();
        }

        // 💡 Wi-Fi 복귀 감지 루프 가동
        if (typeof window.startWifiDetector === 'function') {
            window.startWifiDetector();
        }
    }
});

// ==========================================
// 📶 모바일 Wi-Fi 자동 전환 연속 감지기 (양방향 무한 자동 감지)
// ==========================================
(function() {
    let wifiDetectionTimer = null;

    // 로컬스토리지에서 현재 로그인된 회원의 진짜 이름과 전화번호를 정확히 추출하는 헬퍼
    function getLoggedUserInfo(clubId) {
        let myName = '';
        let myPhone = '';
        const rawUser = localStorage.getItem(`currentUser_${clubId}`) || localStorage.getItem('currentUser') || localStorage.getItem('user');
        if (rawUser) {
            try {
                const parsed = JSON.parse(rawUser);
                if (parsed && typeof parsed === 'object') {
                    myName = String(parsed.name || parsed.username || '').replace(/님$/, '').split('/')[0].trim();
                    myPhone = String(parsed.phone || parsed.id || '').trim();
                }
            } catch (e) {
                myName = String(rawUser).replace(/님$/, '').split('/')[0].trim();
            }
        }
        if (!myName) {
            myName = window.currentUserName || localStorage.getItem('userName') || localStorage.getItem('username') || '';
            myName = String(myName).replace(/님$/, '').split('/')[0].trim();
        }
        if (!myPhone) {
            myPhone = window.currentUserId || localStorage.getItem('userPhone') || localStorage.getItem('phone') || localStorage.getItem('userId') || '';
        }
        return { myName, myPhone };
    }

    async function checkCurrentNetwork() {
        try {
            const clubId = window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';
            const res = await fetch(`/api/check-wifi?clubId=${clubId}&_t=${Date.now()}`);
            if (!res.ok) return;
            const data = await res.json();

            const { myName, myPhone } = getLoggedUserInfo(clubId);
            const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;

            // 🟢 Case 1: 구장 Wi-Fi 접속(복귀) 감지!
            if (data.isGymWifi && window.isGymWifiConnected !== true) {
                console.log('🎉 [Wi-Fi 일치 감지] 구장 Wi-Fi 접속 확인 -> 타이머 즉시 초기화 및 버튼 활성화');
                window.isGymWifiConnected = true;
                document.body.classList.add('gym-wifi-active');

                if (typeof updateWifiRestrictedButtons === 'function') {
                    updateWifiRestrictedButtons();
                }

                if (activeSocket) {
                    if (!activeSocket.connected) {
                        activeSocket.connect();
                    }
                    if (myName || myPhone) {
                        activeSocket.emit('updateWifiState', { 
                            inGym: true, 
                            clubId: clubId, 
                            username: myName,
                            userId: myName || myPhone,
                            phone: myPhone
                        });
                    }
                }
            }
            // 🔴 Case 2: 켜져 있다가 Wi-Fi를 끄고 LTE(외부망)로 이탈한 순간 감지!
            else if (!data.isGymWifi && window.isGymWifiConnected !== false) {
                console.log('🔒 [Wi-Fi 불일치 감지] 외부망 전환 확인 -> 1단계(유예) & 2단계(만료) 타이머 즉시 가동 및 버튼 비활성화');
                window.isGymWifiConnected = false;
                document.body.classList.remove('gym-wifi-active');

                if (typeof updateWifiRestrictedButtons === 'function') {
                    updateWifiRestrictedButtons();
                }

                // 💡 [핵심 추가] 와이파이 불일치 감지 즉시 서버에 알려 유예시간 & 만료시간 타이머를 바로 가동!
                if (activeSocket) {
                    if (!activeSocket.connected) {
                        activeSocket.connect();
                    }
                    if (myName || myPhone) {
                        activeSocket.emit('updateWifiState', { 
                            inGym: false, 
                            clubId: clubId, 
                            username: myName,
                            userId: myName || myPhone,
                            phone: myPhone
                        });
                    }
                }
            }
        } catch (e) {
            // 망 전환 순간의 찰나 에러는 통과
        }
    }

    // 외부에서도 호출할 수 있도록 전역 함수 등록
    window.startWifiDetector = function() {
        if (!wifiDetectionTimer) {
            checkCurrentNetwork();
            wifiDetectionTimer = setInterval(checkCurrentNetwork, 1500);
        }
    };

    window.stopWifiDetector = function() {
        if (wifiDetectionTimer) {
            clearInterval(wifiDetectionTimer);
            wifiDetectionTimer = null;
        }
    };

    // 앱 화면을 보고 있을 때는 상시 1.5초 주기로 ON/OFF 상태를 능동 추적
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            window.startWifiDetector();
        } else {
            window.stopWifiDetector();
        }
    });

    // 최초 실행 시 즉시 가동
    window.startWifiDetector();
})();

// ==========================================
// 🔔 [1단계] 로그인 사용자 전용 채널 등록 함수
// ==========================================
window.registerUserSocket = function() {
    if (!socket || !socket.connected) return;
    
    const savedUser = localStorage.getItem("currentUser");
    let userIdentifier = '';
    let userName = '';

    if (savedUser) {
        try {
            const parsed = JSON.parse(savedUser);
            userIdentifier = (parsed.phone || parsed.username || parsed.id || '').trim();
            userName = (parsed.name || parsed.username || '').split('/')[0].trim();
        } catch (e) {
            userIdentifier = savedUser.split('/')[0].trim();
            userName = userIdentifier;
        }
    }

    if (userIdentifier) {
        // 서버의 개인 채널로 가입 요청
        socket.emit('registerUser', {
            phone: userIdentifier,
            name: userName
        });
        console.log(`🔔 [개인 채널 등록] ${userName}(${userIdentifier}) 개인 알림 룸에 등록 요청`);
    }
};

// ==========================================
// 💡 [완벽 통합] 서버와 웹소켓 연결 성공 시 단 한 번 실행되는 라이프사이클
// ==========================================
if (!socket.hasListeners('connect')) {
    socket.on('connect', () => {
        console.log("🟢 서버와 웹소켓 연결 성공 (ID:", socket.id, ")");
        
        const clubId = window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';

        // 1. 기존 세션 등록 유지 (자동 복귀 검증 - 진짜 이름 최우선 추출)
        const savedUser = localStorage.getItem(`currentUser_${clubId}`) || localStorage.getItem("currentUser");
        if (savedUser) {
            try {
                const parsedUser = JSON.parse(savedUser);
                const cleanName = String(parsedUser.name || parsedUser.username || '').replace(/님$/, '').split('/')[0].trim();
                const userKey = cleanName || parsedUser.phone || parsedUser.id;
                if (userKey) {
                    socket.emit('registerUserSession', { 
                        name: cleanName,
                        username: userKey, 
                        clubId: clubId,
                        isAutoRestore: true 
                    });
                    console.log(`👤 [자동 등록 요청] 세션 만료 여부 검증: ${userKey} (${clubId})`);
                }
            } catch (e) {
                console.error("세션 유저 파싱 에러:", e);
            }
        }

        // 2. 🔔 개인 알림 전용 소켓 룸 자동 등록
        if (typeof window.registerUserSocket === 'function') {
            window.registerUserSocket();
        }

        // 3. 🌐 네트워크 연결 직후 내 진짜 신분증과 Wi-Fi 상태를 서버에 완벽 주입
        setTimeout(() => {
            let myName = '';
            let myPhone = '';

            const rawUserStorage = localStorage.getItem(`currentUser_${clubId}`) || localStorage.getItem('currentUser') || localStorage.getItem('user');
            if (rawUserStorage) {
                try {
                    const parsed = JSON.parse(rawUserStorage);
                    if (parsed && typeof parsed === 'object') {
                        myPhone = String(parsed.phone || parsed.id || '').trim();
                        myName = String(parsed.name || parsed.username || '').replace(/님$/, '').split('/')[0].trim();
                    }
                } catch(e) {}
            }
            
            if (!myName && !myPhone) {
                myName = String(localStorage.getItem("userName") || localStorage.getItem("username") || "").replace(/님$/, '').split('/')[0].trim();
                myPhone = String(localStorage.getItem("userPhone") || localStorage.getItem("phone") || "").trim();
            }

            if (myName || myPhone) {
                console.log('🌐 [네트워크 감지] 서버에 내 신분증 제출 및 타이머 제어 요청:', myName || myPhone);
                socket.emit('registerUser', { phone: myPhone, name: myName, username: myName, clubId: clubId });
                socket.emit('requestWifiStatus', { username: myName, name: myName, phone: myPhone, clubId: clubId });
                
                // 만약 외부망(LTE) 상태라면 즉시 유예 타이머 가동 신호 발송
                if (window.isGymWifiConnected === false) {
                    console.log('🔒 [망 전환 감지] 외부망 접속이므로 유예 & 만료 타이머 시작 신호 발송');
                    socket.emit('startDisconnectTimer', { phone: myPhone, username: myName, name: myName, clubId: clubId });
                }
            }
        }, 300);
    });
}

// 🚨 [필수 유지] 세션 만료 및 중복 로그인 시 자동 로그아웃 통합 처리
const handleForceLogout = (data) => {
    const clubId = window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';

    // 1. 현재 브라우저에 로그인된 유저 정보 정확히 파싱
    let myName = '';
    let myPhone = '';
    const rawUser = localStorage.getItem(`currentUser_${clubId}`) || localStorage.getItem("currentUser") || localStorage.getItem("user");
    if (rawUser) {
        try {
            const parsed = JSON.parse(rawUser);
            if (parsed && typeof parsed === 'object') {
                myName = String(parsed.name || parsed.username || '').replace(/님$/, '').split('/')[0].trim();
                myPhone = String(parsed.phone || parsed.id || '').replace(/[^0-9]/g, '');
            }
        } catch (e) {
            myName = String(rawUser).replace(/님$/, '').split('/')[0].trim();
        }
    }
    if (!myName) {
        myName = String(localStorage.getItem("userName") || localStorage.getItem("username") || "").replace(/님$/, '').split('/')[0].trim();
    }
    if (!myPhone) {
        myPhone = String(localStorage.getItem("userPhone") || localStorage.getItem("phone") || "").replace(/[^0-9]/g, '');
    }

    // 🛡️ [방어막 1] 현재 로그인되어 있지 않은 상태(로그인 페이지 대기 중)라면 팝업을 절대 띄우지 않고 무시!
    if (!myName && !myPhone) return;

    // 🛡️ [방어막 2] 다른 클럽에서 발생한 신호라면 무시
    if (data && data.clubId && data.clubId !== clubId) return;

    // 🛡️ [방어막 3] 특정 타겟 유저가 지정된 신호인 경우, 내 이름이나 전화번호와 일치할 때만 실행
    const targetUser = data && (data.targetUser || data.username);
    const targetPhone = data && data.targetPhone ? String(data.targetPhone).replace(/[^0-9]/g, '') : '';
    if (targetUser || targetPhone) {
        const cleanTargetName = targetUser ? String(targetUser).replace(/님$/, '').split('/')[0].trim() : '';
        const isMe = (myName && cleanTargetName === myName) || (myPhone && targetPhone && myPhone === targetPhone);
        if (!isMe) return;
    }

    console.warn("⚠️ 세션 만료/강제 로그아웃 수신:", data);
    
    // 2. 브라우저에 남아있는 로그인 정보 완벽 삭제
    localStorage.removeItem(`currentUser_${clubId}`);
    localStorage.removeItem("currentUser");
    localStorage.removeItem("user");
    localStorage.removeItem("username");
    localStorage.removeItem("userName");
    localStorage.removeItem("phone");
    localStorage.removeItem("userPhone");
    localStorage.removeItem("userKey");
    sessionStorage.clear(); 
    
    // 3. 만료 안내 알림창 표시 후 현재 클럽 로그인 화면으로 새로고침
    const alertMsg = (data && data.message) ? data.message : "장시간 미접속으로 세션이 만료되었습니다. 다시 로그인해 주세요.";
    alert(alertMsg);
    
    window.location.reload(); 
};

// 기존 로그인 처리/중복 로그인 시 서버가 보내는 신호
if (!socket.hasListeners('forceLogout')) {
    socket.on('forceLogout', handleForceLogout);
}

// 💡 Wi-Fi 이탈 후 세션 만료 타이머가 끝났을 때 서버가 쏘는 퇴출 신호 수신
if (!socket.hasListeners('forceSessionExpire')) {
    socket.on('forceSessionExpire', handleForceLogout);
}

// ==========================================
// 🔔 [1단계] 내게 온 개인 알림 수신 (24시간 필터링)
// ==========================================
socket.off('personalNotification').on('personalNotification', (newNoti) => {
    console.log("📬 개인 알림 도착:", newNoti);
    
    if (typeof notificationsList === 'undefined') {
        window.notificationsList = [];
    }

    // 1. 새 알림 추가
    notificationsList.unshift(newNoti);

    // 2. 24시간 지난 알림 자동 정리
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    notificationsList = notificationsList.filter(n => {
        const timeVal = n.timestamp || (n.createdAt ? new Date(n.createdAt).getTime() : null);
        if (!timeVal) return true;
        return (now - timeVal) < ONE_DAY_MS;
    });

    // 3. 브라우저 저장소 동기화
    try {
        localStorage.setItem("notificationsList", JSON.stringify(notificationsList));
    } catch (e) {}

    // 4. 종모양 UI 및 개수 뱃지 갱신
    if (typeof renderNotifications === 'function') {
        renderNotifications();
    }

    // 5. 토스트 알림 팝업 노출
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = `🔔 ${newNoti.message}`;
    container.appendChild(toast);
    setTimeout(() => {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4500);
});

// 📱 스마트폰 토스트 팝업 수신 및 렌더링
socket.off('toastAlert').on('toastAlert', (message) => {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = message;

    container.appendChild(toast);

    setTimeout(() => {
        if (toast && toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 10000);
});

socket.off('stateUpdated').on('stateUpdated', (data) => {
    if (data.config) CONFIG = data.config;
    courtsData = data.courtsData || [];
    gameQueue = data.gameQueue || [];
    nantaQueue = data.nantaQueue || [];
    
    // 🏢 [멀티 테넌트] 접속 클럽명 UI 및 브라우저 타이틀 동적 반영 (TV 화면 연동 방식)
    const currentClub = window.currentClubId || 'unjeong';
    
    // TV 화면처럼 구장 ID를 기반으로 클럽명 자동 완성 (신규 구장 영구 대응)
    const clubDisplayName = (data.clubId === currentClub && data.clubName) 
        ? data.clubName 
        : `${currentClub.toUpperCase()} 배드민턴클럽`;

    window.currentClubName = clubDisplayName;
    
    // 1. 상단 헤더 타이틀 갱신
    const headerTitle = document.getElementById('header-club-name') || 
                        document.querySelector('.header-title') || 
                        document.querySelector('.logo-text');
    if (headerTitle) {
        headerTitle.textContent = clubDisplayName;
    }
    
    // 2. 브라우저 탭 상단 타이틀 갱신
    document.title = `${clubDisplayName} - 코트 관리 시스템`;

    // 전체 공지 알림이 있을 경우만 유지하거나, 기존 목록이 비어있을 때만 로컬 저장소에서 복원
    if (data.notifications && data.notifications.length > 0) {
        // 기존 개인 알림 체계와 충돌하지 않도록 처리
    }

    if (typeof renderAll === 'function') {
        renderAll();
    }
});

// 서버가 보낸 경고/안내 메시지 (ui.js 커스텀 모달 디자인으로 일원화)
socket.off('alertMessage').on('alertMessage', (msg) => {
    const modal = document.getElementById('custom-alert-modal');
    const msgEl = document.getElementById('custom-alert-message');
    const confirmBtn = document.getElementById('custom-alert-ok-btn');

    if (modal && msgEl) {
        msgEl.innerText = msg;
        modal.style.display = 'flex';
        if (confirmBtn) {
            confirmBtn.onclick = function() {
                modal.style.display = 'none';
            };
        }
    } else {
        alert(msg);
    }
});

// 1. 서비스 워커 등록
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
        console.log('서비스 워커 등록 성공:', reg.scope);
    }).catch((err) => {
        console.warn('서비스 워커 등록 실패:', err);
    });
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then((permission) => {
            console.log('알림 권한 상태:', permission);
        });
    }
}

document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') {
        requestNotificationPermission();
    }
}, { once: true });

// 3. 💡 입장 30초 경과 시 알림
socket.off('entryPopupAlert').on('entryPopupAlert', async (data) => {
    let myName = '';
    const savedUser = localStorage.getItem("currentUser");
    
    if (savedUser) {
        try {
            const parsed = JSON.parse(savedUser);
            myName = (parsed.name || parsed.username || '').split('/')[0].trim();
        } catch (e) {
            myName = savedUser.split('/')[0].trim();
        }
    }
    
    if (!myName) {
        myName = (localStorage.getItem("userName") || localStorage.getItem("username") || '').split('/')[0].trim();
    }

    if (myName && data.targetPlayers && data.targetPlayers.includes(myName)) {
        if ('vibrate' in navigator) {
            navigator.vibrate([1000, 300, 1000, 300, 1000]);
        }

        if ('Notification' in window && Notification.permission === 'granted') {
            const title = `🏟️ [${data.courtNumber}번 ${data.matchType} 코트]`;
            const options = {
                body: '지금 코트로 입장해 주세요! (10초 제한)',
                icon: '/favicon.ico',
                badge: '/favicon.ico',
                tag: 'court-entry-alert',
                renotify: true
            };

            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    reg.showNotification(title, options);
                } catch (e) {}
            } else {
                try {
                    new Notification(title, options);
                } catch (e) {}
            }
        }

        const popup = document.createElement('div');
        popup.innerHTML = `
            <div style="font-size: 20px; font-weight: 800; color: #4ade80; margin-bottom: 6px;">
                🏟️ [${data.courtNumber}번 ${data.matchType} 코트]
            </div>
            <div style="font-size: 16px; font-weight: 600; color: #ffffff;">
                지금 코트로 입장해 주세요!
            </div>
        `;

        popup.style.cssText = `
            position: fixed !important;
            top: 22% !important;
            left: 16px !important;
            right: 16px !important;
            max-width: 460px !important;
            margin: 0 auto !important;
            box-sizing: border-box !important;
            width: auto !important;
            background-color: rgba(15, 23, 42, 0.96) !important;
            border: 2px solid #22c55e !important;
            border-radius: 14px !important;
            padding: 22px 16px !important;
            text-align: center !important;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6) !important;
            z-index: 999999 !important;
            pointer-events: none !important;
        `;

        document.body.appendChild(popup);

        setTimeout(() => {
            popup.remove();
        }, 10000);
    }
});

// =================================================================
// 💡 [핵심 복구] 서버가 보내주는 방 개설 확인 및 교차 방 개설 경고 리스너
// =================================================================
let isProcessingSlot = false;

socket.off('confirmFirstSlot').on('confirmFirstSlot', async ({ type, userId, user }) => {
    if (isProcessingSlot) return; // 중복 실행 원천 차단
    isProcessingSlot = true;

    try {
        const roomTypeName = type === 'game' ? '게임' : '난타';
        const isConfirmed = await confirm(`${roomTypeName} 대기 방을 개설하시겠습니까?`);
        if (isConfirmed) {
            socket.emit('forceCreateSlot', { type, userId, user });
        }
    } finally {
        setTimeout(() => { isProcessingSlot = false; }, 400); // 락 해제 딜레이
    }
});

socket.off('confirmCrossSlot').on('confirmCrossSlot', async ({ type, userId, user }) => {
    if (isProcessingSlot) return; // 중복 실행 원천 차단
    isProcessingSlot = true;

    try {
        const roomTypeName = type === 'game' ? '게임' : '난타';
        const oppositeTypeName = type === 'game' ? '난타' : '게임';
        
        // 💡 선택하신 깔끔한 직관적 문구 적용 (게임/난타 양방향 자동 대응)
        const isConfirmed = await confirm(`이미 ${oppositeTypeName} 대기 중입니다! ${roomTypeName} 방을 개설하시겠습니까?`);
        
        if (isConfirmed) {
            socket.emit('forceCreateSlot', { type, userId, user });
        }
    } finally {
        setTimeout(() => { isProcessingSlot = false; }, 400); // 락 해제 딜레이
    }
});

// 서버로부터 로그인된 접속자 및 현황판 데이터 업데이트 수신
socket.on('updateOnlineCount', (data) => {
    // 1. 새 상단 전광판 요소들
    const connectedEl = document.getElementById('stat-connected-count'); // 🌐 접속자
    const inGymEl = document.getElementById('stat-ingym-count');         // 🏢 운동중
    const gameEl = document.getElementById('stat-game-count');           // 🏸 게임
    const nantaEl = document.getElementById('stat-nanta-count');         // ⏱️ 난타

    // 2. 기존 레거시 요소 (화면 하단에 남아있을 경우 호환 유지)
    const clubElement = document.getElementById('club-count');
    const totalElement = document.getElementById('online-count');

    if (typeof data === 'object' && data !== null) {
        // 접속자 (total 또는 connected)
        const connectedVal = data.connected ?? data.total ?? 0;
        if (connectedEl) connectedEl.textContent = `${connectedVal}명`;
        if (totalElement) totalElement.textContent = connectedVal;

        // 운동중 (inGym 또는 club)
        const inGymVal = data.inGym ?? data.club ?? 0;
        if (inGymEl) inGymEl.textContent = `${inGymVal}명`;
        if (clubElement) clubElement.textContent = inGymVal;

        // 게임 대기+코트 참여자
        if (gameEl && data.game !== undefined) {
            gameEl.textContent = `${data.game}명`;
        }

        // 난타 대기+코트 참여자
        if (nantaEl && data.nanta !== undefined) {
            nantaEl.textContent = `${data.nanta}명`;
        }
    } else {
        const val = data || 0;
        if (connectedEl) connectedEl.textContent = `${val}명`;
        if (totalElement) totalElement.textContent = val;
    }
});

// =================================================================
// 💡 관리자 코트 강제 종료 공지
// =================================================================
if (typeof socket !== 'undefined') {
    let alertTimer = null;

    socket.off('courtClearedNotice').on('courtClearedNotice', (data) => {
        const banner = document.getElementById('court-alert-banner');
        const alertText = document.getElementById('court-alert-text');

        if (banner && alertText) {
            alertText.textContent = data.message;

            if (data.category === 'game') {
                banner.style.backgroundColor = '#2980b9';
            } else if (data.category === 'nanta') {
                banner.style.backgroundColor = '#e67e22';
            } else if (data.category === 'lesson') {
                banner.style.backgroundColor = '#8e44ad';
            } else {
                banner.style.backgroundColor = '#c0392b';
            }

            banner.style.display = 'block';

            if (alertTimer) {
                clearTimeout(alertTimer);
            }

            alertTimer = setTimeout(() => {
                banner.style.display = 'none';
            }, 4000);
        }
    });
}

// =================================================================
// 💡 난타 코트 종료 요청
// =================================================================
window.requestClearNantaCourt = async function(courtId, side) {
    const isConfirmed = await confirm("정말로 난타를 종료(퇴장)하시겠습니까?");
    if (isConfirmed) {
        socket.emit('clearNantaCourt', { courtId, side });
    }
};

// 강제 로그아웃 처리
if (typeof socket !== 'undefined' && socket) {
    socket.off('forceLogout').on('forceLogout', (data) => {
        const savedUser = localStorage.getItem("currentUser");
        let targetMatch = false;

        const targetUser = (data.username || '').split('/')[0].trim();

        if (savedUser) {
            try {
                const parsedUser = JSON.parse(savedUser);
                const localName = (parsedUser.name || parsedUser.username || parsedUser.id || '').split('/')[0].trim();
                const localPhone = (parsedUser.phone || '').trim();

                if (localName === targetUser || localPhone === targetUser || parsedUser.username === targetUser) {
                    targetMatch = true;
                }
            } catch (e) {
                const rawClean = savedUser.split('/')[0].trim();
                if (rawClean === targetUser) {
                    targetMatch = true;
                }
            }
        } else {
            targetMatch = true;
        }

        if (targetMatch) {
            console.warn('⚠️ [강제 로그아웃]', data.reason || '세션 만료');
            
            localStorage.removeItem("currentUser");
            localStorage.removeItem("username");
            localStorage.removeItem("userName");
            sessionStorage.clear();
            
            const alertText = data.message || '다른 기기 또는 브라우저에서 로그인되어 현재 연결이 종료되었습니다.';
            alert(alertText);
            
            window.location.reload(); 
        }
    });
}

// =================================================================
// 📶 [실시간 와이파이 상태 감시기 & 세션 만료 수신기]
// =================================================================
(function() {
    let lastGymWifiStatus = null;

    // 3초마다 와이파이 상태 변경을 감시하여 서버로 통보
    setInterval(() => {
        const currentStatus = !!window.isGymWifiConnected;
        const targetClub = (typeof currentClubId !== 'undefined' && currentClubId) ? currentClubId : 'unjeong';

        if (lastGymWifiStatus !== currentStatus) {
            lastGymWifiStatus = currentStatus;

            const activeSocket = (typeof socket !== 'undefined') ? socket : window.socket;
            if (activeSocket && activeSocket.connected) {
                console.log(`📡 [와이파이 상태 통보] 체육관 내부: ${currentStatus} (${targetClub})`);
                activeSocket.emit('updateWifiState', {
                    inGym: currentStatus,
                    clubId: targetClub
                });
            }
        }
    }, 3000);

    // ==========================================
// 💡 [완성본] 소켓이 준비되었을 때 forceSessionExpire 리스너 장착 (본인 검증 및 4초 카운트다운)
// ==========================================
(function() {
    function setupSessionExpireListener() {
        const activeSocket = (typeof socket !== 'undefined') ? socket : window.socket;
        if (activeSocket) {
            // 중복 바인딩 방지
            activeSocket.off('forceSessionExpire');

            activeSocket.ons('forceSessionExpire', () => {}); // 안전 방어

            activeSocket.on('forceSessionExpire', (data) => {
                // 이미 만료 안내 모달이 떠 있다면 중복 실행 방지
                if (document.getElementById('session-expire-modal')) return;

                const targetClub = (typeof currentClubId !== 'undefined' && currentClubId) ? currentClubId : (localStorage.getItem('preferredClubId') || 'unjeong');
                
                // 🛡️ [핵심 방어막 1] 현재 로그인되어 있지 않은 상태라면 팝업 무시
                const rawUser = localStorage.getItem(`currentUser_${targetClub}`) || localStorage.getItem('currentUser');
                if (!rawUser) return;

                // 🛡️ [핵심 방어막 2] 본인 확인 검증 (타겟 유저 지정 신호일 경우 내 정보와 대조)
                let myName = '';
                let myPhone = '';
                try {
                    const parsed = JSON.parse(rawUser);
                    if (parsed && typeof parsed === 'object') {
                        myName = String(parsed.name || parsed.username || '').replace(/님$/, '').split('/')[0].trim();
                        myPhone = String(parsed.phone || parsed.id || '').replace(/[^0-9]/g, '');
                    }
                } catch (e) {
                    myName = String(rawUser).replace(/님$/, '').split('/')[0].trim();
                }

                if (data && (data.targetUser || data.targetPhone)) {
                    const cleanTargetName = data.targetUser ? String(data.targetUser).replace(/님$/, '').split('/')[0].trim() : '';
                    const targetPhoneNum = data.targetPhone ? String(data.targetPhone).replace(/[^0-9]/g, '') : '';
                    const isMe = (myName && cleanTargetName === myName) || (myPhone && targetPhoneNum && myPhone === targetPhoneNum);
                    if (!isMe) return; // 내 신호가 아니면 조용히 무시
                }

                const msg = (data && data.message) 
                    ? data.message 
                    : '체육관을 벗어나 장시간 경과하여 안전을 위해 자동 로그아웃되었습니다.';

                // 1. 유저 인증 정보 즉시 소멸
                localStorage.removeItem(`currentUser_${targetClub}`);
                localStorage.removeItem('currentUser');
                localStorage.removeItem('user');
                localStorage.removeItem('username');
                localStorage.removeItem('phone');
                localStorage.removeItem('userPhone');
                sessionStorage.clear();

                // 2. 화면 전체를 덮는 직관적인 세션 만료 팝업 UI 생성
                const overlay = document.createElement('div');
                overlay.id = 'session-expire-modal';
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    background: rgba(15, 23, 42, 0.94);
                    z-index: 2147483647;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    padding: 24px;
                    box-sizing: border-box;
                    backdrop-filter: blur(5px);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                `;

                overlay.innerHTML = `
                    <div style="background: #ffffff; border-radius: 20px; max-width: 320px; width: 100%; padding: 30px 22px; text-align: center; box-shadow: 0 20px 30px rgba(0, 0, 0, 0.4);">
                        <div style="font-size: 50px; line-height: 1; margin-bottom: 16px;">🔒</div>
                        <h3 style="margin: 0 0 10px 0; font-size: 20px; font-weight: 800; color: #1e293b;">자동 로그아웃 안내</h3>
                        <p style="margin: 0 0 22px 0; font-size: 14px; line-height: 1.55; color: #475569; word-break: keep-all;">${msg}</p>
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <button id="expire-confirm-btn" style="width: 100%; padding: 13px; background: #2563eb; color: #ffffff; border: none; border-radius: 12px; font-size: 15px; font-weight: bold; cursor: pointer;">
                                지금 로그인 창으로 이동
                            </button>
                            <span id="expire-timer-text" style="font-size: 13px; font-weight: 600; color: #64748b;">4초 후 자동으로 이동합니다...</span>
                        </div>
                    </div>
                `;

                document.body.appendChild(overlay);

                // 3. 페이지 새로고침 단일 실행 함수
                let isReloading = false;
                const doReload = () => {
                    if (isReloading) return;
                    isReloading = true;
                    location.reload();
                };

                // 사용자가 직접 '확인' 버튼 클릭 시 즉시 새로고침
                const btn = document.getElementById('expire-confirm-btn');
                if (btn) {
                    btn.addEventListener('click', doReload);
                }

                // 4. 4초 실시간 카운트다운 타이머
                let remainingSeconds = 4;
                const timerText = document.getElementById('expire-timer-text');
                const intervalId = setInterval(() => {
                    remainingSeconds -= 1;
                    if (remainingSeconds > 0) {
                        if (timerText) {
                            timerText.innerText = `${remainingSeconds}초 후 자동으로 이동합니다...`;
                        }
                    } else {
                        clearInterval(intervalId);
                        doReload();
                    }
                }, 1000);
            });
        } else {
            setTimeout(setupSessionExpireListener, 500);
        }
    }
    setupSessionExpireListener();
})();