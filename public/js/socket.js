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

// 💡 [핵심] 브라우저 저장소 전체를 안전하게 탐색하여 로그인 유저 식별자(전화번호/이름) 자동 추출
let myStoredPhone = localStorage.getItem('userPhone') || localStorage.getItem('phone') || '';
let myStoredName = window.currentUserName || localStorage.getItem('userName') || '';

for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const val = localStorage.getItem(key);
    if (val && typeof val === 'string') {
        if (val.includes('010-') || val.includes('010')) {
            const match = val.match(/010[-\d]+/);
            if (match) myStoredPhone = match[0];
        }
        if (key.toLowerCase().includes('user') || key.toLowerCase().includes('member') || val.includes('신윤채')) {
            try {
                const parsed = JSON.parse(val);
                if (parsed && typeof parsed === 'object') {
                    if (parsed.phone) myStoredPhone = parsed.phone;
                    if (parsed.name || parsed.username) myStoredName = parsed.name || parsed.username;
                }
            } catch(e) {}
        }
    }
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

socket.on('wifiStatus', (data) => {
    const prevWifiStatus = window.isGymWifiConnected;
    const isNowGymWifi = !!data.isGymWifi;
    window.isGymWifiConnected = isNowGymWifi;
    
    // 💡 클럽 고유 키 확인 (unjeong 등)
    const clubId = window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';
    const clubWifiKey = `useWifiRestriction_${clubId}`;
    const storedClubSetting = localStorage.getItem(clubWifiKey);

    // 1. 관리자 모드 로컬 설정값 우선 반영, 없으면 서버 데이터 활용
    if (storedClubSetting !== null) {
        window.useWifiRestriction = (storedClubSetting === 'true');
    } else if (typeof data.useWifiRestriction !== 'undefined') {
        window.useWifiRestriction = !!data.useWifiRestriction;
        localStorage.setItem(clubWifiKey, data.useWifiRestriction ? "true" : "false");
    }

    console.log(`📶 구장 Wi-Fi 제한 설정: ${window.useWifiRestriction ? 'ON(제한 중)' : 'OFF(자유 이용)'}`);
    console.log(`📶 현재 접속 상태: ${window.isGymWifiConnected ? '인증됨 (구장 내)' : '미인증 (외부 접속)'} (IP: ${data.clientIp})`);

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
    
    if (window.isGymWifiConnected) {
        // ==========================================
        // 🟢 체육관 와이파이 연결 (복귀)
        // ==========================================
        document.body.classList.add('gym-wifi-active');
        if (window.wifiGraceTimer) {
            clearTimeout(window.wifiGraceTimer);
            window.wifiGraceTimer = null;
        }

        // ⏱️ [서버 알림] 1분 미접속 대기열 삭제 타이머 즉시 해제
        if (currentPhone || currentName) {
            socket.emit('cancelDisconnectTimer', {
                phone: currentPhone,
                username: currentName,
                clubId: clubId
            });
        }

        if (typeof updateWifiRestrictedButtons === 'function') {
            updateWifiRestrictedButtons();
        }
    } else {
        // ==========================================
        // 🟡 체육관 와이파이 이탈 (LTE 전환 또는 단절)
        // ==========================================
        document.body.classList.remove('gym-wifi-active');

        // 이전에 와이파이였거나, 또는 새로고침 직후라도 미인증 상태로 이탈 확인 시 타이머 가동 보장
        if (prevWifiStatus === true || (prevWifiStatus !== false && (currentPhone || currentName))) {
            console.log('🔒 체육관 와이파이 이탈: 유예 타이머 시작 신호 전달 및 버튼 비활성화');
            
            // 🛡️ [핵심 보강] 서버에 Wi-Fi 이탈을 명시적으로 알려 1분 유예 타이머 가동 트리거
            if (currentPhone || currentName) {
                socket.emit('startDisconnectTimer', {
                    phone: currentPhone,
                    username: currentName,
                    clubId: clubId
                });
            }
        } else {
            console.log('🔒 외부 접속 상태: 기능 버튼 비활성화');
        }

        if (typeof updateWifiRestrictedButtons === 'function') {
            updateWifiRestrictedButtons();
        }

        // 💡 재접속 감지 엔진 가동 보장
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

    async function checkCurrentNetwork() {
        try {
            const clubId = window.currentClubId || localStorage.getItem('preferredClubId') || 'unjeong';
            const res = await fetch(`/api/check-wifi?clubId=${clubId}&_t=${Date.now()}`);
            if (!res.ok) return;
            const data = await res.json();

            // 🟢 Wi-Fi 접속 감지
            if (data.isGymWifi && !window.isGymWifiConnected) {
                console.log('🎉 구장 Wi-Fi 접속 확인 -> 버튼 활성화');
                window.isGymWifiConnected = true;
                document.body.classList.add('gym-wifi-active');

                if (typeof updateWifiRestrictedButtons === 'function') {
                    updateWifiRestrictedButtons();
                }

                const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
                if (activeSocket) {
                    if (!activeSocket.connected) {
                        activeSocket.connect();
                    }

                    // 💡 [핵심] 서버에 Wi-Fi 복귀(inGym: true)를 알려 타이머를 끄도록 요청!
                    const currentId = window.currentUserId || window.currentUserName || localStorage.getItem('userId') || localStorage.getItem('userName') || '';
                    activeSocket.emit('updateWifiState', { 
                        inGym: true, 
                        clubId: clubId, 
                        userId: currentId 
                    });
                }
            }
            // 🔴 Case 2: 켜져 있다가 Wi-Fi를 끄고 LTE로 이탈한 순간 감지!
            else if (!data.isGymWifi && window.isGymWifiConnected) {
                console.log('🔒 [이탈 감지] Wi-Fi 해제 확인 -> 버튼 즉시 비활성화');
                window.isGymWifiConnected = false;
                document.body.classList.remove('gym-wifi-active');

                if (typeof updateWifiRestrictedButtons === 'function') {
                    updateWifiRestrictedButtons();
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

// 💡 서버와 웹소켓 연결 성공
if (!socket.hasListeners('connect')) {
    socket.on('connect', () => {
        console.log("🟢 서버와 웹소켓 연결 성공 (ID:", socket.id, ")");
        
        // 1. 기존 세션 등록 유지 (자동 복귀 검증)
        const savedUser = localStorage.getItem("currentUser");
        if (savedUser) {
            try {
                const parsedUser = JSON.parse(savedUser);
                // 💡 phone, id, username 중 존재하는 키에서 유저 식별값 추출
                const userKey = parsedUser.phone || parsedUser.id || parsedUser.username;
                if (userKey) {
                    // isAutoRestore: true 를 함께 보내 '자동 복귀 시도'임을 서버에 알림
                    socket.emit('registerUserSession', { username: userKey, isAutoRestore: true });
                    console.log(`👤 [자동 등록 요청] 세션 만료 여부 검증: ${userKey}`);
                }
            } catch (e) {
                console.error("세션 유저 파싱 에러:", e);
            }
        }

        // 2. 🔔 개인 알림 전용 소켓 룸 자동 등록
        window.registerUserSocket();
    });
}

// 🚨 [필수 유지] 세션 만료 시 자동 로그아웃 처리
if (!socket.hasListeners('forceLogout')) {
    socket.on('forceLogout', (data) => {
        console.warn("⚠️ 세션 만료 강제 로그아웃 수신:", data);
        // 1. 브라우저에 남아있던 로그인 정보 완전 삭제
        localStorage.removeItem("currentUser");
        
        // 2. 만료 안내 알림창 표시
        const alertMsg = (data && data.message) ? data.message : "장시간 미접속으로 세션이 만료되었습니다. 다시 로그인해 주세요.";
        alert(alertMsg);
        
        // 3. 페이지 새로고침하여 로그인 화면으로 자동 이동
        location.reload();
    });
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

// 서버가 보낸 경고/안내 메시지
socket.off('alertMessage').on('alertMessage', (msg) => {
    alert(msg);
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

    // 소켓이 준비되었을 때 forceSessionExpire 리스너 장착
    function setupSessionExpireListener() {
        const activeSocket = (typeof socket !== 'undefined') ? socket : window.socket;
        if (activeSocket) {
            activeSocket.on('forceSessionExpire', (data) => {
                alert(data.message || '체육관을 벗어나 장시간 경과하여 자동 로그아웃되었습니다.');
                const targetClub = (typeof currentClubId !== 'undefined' && currentClubId) ? currentClubId : 'unjeong';
                localStorage.removeItem(`currentUser_${targetClub}`);
                localStorage.removeItem('currentUser');
                sessionStorage.clear();
                location.reload();
            });
        } else {
            setTimeout(setupSessionExpireListener, 500);
        }
    }
    setupSessionExpireListener();
})();