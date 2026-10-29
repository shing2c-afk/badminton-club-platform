let CONFIG = { ENTRY_TIMEOUT_SEC: 180, NANTA_COURT_LIMIT_SEC: 900, ENABLE_ALERT: true };
let courtsData = [];
let gameQueue = [];
let nantaQueue = [];
let notificationsList = [];

let currentUser = null;

let activeMergeSlotId = null;

// 💡 완벽하게 동명이인 및 텍스트 변경(색상 분리)에 대응하는 통합 검증 함수
window.isMyNameMatch = function(playerData, currentUser) {
    if (!playerData || !currentUser || !currentUser.name) return false;

    // 1. 내 정보 세팅 (순수 이름 추출)
    const myName = (currentUser.rawName || currentUser.name || "").replace(/\(일일\)/g, '').trim();
    const myGrade = (currentUser.level || currentUser.grade || "").trim();
    const isMeDaily = (currentUser.isGuest === true || myGrade.includes('일'));

    // 2. 비교할 대상 데이터 문자열화
    const pString = Array.isArray(playerData) ? playerData.join(',') : playerData;

    // 3. 비교 검사
    return pString.split(',').some(p => {
        const parts = p.split('/').map(item => item.trim());
        const pName = (parts[0] || "").replace(/\(일일\)/g, '').trim(); 
        const pGrade = parts[parts.length - 1] || "";

        // [검증 1] 이름이 정확하게 일치하는가?
        if (pName !== myName) return false;

        // [검증 2] 슬롯에 (일) 표식이 명시적으로 남아있는 구형 데이터인 경우에만 엄격 대조
        const hasDailyMark = (pGrade.includes('일') || p.includes('(일)'));
        if (hasDailyMark && !isMeDaily) {
            // 슬롯은 일일회원 표식인데 내가 정회원인 경우 제외
            return false;
        }

        return true; 
    });
};

// 📶 Wi-Fi 연결 상태 감시자: 상태 변경 시 즉시 body 클래스 갱신
(function() {
    let _wifiState = false;
    Object.defineProperty(window, 'isGymWifiConnected', {
        get() {
            return _wifiState;
        },
        set(val) {
            _wifiState = Boolean(val);
            if (_wifiState) {
                document.body.classList.add('gym-wifi-active');
            } else {
                document.body.classList.remove('gym-wifi-active');
            }
            if (typeof updateWifiRestrictedButtons === 'function') {
                updateWifiRestrictedButtons();
            }
        },
        configurable: true
    });
})();

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerText = msg;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3500);
}

function renderAll() {
    renderCourts();
    renderGameQueue();
    renderNantaQueue();
    updateAvailableCourtCounts();
    renderNotifications();
}

// ==========================================
// 🔔 [개인 알림] 키 관리, 렌더링, 실시간 필터링 수신 (통합본)
// ==========================================

// 🔑 1. 구장 및 로그인 사용자별 전용 스토리지 키 생성
function getNotiStorageKey() {
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const userKey = (typeof getClubStorageKey === 'function') 
                    ? getClubStorageKey("currentUser") 
                    : `currentUser_${clubId}`;
    const savedUser = localStorage.getItem(userKey) || localStorage.getItem("currentUser");
    
    let userId = 'guest';
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            userId = u.name || u.username || u.id || 'guest';
        } catch (e) {}
    }
    return `notifications_${clubId}_${String(userId).replace(/\s+/g, '')}`;
}

// 📋 2. 알림 UI 렌더링 및 당일 기준 자동 정리
function renderNotifications() {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const notiStorageKey = getNotiStorageKey();

    // 📥 로컬스토리지에서 내 알림 복원
    try {
        const stored = localStorage.getItem(notiStorageKey);
        window.notificationsList = stored ? JSON.parse(stored) : [];
    } catch (e) {
        window.notificationsList = [];
    }
    if (!Array.isArray(window.notificationsList)) window.notificationsList = [];

    // 🧹 [핵심] 당일(오늘) 알림만 남기고 어제 이전 알림은 자동 삭제
    window.notificationsList = window.notificationsList.filter(n => {
        if (!n) return false;
        let itemDateStr = n.date;
        if (!itemDateStr && n.timestamp) {
            const d = new Date(n.timestamp);
            itemDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        return itemDateStr === todayStr;
    });

    // 💾 정리된 목록 저장
    try {
        localStorage.setItem(notiStorageKey, JSON.stringify(window.notificationsList));
    } catch (e) {}

    // 🔔 뱃지 숫자 갱신
    const notiCountEl = document.getElementById('noti-count');
    if (notiCountEl) {
        notiCountEl.innerText = window.notificationsList.length;
        notiCountEl.style.display = window.notificationsList.length > 0 ? 'inline-block' : 'none';
    }

    // 📄 목록 DOM 렌더링
    const container = document.getElementById('noti-list');
    if (!container) return;

    if (window.notificationsList.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:#6b7280; font-size:12px; padding:20px 0;">새로운 알림이 없습니다.</div>`;
        return;
    }

    const safeEscape = (typeof escapeHtml === 'function') 
        ? escapeHtml 
        : (str) => String(str).replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));

    container.innerHTML = '';
    window.notificationsList.forEach(n => {
        const messageText = n.message || n.text || '';
        const timeText = n.time || (n.timestamp ? new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

        const html = `
            <div class="noti-item" style="padding:10px 12px; border-bottom:1px solid #333; font-size:13px;">
                <div style="color:#eee; margin-bottom:4px; word-break:break-all;">${safeEscape(messageText)}</div>
                <div class="noti-time" style="color:#888; font-size:11px;">${safeEscape(timeText)}</div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    });
}

// 📡 3. 실시간 소켓 알림 필터링 수신 (단일 선언)
function initNotificationSocket() {
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        setTimeout(initNotificationSocket, 500);
        return;
    }

    activeSocket.off('newNotification');

    activeSocket.on('newNotification', (noti) => {
        if (!noti) return;

        // 🏢 구장 검사
        const myClub = (typeof currentClubId !== 'undefined' && currentClubId) 
                    || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                    || new URLSearchParams(window.location.search).get('club') 
                    || 'default';

        if (noti.clubId && noti.clubId !== 'all' && noti.clubId !== 'default' && noti.clubId !== myClub) {
            return; // 다른 구장 이벤트 차단
        }

        // 👤 로그인 사용자 본인 정보 추출
        const userKey = (typeof getClubStorageKey === 'function') 
                        ? getClubStorageKey("currentUser") 
                        : `currentUser_${myClub}`;
        const savedUserStr = localStorage.getItem(userKey) || localStorage.getItem("currentUser");
        
        let myNames = [];
        if (savedUserStr) {
            try {
                const u = JSON.parse(savedUserStr);
                const rawName = (u.name || u.username || u.nickname || "").trim();
                if (rawName) {
                    myNames.push(rawName);
                    myNames.push(rawName.replace(/님$/, ''));
                }
            } catch (e) {}
        }

        if (myNames.length === 0) return;

        // 🎯 본인 관련 여부 판별 (메시지 본문 또는 targetUser에 내 이름이 포함되어 있는지)
        const msg = String(noti.message || '');
        const target = noti.targetUser ? (typeof noti.targetUser === 'object' ? JSON.stringify(noti.targetUser) : String(noti.targetUser)) : '';

        const isForMe = myNames.some(name => name && (msg.includes(name) || target.includes(name)));

        if (!isForMe) return; // 타인 이벤트 차단

        // 📥 내 알림 목록에 추가 및 화면 갱신
        if (!Array.isArray(window.notificationsList)) window.notificationsList = [];
        window.notificationsList.unshift(noti);
        if (window.notificationsList.length > 30) window.notificationsList.pop();

        try {
            localStorage.setItem(getNotiStorageKey(), JSON.stringify(window.notificationsList));
        } catch (e) {}

        renderNotifications();
    });
}

// 🚀 4. 화면 로딩 시 자동 초기화 (단 1회만 등록)
function startNotificationSystem() {
    renderNotifications();
    initNotificationSocket();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startNotificationSystem);
} else {
    startNotificationSystem();
}

function openNotiModal() { 
    const modal = document.getElementById('noti-modal');
    if (modal) modal.style.display = 'flex'; 
}
function closeNotiModal() { 
    const modal = document.getElementById('noti-modal');
    if (modal) modal.style.display = 'none'; 
}

async function accessAdmin() {
    const inputPw = await prompt('🔐 관리자 비밀번호를 입력해 주세요:');
    if (inputPw === null) return;

    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다.");
        return;
    }

    activeSocket.emit('verifyAdminPassword', inputPw.trim(), (response) => {
        if (response.success) {
            window.location.href = '/admin.html';
        } else {
            alert('❌ 비밀번호가 일치하지 않습니다.');
        }
    });
}

function formatTime(sec) {
    if (sec <= 0 || sec === null || sec === undefined) return "00:00";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getValidPlayers(arr) {
    return arr.filter(p => p && p.trim() !== '');
}

function getAvailableGameCourtsCount() {
    return courtsData.filter(c => c.type === 'game' && c.isEmpty).length;
}

function getAvailableNantaCourtsCount() {
    let count = 0;
    courtsData.forEach(c => {
        if (c.type === 'nanta') {
            if (c.sideA && c.sideA.isEmpty) count += 1;
            if (c.sideB && c.sideB.isEmpty) count += 1;
        }
    });
    return count;
}

function formatCourtPlayers(playersStr) {
    if (!playersStr) return '';
    const plist = playersStr.split(',').map(p => p.trim());
    if (plist.length >= 4) {
        return `${escapeHtml(plist[0])}, ${escapeHtml(plist[1])}<br>${escapeHtml(plist[2])}, ${escapeHtml(plist[3])}`;
    }
    return escapeHtml(playersStr);
}

function renderCourts() {
    const courtList = document.getElementById('court-status-list');
    if (!courtList) return;
    courtList.innerHTML = '';

    // 💡 1. 멀티테넌트 환경에 맞게 유저 '전체 객체'를 가져옵니다.
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';
    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    let currentUser = {};
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {}
    }

    function formatPlayersToLines(playersInput) {
        if (!playersInput) return '';
        let pArray = [];

        if (Array.isArray(playersInput)) {
            pArray = playersInput;
        } else if (typeof playersInput === 'string') {
            pArray = playersInput.split(',').map(item => item.trim());
        }

        return pArray
            .filter(p => p && p.trim().length > 0)
            .map(p => {
                // 🎯 일일회원 판별: |guest 마커가 포함되어 있거나 '일일' 키워드가 들어있는 경우
                const isGuestUser = p.includes('guest') || p.includes('일일');
                
                // 💡 화면 출력 시 숨김 마커(|guest) 제거 및 슬래시 간격 정리
                let cleanStr = p.replace(/\|?guest/gi, '').trim();
                if (cleanStr.includes('/')) {
                    cleanStr = cleanStr.split('/').map(part => part.trim()).join(' / ');
                }

                // 🎨 일일회원은 클래스와 함께 직접 인라인 색상(하늘색)을 강제 적용
                const guestClass = isGuestUser ? 'guest-text' : '';
                const guestInlineStyle = isGuestUser ? 'style="color: #38bdf8 !important;"' : '';

                return `<div class="${guestClass}" ${guestInlineStyle}>${escapeHtml(cleanStr)}</div>`;
            })
            .join('');
    }

    // 💡 2. 만능 함수(isMyNameMatch)로 연결시키는 스위치
    const exactMatchUser = (playersData) => {
        return typeof window.isMyNameMatch === 'function' ? window.isMyNameMatch(playersData, currentUser) : false;
    };

    courtsData.forEach(court => {
        let html = '';
        
        if (court.type === 'game') {
            if (court.isEmpty) {
                html = `
                    <div class="court-row">
                        <div class="court-head-info">
                            <span class="court-num">${court.id}번 코트</span>
                            <span class="type-badge badge-game">게임 코트</span>
                        </div>
                        <div class="empty-court-box">✨ 빈 코트</div>
                    </div>`;
            } else {
                let isUserOnThisCourt = exactMatchUser(court.players);

                let gameActionBtns = '';
                if (isUserOnThisCourt) {
                    gameActionBtns = `
                        <button class="btn-court-ctrl btn-again" onclick="clickAgain(${court.id})">한 게임 더</button>
                        <button class="btn-court-ctrl btn-end" onclick="clickEnd(${court.id})">게임 종료</button>
                    `;
                } else {
                    gameActionBtns = `
                        <button class="btn-court-ctrl btn-again" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">한 게임 더</button>
                        <button class="btn-court-ctrl btn-end" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">게임 종료</button>
                    `;
                }

                html = `
                    <div class="court-row">
                        <div class="court-head-info">
                            <span class="court-num">${court.id}번 코트</span>
                            <span class="type-badge badge-game">게임 코트</span>
                        </div>
                        <div class="court-body-game">
                            <div class="court-players">${formatPlayersToLines(court.players)}</div>
                            <div class="court-timer-off"></div>
                            <div>
                                ${gameActionBtns}
                            </div>
                        </div>
                    </div>`;
            }
        } 
        else if (court.type === 'nanta') {
            let isUserOnSideA = court.sideA ? exactMatchUser(court.sideA.players) : false;
            let isUserOnSideB = court.sideB ? exactMatchUser(court.sideB.players) : false;

            const sideABtn = isUserOnSideA ? 
                `<button class="btn-court-ctrl btn-end" onclick="clickNantaEnd(${court.id}, 'sideA')">난타 종료</button>` :
                `<button class="btn-court-ctrl btn-end" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">난타 종료</button>`;

            const sideBBtn = isUserOnSideB ? 
                `<button class="btn-court-ctrl btn-end" onclick="clickNantaEnd(${court.id}, 'sideB')">난타 종료</button>` :
                `<button class="btn-court-ctrl btn-end" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">난타 종료</button>`;

            const sideAContent = (court.sideA && court.sideA.isEmpty) ? 
                `<div class="nanta-empty-text">+ A코트 (반 코트 이용)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">A코트</span>
                    <span class="nanta-timer-badge">⏱ ${formatTime(court.sideA ? court.sideA.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players">${formatPlayersToLines(court.sideA ? court.sideA.players : '')}</div>
                 ${sideABtn}`;

            const sideBContent = (court.sideB && court.sideB.isEmpty) ? 
                `<div class="nanta-empty-text">+ B코트 (반 코트 이용)</div>` :
                `<div class="nanta-card-head">
                    <span class="nanta-label">B코트</span>
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideB ? court.sideB.remainingSeconds : 0)}</span>
                 </div>
                 <div class="court-players">${formatPlayersToLines(court.sideB ? court.sideB.players : '')}</div>
                 ${sideBBtn}`;

            html = `
                <div class="court-row">
                    <div class="court-head-info">
                        <span class="court-num">${court.id}번 코트</span>
                        <span class="type-badge badge-nanta">난타 코트</span>
                    </div>
                    <div class="nanta-sub-grid">
                        <div class="nanta-card">${sideAContent}</div>
                        <div class="nanta-card">${sideBContent}</div>
                    </div>
                </div>`;
        } 
        else if (court.type === 'lesson') {
            html = `
                <div class="court-row">
                    <div class="court-head-info">
                        <span class="court-num">${court.id}번 코트</span>
                        <span class="type-badge badge-lesson">레슨 코트</span>
                    </div>
                    <div style="background:#1f2937; padding:10px; border-radius:6px; text-align:center; color:#c084fc; font-size:12px;">
                        ${escapeHtml(court.players || '레슨 전용 코트')}
                    </div>
                </div>`;
        }
        courtList.insertAdjacentHTML('beforeend', html);
    });
}

function renderGameQueue() {
    const container = document.getElementById('game-slot-list');
    if (!container) return;

    // 💡 1. 완벽한 유저 객체 추출 (멀티테넌트 대응)
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    let currentUser = {};
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {}
    }

    function formatPlayerText(playerStr) {
        if (!playerStr) return '';
        // 💡 화면 출력 시 숨김 마커(|guest)를 깨끗하게 제거
        let cleanStr = playerStr.replace('|guest', '').trim();
        if (cleanStr.includes('/')) {
            return cleanStr.split('/').map(part => part.trim()).join(' / ');
        }
        return cleanStr;
    }

    // 💡 2. 복잡한 이름 비교 로직을 만능 함수 단 한 줄로 교체
    function isMePlayer(p) {
        return window.isMyNameMatch(p, currentUser);
    }

    // 💡 3. 코트 사용 중인지 검사 (부분 일치 버그 원천 차단)
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);
    const isPlayingGame = activeCourts.some(c => {
        if (!c || c.type !== 'game' || !c.players) return false;
        return window.isMyNameMatch(c.players, currentUser);
    });

    // 2. 대기열 확인 (내가 이미 게임 대기열 어느 방이든 들어가 있는지)
    const amIInGameQueue = gameQueue.some(slot => 
        slot.players && slot.players.some(p => isMePlayer(p))
    );

   // 💡 내가 이미 방에 들어있는지 완벽 검증 (로그인한 내 이름과 슬롯 안의 플레이어 비교)
    const amIActuallyInQueue = gameQueue.some(slot => 
        slot.players && slot.players.some(p => typeof isMePlayer === 'function' ? isMePlayer(p) : false)
    );

    const cannotJoinGame = amIActuallyInQueue || (typeof isPlayingGame !== 'undefined' && isPlayingGame);

    if (gameQueue.length === 0) {
        container.innerHTML = `<div class="empty-queue-msg">현재 대기 중인 게임 방이 없습니다.</div>`;
        return;
    }

    const allSlotsHtml = [];

    gameQueue.forEach((slot, idx) => {
        const rank = idx + 1;
        let playerCellsHtml = '';

        for (let i = 0; i < 4; i++) {
            const p = slot.players[i];
            if (p && p.trim() !== '') {
                const isMe = isMePlayer(p);
                const formattedPlayer = formatPlayerText(p);

                // 🎯 일일회원 판별: |guest 마커가 있거나 급수가 '일일'인 경우
                const isGuestUser = p.includes('|guest') 
                    || p.trim().endsWith('/ 일일') 
                    || p.trim().endsWith('/일일');
                const guestClass = isGuestUser ? 'guest-text' : '';

                // 💡 [수정] 연속 게임 제한(페널티) 적용 회원은 '이름'만 선명한 주황색(#fb923c)으로 강조
                // (뒤쪽의 '/ 성별 / 나이 / 급수'는 정회원·일일회원 고유 색상을 그대로 유지)
                const isPenaltyUser = Boolean(slot.penaltyApplied && slot.penaltyApplied[i]);
                let displayPlayerHtml = escapeHtml(formattedPlayer);

                if (isPenaltyUser) {
                    const parts = formattedPlayer.split('/');
                    const playerName = escapeHtml(parts[0] || '');
                    const playerRest = parts.length > 1 ? '/' + escapeHtml(parts.slice(1).join('/')) : '';
                    displayPlayerHtml = `<span style="color: #fb923c !important; font-weight: 800;" title="연속 게임 제한 시간 내 참여 (순위 조정됨)">${playerName}</span>${playerRest}`;
                }

                // [퇴장 버튼]: 본인 칸만 활성화 (일일회원인 경우 guestClass 적용)
                if (isMe) {
                    playerCellsHtml += `
                        <div class="player-cell">
                            <span class="player-info ${guestClass}">${displayPlayerHtml}</span>
                            <button class="btn-exit" onclick="exitGamePlayer('${slot.id}', ${i})">퇴장</button>
                        </div>`;
                } else {
                    playerCellsHtml += `
                        <div class="player-cell">
                            <span class="player-info ${guestClass}">${displayPlayerHtml}</span>
                            <button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button>
                        </div>`;
                }
            } else {
                // [게임참여 버튼]: 경기 중이거나 이미 대기 중인 경우 비활성화
                if (cannotJoinGame) {
                    playerCellsHtml += `
                        <div class="player-cell" data-cannot-join="true" style="background:#242730 !important; border:1px solid #333a48 !important; cursor:not-allowed !important;">
                            <span class="empty-cell" style="color:#6b7280 !important; pointer-events:none !important; opacity:0.8 !important;">게임참여</span>
                        </div>`;
                } else {
                    playerCellsHtml += `
                        <div class="player-cell empty-slot" onclick="joinGameCell('${slot.id}', ${i})">
                            <span class="empty-cell">게임참여</span>
                        </div>`;
                }
            }
        }

        const validPlayersCount = getValidPlayers(slot.players).length;
        const isMySlotGame = slot.players && slot.players.some(p => isMePlayer(p));

       // 1. [코트 입장 버튼]: 4명이 모두 차고, 내가 해당 방의 멤버일 때만 활성화
        const isFullGame = (validPlayersCount === 4);
        let gameEnterBtnHtml = '';
        if (isFullGame && isMySlotGame) {
            gameEnterBtnHtml = `<button class="btn-action btn-enter" onclick="enterGameCourt('${slot.id}')" style="background: #10b981; color: #fff; cursor: pointer; opacity: 1;">코트 입장</button>`;
        } else {
            gameEnterBtnHtml = `<button class="btn-action btn-enter" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">코트 입장</button>`;
        }

        // 2. [게임 통합 버튼]: 1~3명 대기 중이고, 내가 해당 방의 멤버일 때만 활성화
        const isMergeableCount = (validPlayersCount >= 1 && validPlayersCount < 4);
        let gameMergeBtnHtml = '';
        if (isMergeableCount && isMySlotGame) {
            gameMergeBtnHtml = `<button class="btn-action btn-merge" onclick="mergeGameSlot('${slot.id}')" style="background: #8b5cf6; color: #fff; cursor: pointer; opacity: 1;">게임 통합</button>`;
        } else {
            gameMergeBtnHtml = `<button class="btn-action btn-merge" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">게임 통합</button>`;
        }

        // 3. [게임 통합 메뉴]: 합쳐서 4명이 되는 슬롯만 표시 (기존 유지)
        let mergeMenuHtml = '';
        if (activeMergeSlotId === slot.id) {
            const targetSlots = gameQueue.filter(s => {
                if (s.id === slot.id) return false;
                const targetValid = getValidPlayers(s.players);
                return (validPlayersCount + targetValid.length === 4);
            });

            let listHtml = '';
            if (targetSlots.length === 0) {
                listHtml = `<div style="color: #888; font-size: 12px; padding: 6px 0;">합칠 수 있는 대기 방이 없습니다.</div>`;
            } else {
                targetSlots.forEach((targetSlot) => {
                    const targetRank = gameQueue.findIndex(s => s.id === targetSlot.id) + 1;
                    
                    // 🎯 통합 대상 멤버 목록: 일일회원은 하늘색 span 태그로 감싸서 구분
                    const rawPlayersList = getValidPlayers(targetSlot.players).map(p => {
                        const isGuest = p.includes('|guest') 
                            || p.trim().endsWith('/ 일일') 
                            || p.trim().endsWith('/일일');
                        const cleanText = escapeHtml(formatPlayerText(p));
                        return isGuest ? `<span style="color: #38bdf8; font-weight: 600;">${cleanText}</span>` : cleanText;
                    });
                    const playersStr = rawPlayersList.join(", ");

                    listHtml += `
                        <div class="merge-option-item" onclick="confirmAndExecuteMerge('${slot.id}', '${targetSlot.id}', ${targetRank})" style="padding: 10px 12px; margin-bottom: 6px; background: #1e1e2f; border: 1px solid #7c3aed; border-radius: 6px; cursor: pointer;">
                            <div style="font-weight: bold; color: #a78bfa; font-size: 13px;">📌 ${targetRank}순위 방과 통합</div>
                            <div style="color: #cbd5e1; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">멤버: ${playersStr}</div>
                        </div>
                    `;
                });
            }

            mergeMenuHtml = `
                <div class="merge-dropdown-menu" style="margin-top: 10px; padding: 12px; background: #111118; border: 1px solid #4c1d95; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 13px; font-weight: bold; color: #fff;">🔄 합칠 대기 방을 선택하세요</span>
                        <span onclick="activeMergeSlotId = null; renderGameQueue();" style="cursor: pointer; color: #888; font-size: 14px; padding: 0 4px;">✕</span>
                    </div>
                    ${listHtml}
                </div>
            `;
        }

        const timerText = slot.remainingSeconds !== null ? `⏱️ 입장제한 ${formatTime(slot.remainingSeconds)}` : '대기중';
        const timerClass = slot.remainingSeconds !== null ? '' : 'idle';

        allSlotsHtml.push(`
            <div class="slot-card game-slot">
                <div class="slot-header">
                    <span class="rank-badge">${rank}순위</span>
                    <span class="timer-badge ${timerClass}">${timerText}</span>
                </div>
                <div class="players-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">${playerCellsHtml}</div>
                <div class="slot-footer">
                    ${gameEnterBtnHtml}
                    ${gameMergeBtnHtml}
                </div>
                ${mergeMenuHtml}
            </div>
        `);
    });

    container.innerHTML = allSlotsHtml.join('');

    // 💡 DOM 렌더링 완료 후 단 1회만 스타일 동기화 (1차/2차 중첩 및 새로고침 암전 방지)
    if (typeof updateWifiRestrictedButtons === 'function') {
        requestAnimationFrame(() => {
            updateWifiRestrictedButtons();
        });
    }
}

function mergeGameSlot(slotId) {
    // 💡 [Wi-Fi 검사 통일] 구장 전용 안내창 호출 및 미연결 시 통합 메뉴 오픈 차단
    if (!checkGymWifiOrAlert()) return;

    // 💡 1. 완벽한 유저 객체 추출 (멀티테넌트 대응)
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    let currentUser = {};
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {}
    }

    const currentSlot = gameQueue.find(s => s.id === slotId);
    if (!currentSlot) return;

    const currentValidPlayers = getValidPlayers(currentSlot.players);
    
    // 💡 2. 길고 복잡했던 isMePlayer 함수를 지우고, 만능 함수(isMyNameMatch) 한 줄로 완벽 교체!
    const isMySlot = currentSlot.players.some(p => window.isMyNameMatch(p, currentUser));
    
    if (!isMySlot || currentValidPlayers.length === 0 || currentValidPlayers.length >= 4) return;

    const targetSlots = gameQueue.filter(s => {
        if (s.id === slotId) return false;
        const targetValid = getValidPlayers(s.players);
        return (currentValidPlayers.length + targetValid.length === 4);
    });

    if (targetSlots.length === 0) {
        alert("현재 인원을 합쳐 4명을 만들 수 있는 대기 방이 없습니다.");
        return;
    }

    if (activeMergeSlotId === slotId) {
        activeMergeSlotId = null;
    } else {
        activeMergeSlotId = slotId;
    }

    renderGameQueue();
}

async function confirmAndExecuteMerge(mySlotId, targetSlotId, targetRank) {
    const confirmed = await confirm(`[${targetRank}순위 방]과 통합하시겠습니까?\n(합쳐진 총 인원: 4명)`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('mergeSlot', { 
                mySlotId: mySlotId, 
                targetSlotId: targetSlotId 
            });
            activeMergeSlotId = null;
        }
    }
}

function renderNantaQueue() {
    const container = document.getElementById('nanta-slot-list');
    if (!container) return;

    // 💡 1. 완벽한 유저 객체 추출 (멀티테넌트 대응)
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    let currentUser = {};
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {}
    }

    function formatPlayerText(playerStr) {
        if (!playerStr) return '';
        // 💡 화면 출력 시 숨김 마커(|guest)를 깨끗하게 제거
        let cleanStr = playerStr.replace('|guest', '').trim();
        if (cleanStr.includes('/')) {
            return cleanStr.split('/').map(part => part.trim()).join(' / ');
        }
        return cleanStr;
    }

    // 💡 2. 복잡하고 구멍 많던 includes 기반 검사를 '만능 함수' 단 한 줄로 교체!
    function isMePlayer(p) {
        return window.isMyNameMatch(p, currentUser);
    }

    // 💡 3. 코트 사용 중인지 검사하는 로직도 정확하게 비교하도록 수정 (부분 일치 버그 원천 차단)
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);
    const isPlayingAnyCourt = activeCourts.some(c => {
        if (!c) return false;
        if (c.type === 'game' && c.players) {
            return window.isMyNameMatch(c.players, currentUser);
        }
        if (c.type === 'nanta') {
            const sideA = c.sideA && c.sideA.players ? window.isMyNameMatch(c.sideA.players, currentUser) : false;
            const sideB = c.sideB && c.sideB.players ? window.isMyNameMatch(c.sideB.players, currentUser) : false;
            return sideA || sideB;
        }
        return false;
    });

    // 2. 난타 대기열 확인
    const amIInNantaQueue = nantaQueue.some(slot => 
        slot.players && slot.players.some(p => isMePlayer(p))
    );

    // 💡 난타 대기열에 내가 이미 참여 중인지 100% 확실하게 체크
    const amIActuallyInNanta = nantaQueue.some(slot => 
    slot.players && slot.players.some(p => typeof isMePlayer === 'function' ? isMePlayer(p) : false)
    );

    // 이미 난타 대기 중이거나 난타 경기 중일 때 비활성화
    const cannotJoinNanta = amIActuallyInNanta || (typeof isPlayingNanta !== 'undefined' && isPlayingNanta);

    if (nantaQueue.length === 0) {
        container.innerHTML = `<div class="empty-queue-msg">현재 대기 중인 난타 방이 없습니다.</div>`;
        return;
    }

    const allNantaSlotsHtml = [];

    nantaQueue.forEach((slot, idx) => {
        const rank = idx + 1;
        let playerCellsHtml = '';

        for (let i = 0; i < 2; i++) {
            const p = slot.players[i];
            if (p && p.trim() !== '') {
                const isMe = isMePlayer(p);
                const formattedPlayer = formatPlayerText(p);

                // 🎯 일일회원 판별: |guest 마커가 있거나 급수가 '일일'인 경우
                const isGuestUser = p.includes('|guest') 
                    || p.trim().endsWith('/ 일일') 
                    || p.trim().endsWith('/일일');
                const guestClass = isGuestUser ? 'guest-text' : '';

                // [난타종료 버튼]: 본인 칸만 활성화 (일일회원인 경우 guestClass 적용)
                if (isMe) {
                    playerCellsHtml += `
                        <div class="player-cell">
                            <span class="player-info ${guestClass}">${escapeHtml(formattedPlayer)}</span>
                            <button class="btn-exit" onclick="exitNantaPlayer('${slot.id}', ${i})">퇴장</button>
                        </div>`;
                } else {
                    playerCellsHtml += `
                        <div class="player-cell">
                            <span class="player-info ${guestClass}">${escapeHtml(formattedPlayer)}</span>
                            <button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button>
                        </div>`;
                }
            } else {
                // [난타참여 버튼]: 이미 난타 대기 중이거나 경기 중이면 애초부터 회색으로 즉시 렌더링 (깜빡임 방지)
                if (cannotJoinNanta) {
                    playerCellsHtml += `
                    <div class="player-cell" data-cannot-join="true" style="background:#242730 !important; border:1px solid #333a48 !important; cursor:not-allowed !important;">
                    <span class="empty-cell" style="color:#6b7280 !important; pointer-events:none !important; opacity:0.8 !important;">난타참여</span>
                    </div>`;
            } else {
                    playerCellsHtml += `
                        <div class="player-cell empty-slot" onclick="joinNantaCell('${slot.id}', ${i})">
                        <span class="empty-cell">난타참여</span>
                        </div>`;
                    }
                }
        }

        const validNantaCount = getValidPlayers(slot.players).length;
        const isMySlotNanta = slot.players && slot.players.some(p => isMePlayer(p));

        // [코트 입장 버튼]: 2명이 모두 차고, 내가 해당 방의 멤버일 때만 활성화
        const isFullNanta = (validNantaCount === 2);
        let nantaEnterBtnHtml = '';
        if (isFullNanta && isMySlotNanta) {
            nantaEnterBtnHtml = `<button class="btn-action btn-enter" onclick="enterNantaCourt('${slot.id}')" style="background: #10b981; color: #fff; cursor: pointer; opacity: 1;">코트 입장</button>`;
        } else {
            nantaEnterBtnHtml = `<button class="btn-action btn-enter" disabled style="background: #2a2a2a; color: #777; cursor: not-allowed; opacity: 0.6;">코트 입장</button>`;
        }

        const timerText = slot.remainingSeconds !== null ? `⏱️ 입장제한 ${formatTime(slot.remainingSeconds)}` : '대기중';
        const timerClass = slot.remainingSeconds !== null ? '' : 'idle';

        allNantaSlotsHtml.push(`
            <div class="slot-card nanta-slot">
                <div class="slot-header">
                    <span class="rank-badge" style="color:#f97316;">${rank}순위</span>
                    <span class="timer-badge ${timerClass}">${timerText}</span>
                </div>
                <div class="players-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px;">${playerCellsHtml}</div>
                <div class="slot-footer">
                    ${nantaEnterBtnHtml}
                </div>
            </div>
        `);
    });

    container.innerHTML = allNantaSlotsHtml.join('');
}

function updateAvailableCourtCounts() {
    const gameAvail = document.getElementById('game-available-count');
    const nantaAvail = document.getElementById('nanta-available-count');
    if (gameAvail) gameAvail.innerText = getAvailableGameCourtsCount();
    if (nantaAvail) nantaAvail.innerText = getAvailableNantaCourtsCount();
}

// ==========================================
// 1. 게임방 개설 (구장별 세션 반영 및 방어 로직 완비)
// ==========================================
async function createNewGameSlot() {
    // 💡 [Wi-Fi 검사 최우선 차단] 접속/단절 시 가장 먼저 검사 후 차단
    if (!checkGymWifiOrAlert()) return;

    // 🔑 현재 구장 식별 및 구장 전용 키 조회
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    let currentUser;
    try {
        currentUser = JSON.parse(savedUser);
    } catch (e) {
        alert("사용자 정보를 불러오는 중 오류가 발생했습니다.");
        return;
    }

    // 💡 [수정 1] 빈 값이라도 공백을 유지하여 filter(Boolean) 누락 방지 및 4칸(슬래시 3개) 강제
    const rawName = (currentUser.name || currentUser.username || "").trim();
    const cleanName = rawName.replace(/님$/, '').trim();
    const gender = (currentUser.gender || " ").trim() || " ";
    const age = (currentUser.age || currentUser.ageGroup || " ").trim() || " ";
    const level = (currentUser.level || currentUser.grade || " ").trim() || " ";

    if (!cleanName) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    // 🎯 일일회원 여부 판별 및 |guest 마커 부착
    const isGuest = currentUser.isGuest === true 
                 || (currentUser.grade && currentUser.grade.includes('일')) 
                 || (currentUser.level && currentUser.level.includes('일'));

    let formattedPlayerInfo = [cleanName, gender, age, level].join(" / ");
    if (isGuest && !formattedPlayerInfo.includes('|guest')) {
        formattedPlayerInfo += '|guest';
    }

    // 💡 [수정 2] 모든 중복/진행 검사에 '만능 함수(isMyNameMatch)' 적용하여 동명이인 원천 차단
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);
    
    // 게임 코트에서 실제 경기 중인지 검사
    const isPlayingGame = activeCourts.some(c => {
        if (!c || c.type !== 'game' || !c.players) return false;
        return window.isMyNameMatch(c.players, currentUser);
    });

    if (isPlayingGame) {
        alert(`⚠️ ${cleanName} 님은 현재 게임 코트에서 경기 중이므로 새로운 게임방을 개설할 수 없습니다.`);
        return;
    }

    // 2. 게임 대기열 확인
    const activeGameQueue = (typeof gameQueue !== 'undefined' && gameQueue) ? gameQueue : (window.gameQueue || []);
    const isWaitingGame = activeGameQueue.some(slot => {
        if (!slot || !slot.players) return false;
        return window.isMyNameMatch(slot.players, currentUser);
    });

    if (isWaitingGame) {
        alert(`⚠️ ${cleanName} 님은 이미 게임에 참여(대기) 중이므로 새로운 게임방을 개설할 수 없습니다.`);
        return;
    }

    // 3. 난타 대기열 확인 (교차 선택창 1회)
    const activeNantaQueue = (typeof nantaQueue !== 'undefined' && nantaQueue) ? nantaQueue : (window.nantaQueue || []);
    const isWaitingNanta = activeNantaQueue.some(slot => {
        if (!slot || !slot.players) return false;
        return window.isMyNameMatch(slot.players, currentUser);
    });

    if (isWaitingNanta) {
        const confirmSwitch = await confirm(`현재 난타 대기 상태입니다. 게임 방을 개설하시면 기존 난타 대기 상태에 영향을 줄 수 있습니다. 진행하시겠습니까?`);
        if (!confirmSwitch) return;

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('forceCreateSlot', { type: 'game', userId: currentUser.id || currentUser.userId, user: formattedPlayerInfo });
        }
        return;
    }

    // 정상 게임방 개설 요청
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'game', userId: currentUser.id || currentUser.userId, user: formattedPlayerInfo });
}

// ==========================================
// 2. 난타방 개설 (문구 통일 및 완벽 방어)
// ==========================================
async function createNewNantaSlot() {
    // 💡 [Wi-Fi 검사 최우선 차단] 접속/단절 시 가장 먼저 검사 후 차단
    if (!checkGymWifiOrAlert()) return;

    // 🔑 현재 구장 식별 및 구장 전용 키 조회
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    let currentUser;
    try {
        currentUser = JSON.parse(savedUser);
    } catch (e) {
        alert("사용자 정보를 불러오는 중 오류가 발생했습니다.");
        return;
    }

    // 💡 [수정 1] 빈 값이라도 공백을 유지하여 filter(Boolean) 누락 방지 및 4칸(슬래시 3개) 강제
    const rawName = (currentUser.name || currentUser.username || "").trim();
    const cleanName = rawName.replace(/님$/, '').trim();
    const gender = (currentUser.gender || " ").trim() || " ";
    const age = (currentUser.age || currentUser.ageGroup || " ").trim() || " ";
    const level = (currentUser.level || currentUser.grade || " ").trim() || " ";

    if (!cleanName) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    // 🎯 일일회원 여부 판별 및 |guest 마커 부착
    const isGuest = currentUser.isGuest === true 
                 || (currentUser.grade && currentUser.grade.includes('일')) 
                 || (currentUser.level && currentUser.level.includes('일'));

    let formattedPlayerInfo = [cleanName, gender, age, level].join(" / ");
    if (isGuest && !formattedPlayerInfo.includes('|guest')) {
        formattedPlayerInfo += '|guest';
    }

    // 💡 [수정 2] 모든 중복/진행 검사에 '만능 함수(isMyNameMatch)' 적용하여 동명이인/부분일치 원천 차단
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);

    // A. 난타 코트 플레이 중인지 검사
    const isPlayingNanta = activeCourts.some(c => {
        if (!c || c.type !== 'nanta') return false;
        const sideA = c.sideA && c.sideA.players ? window.isMyNameMatch(c.sideA.players, currentUser) : false;
        const sideB = c.sideB && c.sideB.players ? window.isMyNameMatch(c.sideB.players, currentUser) : false;
        return sideA || sideB;
    });

    if (isPlayingNanta) {
        alert(`⚠️ ${cleanName} 님은 현재 난타 코트에서 플레이 중이므로 새로운 난타방을 개설할 수 없습니다.`);
        return;
    }

    // B. 게임 코트 경기 중인지 검사
    const isPlayingGame = activeCourts.some(c => {
        if (!c || c.type !== 'game' || !c.players) return false;
        return window.isMyNameMatch(c.players, currentUser);
    });

    if (isPlayingGame) {
        alert(`⚠️ ${cleanName} 님은 현재 게임 코트에서 경기 중이므로 새로운 난타방을 개설할 수 없습니다.`);
        return;
    }

    // 2. 난타 대기열 확인
    const activeNantaQueue = (typeof nantaQueue !== 'undefined' && nantaQueue) ? nantaQueue : (window.nantaQueue || []);
    const isWaitingNanta = activeNantaQueue.some(slot => {
        if (!slot || !slot.players) return false;
        return window.isMyNameMatch(slot.players, currentUser);
    });

    if (isWaitingNanta) {
        alert(`⚠️ ${cleanName} 님은 이미 난타에 참여(대기) 중이므로 새로운 난타방을 개설할 수 없습니다.`);
        return;
    }

    // 3. 게임 대기열 확인 (교차 확인창 1회)
    const activeGameQueue = (typeof gameQueue !== 'undefined' && gameQueue) ? gameQueue : (window.gameQueue || []);
    const isWaitingGame = activeGameQueue.some(slot => {
        if (!slot || !slot.players) return false;
        return window.isMyNameMatch(slot.players, currentUser);
    });

    if (isWaitingGame) {
        const confirmSwitch = await confirm(`현재 게임 대기 상태입니다. 난타 방을 개설하시면 기존 게임 대기 상태에 영향을 줄 수 있습니다. 진행하시겠습니까?`);
        if (!confirmSwitch) return;

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('forceCreateSlot', { type: 'nanta', userId: currentUser.id || currentUser.userId, user: formattedPlayerInfo });
        }
        return;
    }

    // 정상 난타방 개설 요청
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'nanta', userId: currentUser.id || currentUser.userId, user: formattedPlayerInfo });
}

async function joinGameCell(slotId, idx) {
    // 💡 [Wi-Fi 검사 통일] 구장 전용 안내창 호출 및 미연결 시 차단
    if (!checkGymWifiOrAlert()) return;

    // 🔑 현재 구장 식별 및 구장 전용 키 조회
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    let u;
    try {
        u = JSON.parse(savedUser);
    } catch (e) {
        alert("사용자 정보를 불러오는 중 오류가 발생했습니다.");
        return;
    }

    // 💡 [수정] 빈 값이라도 공백을 유지하여 4칸(슬래시 3개) 강제 유지
    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || " ").trim() || " ";
    const age = (u.age || u.ageGroup || " ").trim() || " ";
    const level = (u.level || u.grade || " ").trim() || " ";

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    // 💡 [수정] 일일회원 여부(isGuest)를 히든 마커로 안전하게 포함
    const guestTag = u.isGuest ? '|guest' : '';
    const formattedPlayerInfo = [name, gender, age, level].join(" / ") + guestTag;

    // 🎯 팝업창에는 |guest를 제외한 깨끗한 정보만 표시
    const displayPlayerInfo = [name, gender, age, level].join(" / ");

    const confirmed = await confirm(`[${displayPlayerInfo}]로 게임에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'game', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

async function joinNantaCell(slotId, idx) {
    // 💡 [Wi-Fi 검사 통일] 구장 전용 안내창 호출 및 미연결 시 차단
    if (!checkGymWifiOrAlert()) return;

    // 🔑 현재 구장 식별 및 구장 전용 키 조회
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    let u;
    try {
        u = JSON.parse(savedUser);
    } catch (e) {
        alert("사용자 정보를 불러오는 중 오류가 발생했습니다.");
        return;
    }

    // 💡 [수정] 빈 값이라도 안전하게 공백 하나를 남기도록 처리합니다.
    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || " ").trim() || " ";
    const age = (u.age || u.ageGroup || " ").trim() || " ";
    const level = (u.level || u.grade || " ").trim() || " ";

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    // 💡 [수정] 일일회원 여부(isGuest)를 히든 마커로 안전하게 포함
    const guestTag = u.isGuest ? '|guest' : '';
    const formattedPlayerInfo = [name, gender, age, level].join(" / ") + guestTag;

    // 🎯 팝업창에는 |guest를 제외한 깨끗한 정보만 표시
    const displayPlayerInfo = [name, gender, age, level].join(" / ");

    const confirmed = await confirm(`[${displayPlayerInfo}]로 난타에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'nanta', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

async function exitGamePlayer(slotId, idx) {
    const confirmed = await confirm('대기 신청을 취소하고 나가시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('exitPlayer', { type: 'game', slotId, index: idx });
    }
}

async function exitNantaPlayer(slotId, idx) {
    const confirmed = await confirm('대기 신청을 취소하고 나가시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('exitPlayer', { type: 'nanta', slotId, index: idx });
    }
}

async function enterGameCourt(slotId) {
    const slot = gameQueue.find(s => s.id === slotId);
    if (!slot) return;

    // 💡 1. 멀티테넌트 환경에 맞게 유저 '전체 객체'를 가져옵니다.
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';
    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    let currentUser = {};
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {}
    }

    // 💡 2. includes(부분 일치) 검사를 만능 함수(isMyNameMatch) 단 한 줄로 완벽하게 교체!
    const isMySlot = slot.players && slot.players.some(p => window.isMyNameMatch(p, currentUser));
    
    if (!isMySlot) {
        alert('⚠️ 해당 게임 방에 참여 중인 회원만 코트에 입장할 수 있습니다.');
        return;
    }

    const validPlayers = getValidPlayers(slot.players);
    if (validPlayers.length < 4) {
        alert('⚠️ 4명이 모두 채워져야 코트에 입장할 수 있습니다.');
        return;
    }

    const availableCourtsCount = getAvailableGameCourtsCount();
    if (availableCourtsCount <= 0) {
        alert('⚠️ 현재 빈 게임 코트가 없습니다.');
        return;
    }

    const readySlots = gameQueue.filter(s => getValidPlayers(s.players).length === 4);
    const allowedSlots = readySlots.slice(0, availableCourtsCount);
    const isAllowed = allowedSlots.some(s => s.id === slotId);

    if (!isAllowed) {
        alert(`⚠️ 현재 빈 코트가 ${availableCourtsCount}개뿐이므로, 앞 순서의 완성팀이 우선 입장 대상입니다.`);
        return;
    }

    const emptyGameCourts = (typeof courtsData !== 'undefined') ? courtsData.filter(c => c.type === 'game' && c.isEmpty) : [];
    const courtIndex = allowedSlots.findIndex(s => s.id === slotId);
    const assignedCourtNumber = (courtIndex !== -1 && emptyGameCourts[courtIndex]) ? emptyGameCourts[courtIndex].id : 1;

    const confirmed = await confirm(`${assignedCourtNumber}번 코트로 입장하시겠습니까?`);
    if (confirmed) {
        if (typeof cancelVoiceAnnouncement === 'function') {
            cancelVoiceAnnouncement(assignedCourtNumber);
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'game', slotId });
        changeMainTab('court');
    }
}

async function enterNantaCourt(slotId) {
    const slot = nantaQueue.find(s => s.id === slotId);
    if (!slot) return;

    // 💡 [수정된 부분 시작] 멀티테넌트 환경에 맞게 유저 전체 데이터를 가져와서 통합 함수로 검사합니다.
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';
    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    let currentUser = {};
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch (e) {}
    }

    // 아까 ui.js 최상단에 만든 만능 함수 하나로 동명이인, 부분일치 방어 끝!
    const isMySlot = window.isMyNameMatch(slot.players, currentUser);
    // 💡 [수정된 부분 끝]

    if (!isMySlot) {
        alert('⚠️ 해당 난타 방에 참여 중인 회원만 코트에 입장할 수 있습니다.');
        return;
    }

    const validPlayers = getValidPlayers(slot.players);
    if (validPlayers.length < 2) {
        alert('⚠️ 2명이 모두 채워져야 난타 코트에 입장할 수 있습니다.');
        return;
    }

    const availableCourtsCount = getAvailableNantaCourtsCount();
    if (availableCourtsCount <= 0) {
        alert('⚠️ 현재 빈 난타 코트가 없습니다.');
        return;
    }

    const readySlots = nantaQueue.filter(s => getValidPlayers(s.players).length === 2);
    const allowedSlots = readySlots.slice(0, availableCourtsCount);
    const isAllowed = allowedSlots.some(s => s.id === slotId);

    if (!isAllowed) {
        alert(`⚠️ 현재 빈 난타 코트가 ${availableCourtsCount}개뿐이므로, 앞 순서의 완성팀이 우선 입장 대상입니다.`);
        return;
    }

    const emptyNantaCourts = (typeof courtsData !== 'undefined') ? courtsData.filter(c => c.type === 'nanta' && ((c.sideA && c.sideA.isEmpty) || (c.sideB && c.sideB.isEmpty))) : [];
    const courtIndex = allowedSlots.findIndex(s => s.id === slotId);
    
    let assignedCourtNumber = 6;
    let sideText = 'A';
    
    if (courtIndex !== -1 && emptyNantaCourts[courtIndex]) {
        const targetCourt = emptyNantaCourts[courtIndex];
        assignedCourtNumber = targetCourt.id;
        if (targetCourt.sideA && targetCourt.sideA.isEmpty) {
            sideText = 'A';
        } else {
            sideText = 'B';
        }
    }

    const confirmed = await confirm(`난타 ${assignedCourtNumber}번 코트 (${sideText}반코트)로 입장하시겠습니까?`);
    if (confirmed) {
        if (typeof cancelVoiceAnnouncement === 'function') {
            cancelVoiceAnnouncement(assignedCourtNumber);
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('enterCourtFromSlot', { type: 'nanta', slotId });
        changeMainTab('court');
    }
}

async function clickAgain(courtId) {
    const confirmed = await confirm('동일한 멤버로 한 게임 더 진행하시겠습니까? (대기열 최후순위로 재등록됩니다)');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('extendGameCourt', { courtId: courtId });
        switchTab('game');
    }
}

async function clickEnd(courtId) {
    const confirmed = await confirm('게임을 종료하고 코트를 비우시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) activeSocket.emit('endGameCourt', { courtId: courtId });
    }
}

async function clickNantaEnd(courtId, side) {
    const confirmed = await confirm('난타를 종료하고 퇴장하시겠습니까?');
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('endNantaCourt', { courtId, side });
        } else {
            alert("서버와 연결 상태를 확인해주세요.");
        }
    }
}

window.switchTab = function(tabName) {
    const tabGame = document.getElementById('tab-game');
    const tabNanta = document.getElementById('tab-nanta');
    const tabCourt = document.getElementById('tab-court');

    const secGame = document.getElementById('section-game');
    const secNanta = document.getElementById('section-nanta');
    const secCourt = document.getElementById('section-court');

    if (tabGame) tabGame.classList.remove('active');
    if (tabNanta) tabNanta.classList.remove('active');
    if (tabCourt) tabCourt.classList.remove('active');

    if (secGame) secGame.style.display = 'none';
    if (secNanta) secNanta.style.display = 'none';
    if (secCourt) secCourt.style.display = 'none';

    if (tabName === 'game') {
        if (tabGame) tabGame.classList.add('active');
        if (secGame) secGame.style.display = 'block';
    } else if (tabName === 'nanta') {
        if (tabNanta) tabNanta.classList.add('active');
        if (secNanta) secNanta.style.display = 'block';
    } else if (tabName === 'court') {
        if (tabCourt) tabCourt.classList.add('active');
        if (secCourt) secCourt.style.display = 'block';
    }
}

function handleHome() {
    switchTab('game');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyUserProfile() {
    // 🔑 현재 접속 구장 식별자 확인 및 구장별 키 생성
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                    || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                    || new URLSearchParams(window.location.search).get('club') 
                    || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                        ? getClubStorageKey("currentUser") 
                        : `currentUser_${clubId}`;

    let userStr = localStorage.getItem(storageKey);
    // 레거시 호환용 (이전 저장값이 남아있는 경우 대응)
    if (!userStr) {
        userStr = localStorage.getItem("currentUser");
    }

    // 🎯 1. 고유 ID 또는 상단 텍스트 요소를 안정적으로 추적
    let headerUserEl = document.getElementById("user-display-name") 
                    || document.getElementById("user-name")
                    || document.getElementById("userName")
                    || document.getElementById("userDisplay");

    if (!headerUserEl) {
        const candidates = Array.from(document.querySelectorAll('header span, nav span, .header span, span, div, a, b'));
        headerUserEl = candidates.find(el => {
            const txt = (el.innerText || el.textContent || '').trim();
            return el.children.length === 0 && (txt.includes('로그인 중') || txt.includes('로그인 필요') || txt.endsWith('님'));
        });
    }

    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            const rawName = user.rawName || user.name || user.username || user.nickname || (typeof user === 'string' ? user : '사용자');
            // 💡 접미사('(일일)' 및 '님') 깔끔하게 제거하여 순수 이름 확보
            const cleanName = String(rawName).replace(/\(일일\)/g, '').replace(/님$/, '').trim();
            
            // 🎯 일일회원 판별
            const isGuest = user.isGuest === true || (user.grade && user.grade.includes('일')) || (user.level && user.level.includes('일'));

            // 🏷️ 화면에 요소가 발견되면 이름 및 색상 반영
            if (headerUserEl) {
                headerUserEl.textContent = `${cleanName}님`;
                if (isGuest) {
                    headerUserEl.style.color = '#38bdf8';
                    headerUserEl.classList.add('guest-text');
                } else {
                    headerUserEl.style.color = '';
                    headerUserEl.classList.remove('guest-text');
                }
            }
            
            // 🔒 [무한 루프 방지]: 이미 등록된 소켓 세션이면 반복해서 emit하지 않음
            const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
            // 💡 [수정] guest_ 임시 ID 대신 실명(cleanName)을 최우선 사용하여 접속자 중복 집계 방지
            const sessionIdentifier = cleanName || user.phone || user.username;
            if (activeSocket && sessionIdentifier && window.__registeredSessionKey !== sessionIdentifier) {
                window.__registeredSessionKey = sessionIdentifier;
                activeSocket.emit('registerUserSession', {
                    name: cleanName,
                    username: sessionIdentifier,
                    clubId: clubId,
                    isAutoRestore: true
                });
            }
        } catch (e) {
            console.error("사용자 정보 파싱 오류:", e);
            if (headerUserEl) {
                headerUserEl.textContent = "로그인 필요";
                headerUserEl.style.color = '';
                headerUserEl.classList.remove('guest-text');
            }
        }
    } else {
        if (headerUserEl) {
            headerUserEl.textContent = "로그인 필요";
            headerUserEl.style.color = '';
            headerUserEl.classList.remove('guest-text');
        }
        window.__registeredSessionKey = null;
    }
}

// 🚀 화면 로딩 시점에 자동으로 즉시 실행되도록 보장
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyUserProfile);
} else {
    applyUserProfile();
}
window.addEventListener('load', applyUserProfile);

// 💡 [최종 수정본] 확실하고 안전한 로그아웃 함수
async function handleLogout(event) {
    if (event) event.preventDefault();

    // 🛡️ 중복 클릭 방지
    if (window.isLoggingOutInProgress) return;
    window.isLoggingOutInProgress = true; 
    window.isLoggingOut = true; // 소켓 끊김 에러창 방지용

    const clubId = window.currentClubId || new URLSearchParams(window.location.search).get('club') || 'unjeong';
    const storageKey = (typeof getClubStorageKey === 'function') ? getClubStorageKey("currentUser") : `currentUser_${clubId}`;
    const rawUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");
    
    let userData = null;
    if (rawUser) {
        try { userData = JSON.parse(rawUser); } catch(e) { userData = rawUser; }
    }

    // 🧹 데이터 청소 및 새로고침 함수 (중복 실행 방지 처리)
    let isFinished = false;
    const finishLogout = () => {
        if (isFinished) return;
        isFinished = true;

        // 로컬스토리지 정보 깨끗이 비우기
        localStorage.removeItem(storageKey);
        localStorage.removeItem("currentUser");
        localStorage.removeItem("username");
        localStorage.removeItem("phone");
        sessionStorage.clear();
        
        // 새로고침
        window.location.reload(); 
    };

    const activeSocket = window.socket;
    
    if (activeSocket && activeSocket.connected) {
        // 1. 서버에 명시적 로그아웃 요청 전송
        activeSocket.emit('explicitLogout', userData, () => {
            // 서버가 처리를 완료하고 응답을 준 경우에만 실행
            activeSocket.disconnect();
            finishLogout();
        });

        // 2. 서버 응답이 지연되더라도 최대 1.5초 뒤에는 강제로 소켓을 끊고 마무리 (0.3초는 너무 짧아 늘림)
        setTimeout(() => {
            try {
                activeSocket.disconnect();
            } catch(e) {}
            finishLogout();
        }, 1500);
    } else {
        finishLogout();
    }
}

function changeMainTab(tabName) {
    console.log(`[메인 탭 전환] ${tabName} 실행됨`);
    
    const tabGame = document.getElementById('tab-game');
    const tabNanta = document.getElementById('tab-nanta');
    const tabCourt = document.getElementById('tab-court');

    const secGame = document.getElementById('section-game');
    const secNanta = document.getElementById('section-nanta');
    const secCourt = document.getElementById('section-court');

    if (tabGame) tabGame.classList.remove('active');
    if (tabNanta) tabNanta.classList.remove('active');
    if (tabCourt) tabCourt.classList.remove('active');

    if (secGame) secGame.style.display = 'none';
    if (secNanta) secNanta.style.display = 'none';
    if (secCourt) secCourt.style.display = 'none';

    if (tabName === 'game') {
        if (tabGame) tabGame.classList.add('active');
        if (secGame) secGame.style.display = 'block';
    } else if (tabName === 'nanta') {
        if (tabNanta) tabNanta.classList.add('active');
        if (secNanta) secNanta.style.display = 'block';
    } else if (tabName === 'court') {
        if (tabCourt) tabCourt.classList.add('active');
        if (secCourt) secCourt.style.display = 'block';
    }
    // 💡 탭 전환 후 열린 탭의 개설/참여/통합 버튼에 Wi-Fi 제한 스타일 즉시 재적용
    if (typeof updateWifiRestrictedButtons === 'function') {
        updateWifiRestrictedButtons();
    }
}
window.changeMainTab = changeMainTab;

document.addEventListener('click', (event) => {
    const targetTab = event.target.closest('.tab-btn');
    if (!targetTab) return;

    if (targetTab.id === 'tab-game') {
        changeMainTab('game');
    } else if (targetTab.id === 'tab-nanta') {
        changeMainTab('nanta');
    } else if (targetTab.id === 'tab-court') {
        changeMainTab('court');
    }
});

// ==========================================
// 📶 구장 Wi-Fi 단절/미접속 시 공통 안내 팝업 함수
// ==========================================
function checkGymWifiOrAlert() {
    const restrictionEnabled = (typeof window.useWifiRestriction === 'boolean') 
        ? window.useWifiRestriction 
        : (localStorage.getItem("useWifiRestriction") !== "false");

    // Wi-Fi 제한이 켜져 있고, 현재 구장 Wi-Fi에 연결되어 있지 않은 경우
    if (restrictionEnabled && !window.isGymWifiConnected) {
        const modal = document.getElementById('custom-alert-modal');
        const msgEl = document.getElementById('custom-alert-message');
        const confirmBtn = document.getElementById('custom-alert-ok-btn');
        const messageText = '⚠️ 구장 전용 Wi-Fi에 접속 후 이용해 주세요.';

        if (modal && msgEl) {
            msgEl.innerText = messageText;
            modal.style.display = 'flex';
            if (confirmBtn) {
                confirmBtn.onclick = function() {
                    modal.style.display = 'none';
                };
            }
        } else {
            alert(messageText);
        }
        return false; // 클릭 동작 차단
    }
    return true; // 정상 통과
}

// 📶 Wi-Fi 상태에 따른 버튼 및 참여 슬롯 시각 제어 (새로고침 시 이중 암전 방지 및 회원 정보 100% 선명도 보장)
function updateWifiRestrictedButtons() {
    const restrictionEnabled = (typeof window.useWifiRestriction === 'boolean') ? window.useWifiRestriction : true;
    const isWifi = !restrictionEnabled || Boolean(window.isGymWifiConnected);

    if (isWifi) {
        document.body.classList.add('gym-wifi-active');
    } else {
        document.body.classList.remove('gym-wifi-active');
    }
}

// =========================================================================
// 🏆 [게임 종료 / 한게임 더] 스코어 및 전적 입력 팝업 UI (ui.js 맨 아래 추가)
// =========================================================================

window.showScoreInputPopup = function(data) {
    // 이미 열려있는 팝업이 있다면 제거 후 새로 생성
    const existingModal = document.getElementById('match-score-modal');
    if (existingModal) existingModal.remove();

    const players = data.players || [];
    if (players.length < 2) return;

    // 기본 종목 세팅
    let defaultMatchType = players.length >= 4 ? '자유복식' : '단식';

    const modalHtml = `
        <div id="match-score-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.78); display:flex; justify-content:center; align-items:center; z-index:99999; font-family:inherit;">
            <div style="background:#1f2937; color:#fff; width:92%; max-width:420px; padding:22px; border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,0.6); border:1px solid #374151;">
                <h3 style="margin-top:0; margin-bottom:14px; font-size:18px; color:#38bdf8; text-align:center;">
                    🏆 [${data.courtId}번 코트] 경기 스코어 기록
                </h3>
                
                <!-- 1. 경기 종목 선택 -->
                <div style="margin-bottom:14px;">
                    <label style="font-size:12px; color:#9ca3af; display:block; margin-bottom:6px;">경기 종목 선택</label>
                    <select id="modal-match-type" style="width:100%; padding:10px; background:#374151; color:#fff; border:1px solid #4b5563; border-radius:8px; font-size:14px; font-weight:bold;">
                        <option value="남복" ${defaultMatchType==='남복'?'selected':''}>남성복식 (남복)</option>
                        <option value="여복" ${defaultMatchType==='여복'?'selected':''}>여성복식 (여복)</option>
                        <option value="혼복" ${defaultMatchType==='혼복'?'selected':''}>혼성복식 (혼복)</option>
                        <option value="자유복식" ${defaultMatchType==='자유복식'?'selected':''}>자유복식 (자유)</option>
                    </select>
                </div>

                <!-- 2. 선수 팀 배정 (A팀 체크 시 나머지 자동 B팀) -->
                <div style="margin-bottom:14px;">
                    <label style="font-size:12px; color:#9ca3af; display:block; margin-bottom:6px;">
                        👉 <strong style="color:#38bdf8;">A팀 선수(2명)</strong>를 체크하세요 (나머지는 자동 <strong style="color:#f43f5e;">B팀</strong>)
                    </label>
                    <div id="modal-player-checkboxes" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                        ${players.map((p, idx) => `
                            <label class="player-select-label" style="display:flex; align-items:center; background:#374151; padding:10px; border-radius:8px; cursor:pointer; border:2px solid ${idx < 2 ? '#38bdf8' : '#f43f5e'}; transition:0.2s;">
                                <input type="checkbox" name="teamA_player" value="${p}" ${idx < 2 ? 'checked' : ''} style="margin-right:8px; width:16px; height:16px; accent-color:#38bdf8;" onchange="window.updateTeamBDisplay()">
                                <span style="font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p}</span>
                            </label>
                        `).join('')}
                    </div>
                    <!-- 실시간 팀 매칭 미리보기 -->
                    <div id="team-match-preview" style="margin-top:8px; padding:8px; background:#111827; border-radius:6px; font-size:12px; text-align:center; line-height:1.5;"></div>
                </div>

                <!-- 3. 점수 입력 -->
                <div style="display:flex; gap:12px; margin-bottom:20px;">
                    <div style="flex:1; text-align:center;">
                        <label style="font-size:12px; color:#38bdf8; display:block; margin-bottom:4px; font-weight:bold;">🔵 A팀 점수</label>
                        <input type="number" id="modal-score-a" value="25" min="0" max="99" style="width:100%; box-sizing:border-box; padding:10px; text-align:center; font-size:20px; font-weight:bold; background:#374151; color:#fff; border:2px solid #38bdf8; border-radius:8px;">
                    </div>
                    <div style="flex:1; text-align:center;">
                        <label style="font-size:12px; color:#f43f5e; display:block; margin-bottom:4px; font-weight:bold;">🔴 B팀 점수</label>
                        <input type="number" id="modal-score-b" value="20" min="0" max="99" style="width:100%; box-sizing:border-box; padding:10px; text-align:center; font-size:20px; font-weight:bold; background:#374151; color:#fff; border:2px solid #f43f5e; border-radius:8px;">
                    </div>
                </div>

                <!-- 4. 저장 / 건너뛰기 버튼 -->
                <div style="display:flex; gap:8px;">
                    <button type="button" onclick="window.submitMatchScore('${data.courtId}')" style="flex:2; padding:12px; background:#0284c7; color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:bold; cursor:pointer;">
                        💾 점수 저장하기
                    </button>
                    <button type="button" onclick="window.closeScoreModal()" style="flex:1; padding:12px; background:#4b5563; color:#fff; border:none; border-radius:8px; font-size:13px; cursor:pointer;">
                        기록 안함
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    window.updateTeamBDisplay();
};

// 💡 체크박스 터치 시 A팀(파란 테두리)과 B팀(빨간 테두리)을 즉시 시각적으로 구분해 주는 함수
window.updateTeamBDisplay = function() {
    const allLabels = document.querySelectorAll('#modal-player-checkboxes .player-select-label');
    const teamA = [];
    const teamB = [];

    allLabels.forEach(label => {
        const cb = label.querySelector('input[name="teamA_player"]');
        if (cb && cb.checked) {
            label.style.borderColor = '#38bdf8'; // A팀 파란색 테두리
            teamA.push(cb.value);
        } else if (cb) {
            label.style.borderColor = '#f43f5e'; // B팀 빨간색 테두리
            teamB.push(cb.value);
        }
    });

    const previewEl = document.getElementById('team-match-preview');
    if (previewEl) {
        previewEl.innerHTML = `
            <span style="color:#38bdf8; font-weight:bold;">🔵 A팀: ${teamA.join(', ') || '없음'}</span>
            <span style="color:#9ca3af; margin:0 6px;">vs</span>
            <span style="color:#f43f5e; font-weight:bold;">🔴 B팀: ${teamB.join(', ') || '없음'}</span>
        `;
    }
};

// 💡 팝업 닫기 함수
window.closeScoreModal = function() {
    const modal = document.getElementById('match-score-modal');
    if (modal) modal.remove();
};

// 💡 점수 서버 전송 함수
window.submitMatchScore = function(courtId) {
    const matchType = document.getElementById('modal-match-type').value;
    const scoreA = parseInt(document.getElementById('modal-score-a').value, 10) || 0;
    const scoreB = parseInt(document.getElementById('modal-score-b').value, 10) || 0;

    const allCheckboxes = document.querySelectorAll('input[name="teamA_player"]');
    const teamA = Array.from(allCheckboxes).filter(cb => cb.checked).map(cb => cb.value);
    const teamB = Array.from(allCheckboxes).filter(cb => !cb.checked).map(cb => cb.value);

    if (teamA.length === 0 || teamB.length === 0) {
        alert('A팀과 B팀에 최소 1명 이상의 선수가 배정되어야 합니다.');
        return;
    }

    if (typeof socket !== 'undefined') {
        socket.emit('saveMatchScore', {
            courtId: courtId,
            matchType: matchType,
            teamA: teamA,
            teamB: teamB,
            scoreA: scoreA,
            scoreB: scoreB
        }, (res) => {
            if (res && res.success) {
                console.log('✅ 경기 전적 저장 완료');
            } else {
                alert((res && res.message) || '전적 저장 중 오류가 발생했습니다.');
            }
            window.closeScoreModal();
        });
    } else {
        alert('서버 연결(socket)을 찾을 수 없습니다.');
    }
};

// =========================================================================
// 🏆 [3·4단계 통합] 전적 통계 대시보드 & 반짝이는 타이틀 생성기 & 공개 랭킹 보드
// =========================================================================

// 1) 반짝이는 배지 애니메이션 CSS 자동 주입
(function injectSparkleStyles() {
    if (document.getElementById('sparkle-title-styles')) return;
    const style = document.createElement('style');
    style.id = 'sparkle-title-styles';
    style.innerHTML = `
        @keyframes goldShine {
            0% { box-shadow: 0 0 8px rgba(251, 191, 36, 0.4), inset 0 0 8px rgba(251, 191, 36, 0.2); border-color: #f59e0b; }
            50% { box-shadow: 0 0 20px rgba(251, 191, 36, 0.9), inset 0 0 15px rgba(251, 191, 36, 0.5); border-color: #fef08a; transform: translateY(-2px); }
            100% { box-shadow: 0 0 8px rgba(251, 191, 36, 0.4), inset 0 0 8px rgba(251, 191, 36, 0.2); border-color: #f59e0b; }
        }
        @keyframes fireAura {
            0% { box-shadow: 0 0 8px rgba(244, 63, 94, 0.5); border-color: #e11d48; }
            50% { box-shadow: 0 0 22px rgba(251, 113, 133, 0.95), 0 -4px 12px rgba(249, 115, 22, 0.7); border-color: #fda4af; transform: scale(1.02); }
            100% { box-shadow: 0 0 8px rgba(244, 63, 94, 0.5); border-color: #e11d48; }
        }
        @keyframes holoPrism {
            0% { border-color: #38bdf8; box-shadow: 0 0 12px rgba(56, 189, 248, 0.6); }
            33% { border-color: #c084fc; box-shadow: 0 0 18px rgba(192, 132, 252, 0.8); }
            66% { border-color: #34d399; box-shadow: 0 0 18px rgba(52, 211, 153, 0.8); }
            100% { border-color: #38bdf8; box-shadow: 0 0 12px rgba(56, 189, 248, 0.6); }
        }
        @keyframes funBounce {
            0%, 100% { border-color: #a855f7; box-shadow: 0 0 10px rgba(168, 85, 247, 0.5); }
            50% { border-color: #ec4899; box-shadow: 0 0 16px rgba(236, 72, 153, 0.8); }
        }
        .title-card-gold { background: linear-gradient(135deg, #451a03 0%, #78350f 100%); border: 2px solid #f59e0b; animation: goldShine 2.5s infinite ease-in-out; }
        .title-card-fire { background: linear-gradient(135deg, #4c0519 0%, #7f1d1d 100%); border: 2px solid #f43f5e; animation: fireAura 2s infinite ease-in-out; }
        .title-card-prism { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #064e3b 100%); border: 2px solid #38bdf8; animation: holoPrism 3s infinite linear; }
        .title-card-fun { background: linear-gradient(135deg, #2e1065 0%, #4a044e 100%); border: 2px solid #a855f7; animation: funBounce 2.5s infinite ease-in-out; }
    `;
    document.head.appendChild(style);
})();

window.currentStatsAdminMode = false;

// =========================================================================
// 2. [랭킹 보드 - 사용자 화면] 최종 개편 (정회원 집계 + 이벤트 타이틀 상시 고정 + 환상 파트너 2줄 레이아웃)
// =========================================================================
window.openStatsDashboard = function(isAdminMode = false, selectedPeriod = 'month') {
    if (isAdminMode === true && typeof window.openAdminEventTitleManager === 'function') {
        return window.openAdminEventTitleManager();
    }

    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';

    socket.emit('getMatchStats', { clubId, period: selectedPeriod, minGames: 10 }, (res) => {
        if (!res || !res.success) {
            alert('클럽 랭킹 보드 데이터를 불러오지 못했습니다.');
            return;
        }

        const allPlayers = res.playersStats || [];
        const allPairs = res.pairsStats || res.pairStats || [];
        const customTitles = res.customTitles || [];

        // 회원 DB 급수 및 회원 유형 매핑
        const gradeMap = {};
        const memberTypeMap = {};
        const registerMemberInfo = (name, rawGrade, rawType) => {
            if (!name) return;
            const cleanName = String(name).trim();
            if (rawGrade) {
                let g = String(rawGrade).trim().toUpperCase();
                if (g && g !== '-' && g !== '미정' && g !== 'NULL') {
                    if (g !== '초심' && !g.endsWith('조')) g += '조';
                    gradeMap[cleanName] = g;
                }
            }
            if (rawType) {
                memberTypeMap[cleanName] = String(rawType).trim();
            }
        };

        if (Array.isArray(res.members)) {
            res.members.forEach(m => registerMemberInfo(m.name, m.grade, m.memberType));
        }
        allPlayers.forEach(p => registerMemberInfo(p.name, p.grade, p.memberType));

        allPlayers.forEach(p => {
            if (!p.grade && gradeMap[p.name]) p.grade = gradeMap[p.name];
        });

        const formatNameWithGrade = (name) => {
            if (!name) return '';
            const clean = String(name).trim();
            const g = gradeMap[clean];
            return g ? `${clean}(${g})` : clean;
        };

        // 💡 모든 집계는 무조건 '정회원' 기준으로만 필터링
        const regularPlayers = allPlayers.filter(p => {
            const mType = p.memberType || memberTypeMap[p.name] || '정회원';
            const upper = String(mType).toUpperCase();
            return !upper.includes('일일') && !upper.includes('게스트') && !upper.includes('GUEST');
        });

        // -----------------------------------------------------------------
        // ① 급수별 랭킹 데이터 산출 (정회원 기준)
        // -----------------------------------------------------------------
        const getTop5ByGrade = (targetGrade) => {
            let filtered = regularPlayers;
            if (targetGrade !== 'ALL') {
                filtered = regularPlayers.filter(p => {
                    const g = (p.grade || '').trim().toUpperCase();
                    const target = targetGrade.trim().toUpperCase();
                    return g === target || g === (target + '조');
                });
            }
            return filtered
                .filter(p => p.games > 0)
                .sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate) || (b.games - a.games))
                .slice(0, 5);
        };

        const gradeRankingData = {
            'ALL': getTop5ByGrade('ALL'),
            '초심': getTop5ByGrade('초심'),
            'D': getTop5ByGrade('D'),
            'C': getTop5ByGrade('C'),
            'B': getTop5ByGrade('B'),
            'A': getTop5ByGrade('A')
        };

        // -----------------------------------------------------------------
        // ② 종목별 다승 순위 데이터 산출 (정회원 기준)
        // -----------------------------------------------------------------
        const getTop5ByMatchType = (typeName) => {
            return regularPlayers
                .map(p => {
                    const tStat = (p.byType && p.byType[typeName]) ? p.byType[typeName] : { games: 0, wins: 0, losses: 0 };
                    const tWinRate = tStat.games > 0 ? Math.round((tStat.wins / tStat.games) * 100) : 0;
                    return { name: p.name, games: tStat.games, wins: tStat.wins, losses: tStat.losses, winRate: tWinRate };
                })
                .filter(p => p.games > 0)
                .sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate) || (b.games - a.games))
                .slice(0, 5);
        };

        const typeRankingData = {
            '남복': getTop5ByMatchType('남복'),
            '여복': getTop5ByMatchType('여복'),
            '혼복': getTop5ByMatchType('혼복')
        };

        // -----------------------------------------------------------------
        // ③ 개인 및 파트너 부문 TOP 5 데이터 산출 (정회원 파트너만 필터링)
        // -----------------------------------------------------------------
        const top5MostWins = [...regularPlayers]
            .filter(p => p.games > 0)
            .sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate) || (b.games - a.games))
            .slice(0, 5);

        const MIN_GAMES_FOR_RATE = 10;
        const qualifiedRatePlayers = [...regularPlayers]
            .filter(p => p.games >= MIN_GAMES_FOR_RATE)
            .sort((a, b) => (b.winRate - a.winRate) || (b.wins - a.wins) || (b.games - a.games));

        let top5WinRate = qualifiedRatePlayers.slice(0, 5);
        let isRateFallbackUsed = false;
        if (top5WinRate.length < 5) {
            const underPlayers = [...regularPlayers]
                .filter(p => p.games > 0 && p.games < MIN_GAMES_FOR_RATE)
                .sort((a, b) => (b.games - a.games) || (b.winRate - a.winRate) || (b.wins - a.wins));
            if (underPlayers.length > 0) {
                isRateFallbackUsed = true;
                top5WinRate = [...top5WinRate, ...underPlayers].slice(0, 5);
            }
        }

        // 두 선수가 모두 정회원인 경우만 환상 파트너 후보로 인정
        const regularNamesSet = new Set(regularPlayers.map(p => p.name));
        const top5Pairs = [...allPairs]
            .filter(pr => {
                const p1 = pr.player1 || (pr.players && pr.players[0]) || '';
                const p2 = pr.player2 || (pr.players && pr.players[1]) || '';
                return pr.games > 0 && regularNamesSet.has(p1) && regularNamesSet.has(p2);
            })
            .map(pr => {
                const p1 = pr.player1 || (pr.players && pr.players[0]) || '';
                const p2 = pr.player2 || (pr.players && pr.players[1]) || '';
                const losses = typeof pr.losses === 'number' ? pr.losses : Math.max(0, pr.games - pr.wins);
                return {
                    p1Formatted: formatNameWithGrade(p1),
                    p2Formatted: formatNameWithGrade(p2),
                    games: pr.games,
                    wins: pr.wins,
                    losses: losses,
                    winRate: Math.round(pr.winRate || 0)
                };
            })
            .sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate) || (b.games - a.games))
            .slice(0, 5);

        // 렌더링 헬퍼 함수 (일반 리스트용)
        const renderTop5ListHtml = (list, emptyMsg) => {
            if (!list || list.length === 0) {
                return `<div style="padding:28px 12px; text-align:center; color:#64748b; font-size:12px;">${emptyMsg}</div>`;
            }
            return list.map((item, idx) => {
                const rankBg = idx === 0 ? '#f59e0b' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b45309' : '#1e293b';
                const rankColor = idx < 3 ? '#0f1420' : '#cbd5e1';
                const titleStr = formatNameWithGrade(item.name);
                const rateVal = Math.round(item.winRate || 0);

                return `
                    <div style="display:grid; grid-template-columns:34px 1fr auto; align-items:center; padding:10px 12px; border-bottom:1px solid #1e293b; font-size:12.5px; background:${idx % 2 === 0 ? '#151c2c' : '#111726'};">
                        <div>
                            <span style="display:inline-block; width:22px; height:22px; line-height:22px; text-align:center; border-radius:5px; background:${rankBg}; color:${rankColor}; font-weight:800; font-size:11px;">${idx + 1}</span>
                        </div>
                        <div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; padding-right:8px; font-weight:700; color:#ffffff;">
                            ${titleStr}
                        </div>
                        <div style="text-align:right; white-space:nowrap; font-weight:600; font-size:12px;">
                            <span style="color:#cbd5e1;">${item.games}전</span>
                            <span style="color:#38bdf8; margin-left:3px;">${item.wins}승</span>
                            <span style="color:#f43f5e; margin-left:2px;">${item.losses}패</span>
                            <span style="color:#f59e0b; font-weight:800; margin-left:4px;">(승률 ${rateVal}%)</span>
                        </div>
                    </div>
                `;
            }).join('');
        };

        // 💡 환상 파트너 전용 렌더링 함수 (스마트폰에서 2줄 레이아웃 적용으로 이름 잘림 원천 방지)
        const renderPairsListHtml = (list, emptyMsg) => {
            if (!list || list.length === 0) {
                return `<div style="padding:28px 12px; text-align:center; color:#64748b; font-size:12px;">${emptyMsg}</div>`;
            }
            return list.map((item, idx) => {
                const rankBg = idx === 0 ? '#f59e0b' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b45309' : '#1e293b';
                const rankColor = idx < 3 ? '#0f1420' : '#cbd5e1';
                const rateVal = Math.round(item.winRate || 0);

                return `
                    <div style="display:grid; grid-template-columns:34px 1fr; align-items:center; padding:10px 12px; border-bottom:1px solid #1e293b; background:${idx % 2 === 0 ? '#151c2c' : '#111726'}; gap:8px;">
                        <div>
                            <span style="display:inline-block; width:22px; height:22px; line-height:22px; text-align:center; border-radius:5px; background:${rankBg}; color:${rankColor}; font-weight:800; font-size:11px;">${idx + 1}</span>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:3px; overflow:hidden;">
                            <div style="font-weight:700; color:#ffffff; font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                <span style="color:#38bdf8;">${item.p1Formatted}</span> <span style="color:#64748b; font-weight:400;">&</span> <span style="color:#38bdf8;">${item.p2Formatted}</span>
                            </div>
                            <div style="font-weight:600; font-size:11.5px; color:#cbd5e1;">
                                <span>${item.games}전</span>
                                <span style="color:#38bdf8; margin-left:4px;">${item.wins}승</span>
                                <span style="color:#f43f5e; margin-left:3px;">${item.losses}패</span>
                                <span style="color:#f59e0b; font-weight:800; margin-left:5px;">(승률 ${rateVal}%)</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        };

        const periodTabs = [
            { key: 'month', label: '이번 달' },
            { key: 'last_month', label: '지난달' },
            { key: '3months', label: '최근 3개월' },
            { key: 'all', label: '전체 누적' }
        ];
        const currentPeriodLabel = (periodTabs.find(t => t.key === selectedPeriod) || { label: '선택한 기간' }).label;

        const existing = document.getElementById('stats-dashboard-modal');
        if (existing) existing.remove();

        const modalHtml = `
            <div id="stats-dashboard-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(5, 8, 15, 0.88); display:flex; justify-content:center; align-items:center; z-index:99999; padding:10px; box-sizing:border-box;">
                <div style="background:#0f1420; color:#f8fafc; width:100%; max-width:520px; max-height:92vh; border-radius:14px; display:flex; flex-direction:column; border:1.5px solid #2563eb; box-shadow:0 15px 40px rgba(0,0,0,0.85); overflow:hidden;">
                    
                    <!-- 팝업 헤더 -->
                    <div style="padding:14px 18px; background:#151c2c; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center;">
                        <h3 style="margin:0; font-size:16px; font-weight:800; color:#f59e0b; letter-spacing:-0.3px;">클럽 랭킹 보드</h3>
                        <button onclick="document.getElementById('stats-dashboard-modal').remove()" style="background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:6px 14px; font-weight:700; cursor:pointer; font-size:12px;">닫기</button>
                    </div>

                    <!-- 본문 스크롤 영역 -->
                    <div style="padding:14px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:18px;">
                        
                        <!-- ========================================================= -->
<!-- [상단 구역] 이달의 이벤트 타이틀 (기간과 무관하게 상시 고정 노출) -->
<!-- ========================================================= -->
<div style="background:#151c2c; border:1.5px solid #f59e0b; border-radius:12px; overflow:hidden; flex-shrink:0;">
    <div style="background:linear-gradient(90deg, rgba(245,158,11,0.18) 0%, rgba(21,28,44,0) 100%); padding:10px 14px; border-bottom:1px solid #26334d; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13.5px; font-weight:800; color:#f59e0b;">이달의 이벤트 타이틀</span>
        <span style="font-size:11px; color:#94a3b8; font-weight:600;">특별 포상 미션</span>
    </div>
    <div style="padding:12px; display:flex; flex-direction:column; gap:10px;">
${customTitles.length === 0 ? `
    <div style="padding:16px 10px; text-align:center;">
        <div style="color:#e2e8f0; font-size:12.5px; font-weight:700; margin-bottom:3px;">이번 달 이벤트 타이틀을 준비 중입니다.</div>
        <div style="color:#64748b; font-size:11px;">관리자가 포상 미션을 등록하면 이곳에 표시됩니다.</div>
    </div>
` : customTitles.map(ct => {
    const isPublished = (ct.status === 'published') || (ct.winner && ct.winner !== '집계 중' && ct.winner !== '대상자 없음' && ct.status !== 'pending');
    const descText = ct.description || '특별 선정 미션 진행 중';
    const prizeText = ct.prizeInfo ? `🎁 포상 상품: ${ct.prizeInfo}` : '';

    return `
        <!-- 세로 선(border-left)을 제거하고 깔끔한 사방 테두리만 남기도록 수정 -->
        <div style="background:#0f1420; border:1px solid #26334d; border-radius:8px; padding:11px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px; margin-bottom:5px;">
                <div style="font-size:13.5px; font-weight:800; color:#ffffff; word-break:keep-all;">${ct.titleName}</div>
                <span style="background:${isPublished ? '#f59e0b' : '#1e293b'}; color:${isPublished ? '#0f1420' : '#38bdf8'}; border:1px solid ${isPublished ? '#f59e0b' : '#334155'}; font-size:10px; font-weight:800; padding:2px 7px; border-radius:4px; white-space:nowrap; flex-shrink:0;">
                    ${isPublished ? '선정 완료' : '월말 발표'}
                </span>
            </div>
            <div style="font-size:11.5px; color:#cbd5e1; line-height:1.45; margin-bottom:7px; word-break:keep-all;">
                ${descText}
            </div>
            ${prizeText ? `
                <div style="font-size:11.5px; color:#fbbf24; font-weight:700; margin-bottom:8px; background:rgba(245,158,11,0.1); padding:6px 10px; border-radius:5px; border:1px dashed rgba(245,158,11,0.35); word-break:keep-all;">
                    ${prizeText}
                </div>
            ` : ''}
            <div style="background:#151c2c; border:1px solid ${isPublished ? 'rgba(245,158,11,0.4)' : '#1e293b'}; border-radius:6px; padding:7px 10px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <span style="font-size:11px; color:#94a3b8; font-weight:600; white-space:nowrap;">수상 대상자</span>
                ${isPublished ? `
                    <strong style="font-size:12px; color:#f59e0b; font-weight:800; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${ct.winner}</strong>
                ` : `
                    <span style="font-size:11px; color:#64748b; font-weight:700; white-space:nowrap;">조건 달성 회원 집계 중</span>
                `}
            </div>
        </div>
    `;
}).join('')}
    </div>
</div>

                        <!-- ========================================================= -->
                        <!-- [하단 구역] 클럽 공식 랭킹 통계 (기간 선택 + 급수별/부문별 TOP 5) -->
                        <!-- ========================================================= -->
                        <div style="display:flex; flex-direction:column; gap:14px;">
                            
                            <!-- 조회 기간 선택 바 -->
                            <div style="background:#151c2c; padding:10px; border-radius:10px; border:1px solid #26334d;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:0 2px;">
                                    <span style="font-size:13px; font-weight:800; color:#38bdf8;">클럽 공식 랭킹 통계</span>
                                    <span style="font-size:11px; color:#94a3b8;">정회원 기준 집계</span>
                                </div>
                                <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px;">
                                    ${periodTabs.map(t => {
                                        const isActive = (selectedPeriod === t.key);
                                        const btnBg = isActive ? 'linear-gradient(135deg, #ff7b00 0%, #ea580c 100%)' : '#0f1420';
                                        const btnBorder = isActive ? '#f97316' : '#26334d';
                                        const btnColor = isActive ? '#ffffff' : '#94a3b8';
                                        return `<button onclick="window.openStatsDashboard(false, '${t.key}')" style="padding:8px 4px; background:${btnBg}; color:${btnColor}; border:1px solid ${btnBorder}; border-radius:7px; font-size:12px; font-weight:${isActive ? '800' : '600'}; cursor:pointer; white-space:nowrap;">${t.label}</button>`;
                                    }).join('')}
                                </div>
                            </div>

                            ${regularPlayers.length === 0 ? `
                                <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; text-align:center; padding:40px 15px;">
                                    <div style="color:#e2e8f0; font-size:13.5px; font-weight:700; margin-bottom:6px;">${currentPeriodLabel}에 기록된 게임 내역이 없습니다.</div>
                                    <div style="font-size:11.5px; color:#64748b;">게임 종료 후 스코어를 등록하면 랭킹이 집계됩니다.</div>
                                </div>
                            ` : `
                                <!-- 1) 급수별 랭킹 순위 TOP 5 (전체, 초심, D, C, B, A조) -->
                                <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; overflow:hidden;">
                                    <div style="padding:10px 12px; background:#1a2438; border-bottom:1px solid #26334d; display:flex; flex-direction:column; gap:8px;">
                                        <div style="display:flex; justify-content:space-between; align-items:center;">
                                            <span style="font-size:12.5px; font-weight:800; color:#ffffff;">급수별 랭킹 (TOP 5)</span>
                                            <span style="font-size:11px; color:#94a3b8;">정회원 기준 집계</span>
                                        </div>
                                        <div style="display:grid; grid-template-columns:repeat(6, 1fr); gap:4px;" id="grade-ranking-tabs">
                                            <button onclick="window.switchRankingSubTab('grade', 'ALL', this)" class="grade-tab-btn" style="padding:6px 2px; background:#2563eb; color:#ffffff; border:1px solid #3b82f6; border-radius:5px; font-size:11px; font-weight:800; cursor:pointer;">전체</button>
                                            <button onclick="window.switchRankingSubTab('grade', '초심', this)" class="grade-tab-btn" style="padding:6px 2px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer;">초심</button>
                                            <button onclick="window.switchRankingSubTab('grade', 'D', this)" class="grade-tab-btn" style="padding:6px 2px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer;">D조</button>
                                            <button onclick="window.switchRankingSubTab('grade', 'C', this)" class="grade-tab-btn" style="padding:6px 2px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer;">C조</button>
                                            <button onclick="window.switchRankingSubTab('grade', 'B', this)" class="grade-tab-btn" style="padding:6px 2px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer;">B조</button>
                                            <button onclick="window.switchRankingSubTab('grade', 'A', this)" class="grade-tab-btn" style="padding:6px 2px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer;">A조</button>
                                        </div>
                                    </div>
                                    <div id="grade-ranking-ALL" class="grade-ranking-panel" style="display:block;">
                                        ${renderTop5ListHtml(gradeRankingData['ALL'], `${currentPeriodLabel} 전체 순위 기록이 없습니다.`)}
                                    </div>
                                    <div id="grade-ranking-초심" class="grade-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(gradeRankingData['초심'], `${currentPeriodLabel} 초심조 기록이 없습니다.`)}
                                    </div>
                                    <div id="grade-ranking-D" class="grade-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(gradeRankingData['D'], `${currentPeriodLabel} D조 기록이 없습니다.`)}
                                    </div>
                                    <div id="grade-ranking-C" class="grade-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(gradeRankingData['C'], `${currentPeriodLabel} C조 기록이 없습니다.`)}
                                    </div>
                                    <div id="grade-ranking-B" class="grade-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(gradeRankingData['B'], `${currentPeriodLabel} B조 기록이 없습니다.`)}
                                    </div>
                                    <div id="grade-ranking-A" class="grade-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(gradeRankingData['A'], `${currentPeriodLabel} A조 기록이 없습니다.`)}
                                    </div>
                                </div>

                                <!-- 2) 종목별 다승 순위 TOP 5 (남복 / 여복 / 혼복) -->
                                <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; overflow:hidden;">
                                    <div style="padding:10px 12px; background:#1a2438; border-bottom:1px solid #26334d; display:flex; justify-content:space-between; align-items:center;">
                                        <span style="font-size:12.5px; font-weight:800; color:#ffffff;">종목별 다승 순위 (TOP 5)</span>
                                        <div style="display:flex; gap:4px;" id="match-type-tabs">
                                            <button onclick="window.switchRankingSubTab('type', '남복', this)" class="type-tab-btn" style="padding:4px 10px; background:#2563eb; color:#ffffff; border:1px solid #3b82f6; border-radius:5px; font-size:11.5px; font-weight:800; cursor:pointer;">남복</button>
                                            <button onclick="window.switchRankingSubTab('type', '여복', this)" class="type-tab-btn" style="padding:4px 10px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11.5px; font-weight:600; cursor:pointer;">여복</button>
                                            <button onclick="window.switchRankingSubTab('type', '혼복', this)" class="type-tab-btn" style="padding:4px 10px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:5px; font-size:11.5px; font-weight:600; cursor:pointer;">혼복</button>
                                        </div>
                                    </div>
                                    <div id="type-ranking-남복" class="type-ranking-panel" style="display:block;">
                                        ${renderTop5ListHtml(typeRankingData['남복'], `${currentPeriodLabel} 남복 경기 기록이 없습니다.`)}
                                    </div>
                                    <div id="type-ranking-여복" class="type-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(typeRankingData['여복'], `${currentPeriodLabel} 여복 경기 기록이 없습니다.`)}
                                    </div>
                                    <div id="type-ranking-혼복" class="type-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(typeRankingData['혼복'], `${currentPeriodLabel} 혼복 경기 기록이 없습니다.`)}
                                    </div>
                                </div>

                                <!-- 3) 개인 및 파트너 순위 TOP 5 -->
                                <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; overflow:hidden;">
                                    <div style="padding:10px 12px; background:#1a2438; border-bottom:1px solid #26334d; display:flex; flex-direction:column; gap:8px;">
                                        <div style="display:flex; justify-content:space-between; align-items:center;">
                                            <span style="font-size:12.5px; font-weight:800; color:#ffffff;">부문별 랭킹 (TOP 5)</span>
                                            <span style="font-size:11px; color:#94a3b8;">정회원 기준 집계</span>
                                        </div>
                                        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px;" id="category-ranking-tabs">
                                            <button onclick="window.switchRankingSubTab('cat', 'wins', this)" class="cat-tab-btn" style="padding:7px 4px; background:#2563eb; color:#ffffff; border:1px solid #3b82f6; border-radius:6px; font-size:11.5px; font-weight:800; cursor:pointer;">개인 다승</button>
                                            <button onclick="window.switchRankingSubTab('cat', 'rate', this)" class="cat-tab-btn" style="padding:7px 4px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:6px; font-size:11.5px; font-weight:600; cursor:pointer;">개인 승률</button>
                                            <button onclick="window.switchRankingSubTab('cat', 'pairs', this)" class="cat-tab-btn" style="padding:7px 4px; background:#0f1420; color:#cbd5e1; border:1px solid #26334d; border-radius:6px; font-size:11.5px; font-weight:600; cursor:pointer;">환상 파트너</button>
                                        </div>
                                    </div>

                                    <div id="cat-ranking-wins" class="cat-ranking-panel" style="display:block;">
                                        ${renderTop5ListHtml(top5MostWins, '집계된 다승 기록이 없습니다.')}
                                    </div>
                                    <div id="cat-ranking-rate" class="cat-ranking-panel" style="display:none;">
                                        ${renderTop5ListHtml(top5WinRate, '집계된 승률 기록이 없습니다.')}
                                        <div style="padding:8px 12px; background:#111726; border-top:1px solid #1e293b; font-size:11px; color:#94a3b8; text-align:right;">
                                            ※ 최소 ${MIN_GAMES_FOR_RATE}게임 이상 출전 기준${isRateFallbackUsed ? ' (달성자 5명 미만 시 다출전 순 우선 반영)' : ''}
                                        </div>
                                    </div>
                                    <!-- 💡 환상 파트너는 2줄 레이아웃 렌더러 호출 -->
                                    <div id="cat-ranking-pairs" class="cat-ranking-panel" style="display:none;">
                                        ${renderPairsListHtml(top5Pairs, '집계된 복식 파트너 기록이 없습니다.')}
                                    </div>
                                </div>
                            `}
                        </div>

                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
    });
};

// 💡 랭킹 보드 서브 탭 전환 함수 (급수별 / 종목별 / 부문별 탭 제어)
window.switchRankingSubTab = function(group, key, clickedBtn) {
    if (group === 'grade') {
        document.querySelectorAll('.grade-ranking-panel').forEach(el => {
            el.style.display = (el.id === `grade-ranking-${key}`) ? 'block' : 'none';
        });
        document.querySelectorAll('#grade-ranking-tabs .grade-tab-btn').forEach(btn => {
            btn.style.background = '#0f1420';
            btn.style.color = '#cbd5e1';
            btn.style.border = '1px solid #26334d';
            btn.style.fontWeight = '600';
        });
    } else if (group === 'type') {
        document.querySelectorAll('.type-ranking-panel').forEach(el => {
            el.style.display = (el.id === `type-ranking-${key}`) ? 'block' : 'none';
        });
        document.querySelectorAll('#match-type-tabs .type-tab-btn').forEach(btn => {
            btn.style.background = '#0f1420';
            btn.style.color = '#cbd5e1';
            btn.style.border = '1px solid #26334d';
            btn.style.fontWeight = '600';
        });
    } else if (group === 'cat') {
        document.querySelectorAll('.cat-ranking-panel').forEach(el => {
            el.style.display = (el.id === `cat-ranking-${key}`) ? 'block' : 'none';
        });
        document.querySelectorAll('#category-ranking-tabs .cat-tab-btn').forEach(btn => {
            btn.style.background = '#0f1420';
            btn.style.color = '#cbd5e1';
            btn.style.border = '1px solid #26334d';
            btn.style.fontWeight = '600';
        });
    }

    if (clickedBtn) {
        clickedBtn.style.background = '#2563eb';
        clickedBtn.style.color = '#ffffff';
        clickedBtn.style.border = '1px solid #3b82f6';
        clickedBtn.style.fontWeight = '800';
    }
};

// 3) 서버에서 통계 데이터 가져와서 렌더링
window.loadStatsData = function() {
    if (typeof socket === 'undefined') return;
    const periodEl = document.getElementById('stats-period-select');
    const minGamesEl = document.getElementById('stats-min-games');
    const period = periodEl ? periodEl.value : 'month';
    const minGames = minGamesEl ? parseInt(minGamesEl.value, 10) || 5 : 5;
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';

    socket.emit('getMatchStats', { clubId, period, minGames }, (res) => {
        if (!res || !res.success) return;

        // A. 타이틀 카드 렌더링 (기본 5대 + 커스텀 타이틀)
        const titlesGrid = document.getElementById('stats-titles-grid');
        if (titlesGrid) {
            const allTitles = [
                ...(res.defaultTitles || []).map(t => ({ ...t, isCustom: false })),
                ...(res.customTitles || []).map(t => ({
                    id: t.id,
                    titleName: `✨ ${t.titleName}`,
                    metricLabel: `${t.targetMatchType === 'ALL' ? '통합' : t.targetMatchType} · 최소 ${t.minGames}경기`,
                    theme: t.theme || 'gold',
                    winner: t.winner,
                    isCustom: true
                }))
            ];

            titlesGrid.innerHTML = allTitles.map(t => `
                <div class="title-card-${t.theme}" style="padding:14px; border-radius:12px; position:relative; transition:0.3s;">
                    ${(t.isCustom && window.currentStatsAdminMode) ? `
                        <button onclick="window.removeCustomTitle(${t.id})" title="타이틀 삭제" style="position:absolute; top:8px; right:8px; background:rgba(0,0,0,0.5); color:#fda4af; border:none; border-radius:4px; font-size:11px; cursor:pointer; padding:2px 6px;">삭제</button>
                    ` : ''}
                    <div style="font-size:11px; color:#fde68a; opacity:0.9; margin-bottom:4px;">${t.metricLabel}</div>
                    <div style="font-size:15px; font-weight:800; color:#fff; margin-bottom:8px;">${t.titleName}</div>
                    <div style="font-size:14px; font-weight:700; color:#38bdf8; background:rgba(0,0,0,0.35); padding:6px 10px; border-radius:6px; text-align:center;">
                        👑 ${t.winner}
                    </div>
                </div>
            `).join('');
        }

        // B. 회원별 전적 테이블 렌더링
        const tbody = document.getElementById('stats-players-tbody');
        if (tbody) {
            const list = res.playersStats || [];
            if (list.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" style="padding:24px; color:#94a3b8;">해당 기간에 기록된 경기 전적이 없습니다.</td></tr>`;
            } else {
                tbody.innerHTML = list.map((p, idx) => {
                    const rankBadge = idx === 0 ? '🥇 1' : idx === 1 ? '🥈 2' : idx === 2 ? '🥉 3' : (idx + 1);
                    const diffStr = p.pointDiff > 0 ? `+${p.pointDiff}` : p.pointDiff;
                    return `
                        <tr style="border-bottom:1px solid #334155;">
                            <td style="padding:10px 6px; font-weight:bold;">${rankBadge}</td>
                            <td style="padding:10px 6px; font-weight:bold; color:#fff;">${p.name}</td>
                            <td style="padding:10px 6px;">${p.games}</td>
                            <td style="padding:10px 6px; color:#38bdf8; font-weight:bold;">${p.wins}</td>
                            <td style="padding:10px 6px; color:#f43f5e;">${p.losses}</td>
                            <td style="padding:10px 6px; color:#fbbf24; font-weight:bold;">${p.winRate}%</td>
                            <td style="padding:10px 6px; color:${p.pointDiff >= 0 ? '#34d399' : '#f87171'};">${diffStr}</td>
                            <td style="padding:10px 6px;">${p.maxStreak}연승</td>
                        </tr>
                    `;
                }).join('');
            }
        }

        // C. 환상의 짝꿍 렌더링
        const pairsEl = document.getElementById('stats-pairs-list');
        if (pairsEl) {
            const pairs = (res.pairStats || []).slice(0, 10);
            if (pairs.length === 0) {
                pairsEl.innerHTML = `<div style="color:#94a3b8; font-size:13px;">집계된 복식 파트너 기록이 없습니다.</div>`;
            } else {
                pairsEl.innerHTML = pairs.map((pr, idx) => `
                    <div style="background:#1e293b; border:1px solid #334155; padding:10px 12px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:13px; font-weight:bold; color:#e2e8f0;">${idx + 1}위. ${pr.pairName}</span>
                        <span style="font-size:12px; color:#34d399; font-weight:bold;">${pr.wins}승 (${pr.winRate}%)</span>
                    </div>
                `).join('');
            }
        }
    });
};

// 4) 새 커스텀 타이틀 생성 요청
window.createNewCustomTitle = function() {
    const titleName = document.getElementById('new-title-name').value.trim();
    const metricType = document.getElementById('new-title-metric').value;
    const targetMatchType = document.getElementById('new-title-matchtype').value;
    const badgeTheme = document.getElementById('new-title-theme').value;
    const minGames = parseInt(document.getElementById('new-title-mingames').value, 10) || 3;
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';

    if (!titleName) {
        alert('생성할 이벤트 타이틀 이름을 입력해 주세요! (예: 11월 스매싱왕)');
        return;
    }

    socket.emit('createCustomTitle', {
        clubId, titleName, metricType, targetMatchType, minGames, badgeTheme
    }, (res) => {
        if (res && res.success) {
            document.getElementById('new-title-name').value = '';
            window.loadStatsData();
        } else {
            alert((res && res.message) || '타이틀 생성에 실패했습니다.');
        }
    });
};

// 5) 커스텀 타이틀 삭제 요청
window.removeCustomTitle = function(id) {
    if (!confirm('이 이벤트 타이틀을 삭제하시겠습니까?')) return;
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';
    socket.emit('deleteCustomTitle', { id, clubId }, (res) => {
        if (res && res.success) {
            window.loadStatsData();
        }
    });
};

// =========================================================================
// 1. [나의 전적 보기] 개인 상세 전적 리포트 팝업 (회원 DB 연동 급수: 홍길동(A조) 완벽 표기)
// =========================================================================
window.openMyStats = function(selectedPeriod = 'month') {
    let myName = '';
    if (typeof currentUser !== 'undefined' && currentUser && currentUser.name) {
        myName = currentUser.name;
    } else if (localStorage.getItem('userName') || localStorage.getItem('currentUserName')) {
        myName = localStorage.getItem('userName') || localStorage.getItem('currentUserName');
    } else {
        const headerText = document.body.innerText.match(/([가-힣a-zA-Z0-9]+)님\s/);
        if (headerText && headerText[1]) myName = headerText[1].trim();
    }

    if (!myName) {
        myName = prompt('조회할 회원 이름을 입력해 주세요:');
    }
    if (!myName) return;

    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';

    // 선택한 기간 데이터 요청
    socket.emit('getMatchStats', { clubId, period: selectedPeriod, minGames: 1 }, (res) => {
        if (!res || !res.success) {
            alert('전적 정보를 불러오지 못했습니다.');
            return;
        }

        // 전월 대비 성장률 및 전체 회원 급수 매핑 보강을 위해 지난달/전체 데이터 참조
        socket.emit('getMatchStats', { clubId, period: 'last_month', minGames: 1 }, (prevRes) => {
            const allPlayers = res.playersStats || [];
            const myData = allPlayers.find(p => p.name === myName);

            // 💡 [핵심] 정회원/일일회원 DB 및 화면 데이터에서 급수(초심~S조)를 샅샅이 찾아 매핑하는 함수
            const gradeMap = {};
            const registerGrade = (name, rawGrade) => {
                if (!name || !rawGrade) return;
                const cleanName = String(name).trim();
                let g = String(rawGrade).trim().toUpperCase();
                if (!g || g === '-' || g === '미정' || g === 'NULL' || g === 'UNDEFINED') return;
                if (g !== '초심' && !g.endsWith('조')) g += '조';
                gradeMap[cleanName] = g;
            };

            // 1순위: 서버에서 내려준 회원 명부(membersList 등) 및 통계 데이터
            if (Array.isArray(res.members)) res.members.forEach(m => registerGrade(m.name, m.grade || m.level));
            allPlayers.forEach(p => registerGrade(p.name, p.grade || p.level));
            if (prevRes && Array.isArray(prevRes.playersStats)) {
                prevRes.playersStats.forEach(p => registerGrade(p.name, p.grade || p.level));
            }

            // 2순위: 프론트엔드 전역 회원/대기열 배열 탐색 (window.members, clubMembers, waitingList 등)
            const globalPools = [
                window.members, window.clubMembers, window.allMembers,
                window.regularMembers, window.dailyMembers, window.players, window.waitingList
            ];
            globalPools.forEach(pool => {
                if (Array.isArray(pool)) {
                    pool.forEach(item => {
                        if (item && typeof item === 'object') {
                            registerGrade(item.name || item.userName || item.playerName, item.grade || item.level || item.rank);
                        }
                    });
                }
            });

            // 3순위: localStorage에 캐시된 회원 정보 탐색
            try {
                ['members', 'clubMembers', 'waitingList', 'registeredMembers'].forEach(key => {
                    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
                    if (Array.isArray(parsed)) {
                        parsed.forEach(item => {
                            if (item && typeof item === 'object') {
                                registerGrade(item.name || item.userName, item.grade || item.level);
                            }
                        });
                    }
                });
            } catch (e) {}

            // 4순위: 현재 메인 화면 DOM에 표시된 회원 정보(예: "홍길동 / 남 / 40대 / A조")에서 추출
            try {
                const bodyText = document.body.innerText || '';
                const regex = /([가-힣a-zA-Z0-9]{2,10})\s*\/\s*[남여]\s*\/\s*\d+대\s*\/\s*(초심|[SABCD]조?)/g;
                let match;
                while ((match = regex.exec(bodyText)) !== null) {
                    registerGrade(match[1], match[2]);
                }
            } catch (e) {}

            // 이름을 넣으면 "홍길동(A조)" 형태로 반환하는 헬퍼 함수
            const formatNameWithGrade = (name) => {
                if (!name) return '';
                const clean = String(name).trim();
                const g = gradeMap[clean];
                return g ? `${clean}(${g})` : clean;
            };

            // 전월 대비 승률 성장률 계산
            let growthHtml = '<span style="color:#64748b;">전월 비교 기록 없음 (신규 집계)</span>';
            if (myData) {
                let prevWinRate = (typeof myData.prevWinRate === 'number') ? myData.prevWinRate : null;
                if (prevWinRate === null && prevRes && prevRes.success && prevRes.playersStats) {
                    const prevMe = prevRes.playersStats.find(p => p.name === myName);
                    if (prevMe && prevMe.games > 0) prevWinRate = prevMe.winRate;
                }
                if (prevWinRate !== null) {
                    const diff = (Number(myData.winRate) - Number(prevWinRate)).toFixed(1);
                    if (diff > 0) {
                        growthHtml = `<strong style="color:#34d399;">+${diff}%p 상승</strong> <span style="color:#94a3b8; font-size:11px;">(전월 ${prevWinRate}%)</span>`;
                    } else if (diff < 0) {
                        growthHtml = `<strong style="color:#f43f5e;">${diff}%p 하락</strong> <span style="color:#94a3b8; font-size:11px;">(전월 ${prevWinRate}%)</span>`;
                    } else {
                        growthHtml = `<strong style="color:#38bdf8;">0.0%p 유지</strong> <span style="color:#94a3b8; font-size:11px;">(전월 ${prevWinRate}%)</span>`;
                    }
                }
            }

            // 본인 출전 경기 필터링
            const allMyMatches = (res.recentMatches || []).filter(r =>
                r.team_a_p1 === myName || r.team_a_p2 === myName || r.team_b_p1 === myName || r.team_b_p2 === myName
            );

            // 최신 5게임 추출
            const recent5Matches = allMyMatches.slice(0, 5);

            // 나의 베스트 파트너 TOP 5 집계 (성별 무관 / 1순위: 다승, 2순위: 승률)
            const partnerStatsMap = {};
            allMyMatches.forEach(m => {
                const isTeamA = (m.team_a_p1 === myName || m.team_a_p2 === myName);
                const partnerName = isTeamA
                    ? (m.team_a_p1 === myName ? m.team_a_p2 : m.team_a_p1)
                    : (m.team_b_p1 === myName ? m.team_b_p2 : m.team_b_p1);

                if (!partnerName || partnerName.trim() === '') return;

                if (!partnerStatsMap[partnerName]) {
                    partnerStatsMap[partnerName] = { name: partnerName, games: 0, wins: 0, losses: 0 };
                }
                partnerStatsMap[partnerName].games += 1;

                const myWin = (isTeamA && m.winner_team === 'A') || (!isTeamA && m.winner_team === 'B');
                if (myWin) {
                    partnerStatsMap[partnerName].wins += 1;
                } else if (m.winner_team === 'A' || m.winner_team === 'B') {
                    partnerStatsMap[partnerName].losses += 1;
                }
            });

            if (Array.isArray(res.pairsStats)) {
                res.pairsStats.forEach(pair => {
                    if (pair.player1 === myName || pair.player2 === myName) {
                        const pName = pair.player1 === myName ? pair.player2 : pair.player1;
                        if (pName && !partnerStatsMap[pName]) {
                            const w = Number(pair.wins) || 0;
                            const l = Number(pair.losses) || 0;
                            partnerStatsMap[pName] = { name: pName, games: w + l, wins: w, losses: l };
                        }
                    }
                });
            }

            const top5Partners = Object.values(partnerStatsMap)
                .map(p => ({
                    ...p,
                    winRate: p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0
                }))
                .sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate) || (b.games - a.games))
                .slice(0, 5);

            const existing = document.getElementById('my-stats-modal');
            if (existing) existing.remove();

            const periodTabs = [
                { key: 'month', label: '이번 달' },
                { key: 'last_month', label: '지난달' },
                { key: '3months', label: '최근 3개월' },
                { key: 'all', label: '전체 누적' }
            ];
            const currentPeriodLabel = (periodTabs.find(t => t.key === selectedPeriod) || { label: '선택한 기간' }).label;

            const modalHtml = `
                <div id="my-stats-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(5, 8, 15, 0.88); display:flex; justify-content:center; align-items:center; z-index:99999; padding:10px; box-sizing:border-box;">
                    <div style="background:#0f1420; color:#f8fafc; width:100%; max-width:460px; max-height:92vh; border-radius:14px; display:flex; flex-direction:column; border:1.5px solid #2563eb; box-shadow:0 15px 35px rgba(0,0,0,0.85); overflow:hidden;">
                        
                        <!-- 1. 상단 헤더 ("나의 전적 보기"만 표시) -->
                        <div style="padding:14px 18px; background:#151c2c; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center;">
                            <h3 style="margin:0; font-size:16px; font-weight:800; color:#f59e0b; letter-spacing:-0.3px;">나의 전적 보기</h3>
                            <button onclick="document.getElementById('my-stats-modal').remove()" style="background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:6px 14px; font-weight:700; cursor:pointer; font-size:12px;">닫기</button>
                        </div>

                        <!-- 조회 기간 선택 탭 바 -->
                        <div style="padding:10px 14px 6px 14px; background:#0f1420; border-bottom:1px solid #151c2c;">
                            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px;">
                                ${periodTabs.map(t => {
                                    const isActive = (selectedPeriod === t.key);
                                    const btnBg = isActive ? 'linear-gradient(135deg, #ff7b00 0%, #ea580c 100%)' : '#151c2c';
                                    const btnBorder = isActive ? '#f97316' : '#26334d';
                                    const btnColor = isActive ? '#ffffff' : '#94a3b8';
                                    return `<button onclick="window.openMyStats('${t.key}')" style="padding:8px 4px; background:${btnBg}; color:${btnColor}; border:1px solid ${btnBorder}; border-radius:7px; font-size:12px; font-weight:${isActive ? '800' : '600'}; cursor:pointer; white-space:nowrap;">${t.label}</button>`;
                                }).join('')}
                            </div>
                        </div>

                        <!-- 본문 스크롤 영역 -->
                        <div style="padding:14px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:14px;">
                            ${(!myData || myData.games === 0) ? `
                                <div style="background:#151c2c; border:1px solid #1e293b; border-radius:10px; text-align:center; padding:45px 15px;">
                                    <div style="color:#e2e8f0; font-size:14px; font-weight:700; margin-bottom:6px;">${currentPeriodLabel}에 기록된 게임 내역이 없습니다.</div>
                                    <div style="font-size:11.5px; color:#64748b;">게임 종료 후 스코어를 등록하면 실시간으로 전적이 반영됩니다.</div>
                                </div>
                            ` : `
                                <!-- 2. 요약 대시보드 -->
                                <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; overflow:hidden;">
                                    <div style="padding:14px 10px; display:grid; grid-template-columns:repeat(4, 1fr); text-align:center;">
                                        <div style="border-right:1px solid #1e293b;">
                                            <div style="font-size:11px; color:#94a3b8; margin-bottom:4px;">총 출전</div>
                                            <div style="font-size:15px; font-weight:800; color:#ffffff;">${myData.games}전</div>
                                        </div>
                                        <div style="border-right:1px solid #1e293b;">
                                            <div style="font-size:11px; color:#38bdf8; margin-bottom:4px;">승리</div>
                                            <div style="font-size:15px; font-weight:800; color:#38bdf8;">${myData.wins}승</div>
                                        </div>
                                        <div style="border-right:1px solid #1e293b;">
                                            <div style="font-size:11px; color:#f43f5e; margin-bottom:4px;">패배</div>
                                            <div style="font-size:15px; font-weight:800; color:#f43f5e;">${myData.losses}패</div>
                                        </div>
                                        <div>
                                            <div style="font-size:11px; color:#f59e0b; margin-bottom:4px;">승률</div>
                                            <div style="font-size:15px; font-weight:800; color:#f59e0b;">${myData.winRate}%</div>
                                        </div>
                                    </div>
                                    <div style="background:#111726; border-top:1px solid #1e293b; padding:9px 14px; display:flex; justify-content:space-between; align-items:center; font-size:12px;">
                                        <span style="color:#cbd5e1; font-weight:600;">전월 대비 성장률</span>
                                        <div>${growthHtml}</div>
                                    </div>
                                </div>

                                <!-- 3. 나의 베스트 파트너 TOP 5 ("홍길동(A조)" 형태 표기) -->
                                <div>
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                        <span style="font-size:13px; font-weight:800; color:#38bdf8;">나의 파트너 순위 (TOP 5)</span>
                                        <span style="font-size:11px; color:#64748b;">성별 무관 · 다승/승률 순</span>
                                    </div>
                                    <div style="background:#151c2c; border-radius:10px; border:1px solid #26334d; overflow:hidden;">
                                        ${top5Partners.length === 0 ? `
                                            <div style="padding:20px; text-align:center; color:#64748b; font-size:12px;">집계된 복식 파트너 기록이 없습니다.</div>
                                        ` : top5Partners.map((p, idx) => {
                                            const rankBg = idx === 0 ? '#f59e0b' : idx === 1 ? '#94a3b8' : idx === 2 ? '#b45309' : '#1e293b';
                                            const rankColor = idx < 3 ? '#0f1420' : '#cbd5e1';
                                            return `
                                                <div style="display:grid; grid-template-columns:34px 1fr auto; align-items:center; padding:10px 12px; border-bottom:1px solid #1e293b; font-size:12.5px; background:${idx % 2 === 0 ? '#151c2c' : '#111726'};">
                                                    <div>
                                                        <span style="display:inline-block; width:22px; height:22px; line-height:22px; text-align:center; border-radius:5px; background:${rankBg}; color:${rankColor}; font-weight:800; font-size:11px;">${idx + 1}</span>
                                                    </div>
                                                    <div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; padding-right:8px; font-weight:700; color:#ffffff;">
                                                        ${formatNameWithGrade(p.name)}
                                                    </div>
                                                    <div style="text-align:right; white-space:nowrap; font-weight:600;">
                                                        <span style="color:#cbd5e1;">${p.games}전</span>
                                                        <span style="color:#38bdf8; margin-left:3px;">${p.wins}승</span>
                                                        <span style="color:#f43f5e; margin-left:2px;">${p.losses}패</span>
                                                        <span style="color:#f59e0b; font-weight:800; margin-left:4px;">(${p.winRate}%)</span>
                                                    </div>
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>
                                </div>

                                <!-- 4. 최신 게임 내역 (선수 전원 "홍길동(A조)" 형태 표기 & 줄바꿈 방지) -->
                                <div>
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                        <span style="font-size:13px; font-weight:800; color:#38bdf8;">최신 게임 내역</span>
                                        <span style="font-size:11px; color:#64748b;">최근 5경기</span>
                                    </div>
                                    <div style="display:flex; flex-direction:column; gap:6px;">
                                        ${recent5Matches.length === 0 ? `
                                            <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; padding:20px; text-align:center; color:#64748b; font-size:12px;">최근 경기 내역이 없습니다.</div>
                                        ` : recent5Matches.map(m => {
                                            const isTeamA = (m.team_a_p1 === myName || m.team_a_p2 === myName);
                                            const myWin = (isTeamA && m.winner_team === 'A') || (!isTeamA && m.winner_team === 'B');
                                            const badgeBg = myWin ? '#2563eb' : (m.winner_team === 'DRAW' ? '#475569' : '#e11d48');
                                            const resTxt = myWin ? '승리' : (m.winner_team === 'DRAW' ? '무승부' : '패배');

                                            const aP1 = formatNameWithGrade(m.team_a_p1);
                                            const aP2 = m.team_a_p2 ? formatNameWithGrade(m.team_a_p2) : '';
                                            const bP1 = formatNameWithGrade(m.team_b_p1);
                                            const bP2 = m.team_b_p2 ? formatNameWithGrade(m.team_b_p2) : '';

                                            const ourTeam = isTeamA ? `${aP1}${aP2 ? ' · ' + aP2 : ''}` : `${bP1}${bP2 ? ' · ' + bP2 : ''}`;
                                            const oppTeam = isTeamA ? `${bP1}${bP2 ? ' · ' + bP2 : ''}` : `${aP1}${aP2 ? ' · ' + aP2 : ''}`;
                                            const ourScore = isTeamA ? m.score_a : m.score_b;
                                            const oppScore = isTeamA ? m.score_b : m.score_a;

                                            return `
                                                <div style="background:#151c2c; padding:10px 12px; border-radius:8px; border:1px solid #26334d; display:flex; flex-direction:column; gap:6px;">
                                                    <div style="display:flex; justify-content:space-between; align-items:center;">
                                                        <span style="background:#0f1420; color:#94a3b8; border:1px solid #1e293b; font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:4px;">${m.match_type || '복식'}</span>
                                                        <div style="display:flex; align-items:center; gap:8px;">
                                                            <strong style="color:#ffffff; font-size:13px; letter-spacing:0.5px;">
                                                                <span style="color:${myWin ? '#38bdf8' : '#cbd5e1'};">${ourScore}</span> : <span style="color:${!myWin ? '#f43f5e' : '#cbd5e1'};">${oppScore}</span>
                                                            </strong>
                                                            <span style="background:${badgeBg}; color:#ffffff; font-weight:800; font-size:11px; padding:2px 8px; border-radius:4px;">${resTxt}</span>
                                                        </div>
                                                    </div>
                                                    <div style="display:flex; align-items:center; justify-content:space-between; font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                                        <span style="color:#ffffff; font-weight:700; overflow:hidden; text-overflow:ellipsis;">${ourTeam}</span>
                                                        <span style="color:#f59e0b; font-weight:800; font-size:10.5px; margin:0 6px; flex-shrink:0;">VS</span>
                                                        <span style="color:#94a3b8; font-weight:600; overflow:hidden; text-overflow:ellipsis; text-align:right;">${oppTeam}</span>
                                                    </div>
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>
                                </div>
                            `}
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHtml);
        });
    });
};

// =========================================================================
// 3. [관리자 모드] 다중 조건 이벤트 타이틀 빌더 & 포상 상품 설정 & 후보 시뮬레이터
// =========================================================================

// 💡 원클릭 추천 이벤트 템플릿 8종 (포상 상품 기본값 포함)
window.ADMIN_EVENT_PRESETS = [
    {
        label: '🌱 초심·D조 반란왕',
        titleName: '반란의 주인공! 초심·D조 다승왕',
        description: '이번 달 초심 및 D조 정회원 중 최소 5경기 이상 출전하여 최다승을 거둔 회원 포상!',
        prizeInfo: '고급 배드민턴 양말 세트',
        scope: 'player', targetMatchType: 'ALL', gradeFilter: 'LOW_CD', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 5, metricType: 'most_wins'
    },
    {
        label: '🤝 세대공감 호흡상',
        titleName: '우리 이대로 쭈~욱! 세대공감 파트너상',
        description: '서로 다른 연령대의 회원이 파트너가 되어 3경기 이상 최다승을 달성한 복식 팀 포상!',
        prizeInfo: '셔틀콕 1통 (2인 증정)',
        scope: 'pair', targetMatchType: 'ALL', gradeFilter: 'ALL', ageFilter: 'PAIR_DIFF_AGE', genderFilter: 'ALL', minGames: 3, metricType: 'most_wins'
    },
    {
        label: '🎓 멘토&멘티 캐리상',
        titleName: '선배님 믿고 갑니다! 멘토&멘티 호흡상',
        description: '상위 급수(A·B조) 멘토와 중하위 급수(C·D·초심) 멘티가 짝을 이뤄 최다승을 합작한 팀 포상!',
        prizeInfo: '스포츠 이온음료 1박스',
        scope: 'pair', targetMatchType: 'ALL', gradeFilter: 'PAIR_MENTOR', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 3, metricType: 'most_wins'
    },
    {
        label: '💓 2점 차 강심장상',
        titleName: '심장 쫄깃! 2점 차 승부사상',
        description: '1~2점 차 이내의 피 말리는 접전 승부에서 가장 많이 승리한 강심장 회원 포상!',
        prizeInfo: '고급 오버그립 5개입',
        scope: 'player', targetMatchType: 'ALL', gradeFilter: 'ALL', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 5, metricType: 'clutch_wins'
    },
    {
        label: '🔥 코트 철인 개근상',
        titleName: '지치지 않는 에너자이저! 코트 철인상',
        description: '승패와 급수에 상관없이 이번 달 가장 많은 경기에 출전하며 코트를 빛낸 열정 회원 포상!',
        prizeInfo: '셔틀콕 1통',
        scope: 'player', targetMatchType: 'ALL', gradeFilter: 'ALL', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 10, metricType: 'most_games'
    },
    {
        label: '🏃 칠전팔기 열정상',
        titleName: '꺾이지 않는 마음! 칠전팔기 열정상',
        description: '비록 패배가 가장 많았지만 끝까지 웃으며 코트를 지킨 정회원 특별 격려 포상!',
        prizeInfo: '비타민 에너지 드링크 세트',
        scope: 'player', targetMatchType: 'ALL', gradeFilter: 'ALL', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 5, metricType: 'most_losses'
    },
    {
        label: '💑 혼복 무패 듀오상',
        titleName: '눈빛만 봐도 통한다! 혼복 무패 듀오상',
        description: '혼합복식에서 3경기 이상 출전하여 단 한 번도 지지 않고 승률 100%를 달성한 팀 포상!',
        prizeInfo: '커피 기프티콘 2매',
        scope: 'pair', targetMatchType: '혼복', gradeFilter: 'ALL', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 3, metricType: 'win_rate_100'
    },
    {
        label: '⚡ 중하위 연승 폭주상',
        titleName: '막을 자가 없다! C·D·초심 연승왕',
        description: '초심·D조·C조 회원 중 이번 달 끊기지 않는 최장 연승 기록을 세운 회원 포상!',
        prizeInfo: '고급 스포츠 타월',
        scope: 'player', targetMatchType: 'ALL', gradeFilter: 'LOW_CDC', ageFilter: 'ALL', genderFilter: 'ALL', minGames: 4, metricType: 'max_streak'
    }
];

window.openAdminEventTitleManager = function(previewPeriod = 'month') {
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';

    socket.emit('getMatchStats', { clubId, period: previewPeriod, minGames: 1 }, (res) => {
        if (!res || !res.success) {
            alert('전적 및 이벤트 타이틀 데이터를 불러오지 못했습니다.');
            return;
        }

        window._adminTitleCache = {
            period: previewPeriod,
            members: res.members || [],
            playersStats: res.playersStats || [],
            pairsStats: res.pairsStats || res.pairStats || [],
            customTitles: res.customTitles || []
        };

        const customTitles = res.customTitles || [];
        const existing = document.getElementById('admin-event-title-modal');
        if (existing) existing.remove();

        const modalHtml = `
            <div id="admin-event-title-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(5, 8, 15, 0.9); display:flex; justify-content:center; align-items:center; z-index:99999; padding:10px; box-sizing:border-box;">
                <div style="background:#0f1420; color:#f8fafc; width:100%; max-width:520px; max-height:92vh; border-radius:14px; display:flex; flex-direction:column; border:1.5px solid #f59e0b; box-shadow:0 15px 45px rgba(0,0,0,0.9); overflow:hidden;">
                    
                    <!-- 상단 헤더 (스마트폰 줄바꿈 방지) -->
                    <div style="padding:13px 16px; background:#151c2c; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                        <h3 style="margin:0; font-size:15px; font-weight:800; color:#f59e0b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">이달의 이벤트 타이틀 관리</h3>
                        <button onclick="document.getElementById('admin-event-title-modal').remove()" style="background:#1e293b; color:#e2e8f0; border:1px solid #334155; border-radius:7px; padding:6px 12px; font-weight:700; cursor:pointer; font-size:12px; white-space:nowrap; flex-shrink:0;">닫기</button>
                    </div>

                    <!-- 본문 스크롤 영역 -->
                    <div style="padding:12px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:14px;">
                        
                        <!-- STEP 1. 추천 템플릿 8종 -->
                        <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; padding:11px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                <span style="font-size:12px; font-weight:800; color:#38bdf8; white-space:nowrap;">STEP 1. 추천 이벤트 템플릿 (선택 시 자동 입력)</span>
                                <button type="button" onclick="window.resetAdminTitleForm()" style="padding:3px 8px; background:#1e293b; color:#cbd5e1; border:1px solid #334155; border-radius:4px; font-size:10.5px; font-weight:600; cursor:pointer; white-space:nowrap;">초기화</button>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:6px;">
                                ${window.ADMIN_EVENT_PRESETS.map((p, idx) => `
                                    <button type="button" onclick="window.applyAdminTitlePreset(${idx})" style="padding:7px 8px; background:#0f1420; color:#e2e8f0; border:1px solid #26334d; border-radius:6px; font-size:11.5px; font-weight:700; text-align:left; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                        ${p.label}
                                    </button>
                                `).join('')}
                            </div>
                        </div>

                        <!-- STEP 2. 조건 설정 및 후보 실시간 확인 -->
                        <div style="background:#151c2c; border:1px solid #26334d; border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px;">
                            <div id="admin-form-mode-title" style="font-size:12.5px; font-weight:800; color:#38bdf8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                STEP 2. 달성 조건 설정 및 후보 확인
                            </div>

                            <input type="hidden" id="admin-edit-title-id" value="">

                            <!-- 2열 그리드로 정돈하여 모바일 화면에서 글자 깨짐 원천 방지 -->
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">① 선정 단위</label>
                                    <select id="admin-cond-scope" onchange="window.onAdminScopeChange()" style="width:100%; padding:7px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#38bdf8; font-weight:800; font-size:11.5px;">
                                        <option value="player">개인 부문 (1인)</option>
                                        <option value="pair">파트너 부문 (2인 팀)</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">② 대상 종목</label>
                                    <select id="admin-cond-match-type" onchange="window.previewAdminTitleCandidates()" style="width:100%; padding:7px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-size:11.5px;">
                                        <option value="ALL">전체 종목</option>
                                        <option value="남복">남복만</option>
                                        <option value="여복">여복만</option>
                                        <option value="혼복">혼복만</option>
                                    </select>
                                </div>
                            </div>

                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">③ 급수 조건</label>
                                    <select id="admin-cond-grade" onchange="window.previewAdminTitleCandidates()" style="width:100%; padding:7px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-size:11.5px;"></select>
                                </div>
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">④ 연령대 조건</label>
                                    <select id="admin-cond-age" onchange="window.previewAdminTitleCandidates()" style="width:100%; padding:7px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-size:11.5px;"></select>
                                </div>
                            </div>

                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">⑤ 성별 조건</label>
                                    <select id="admin-cond-gender" onchange="window.previewAdminTitleCandidates()" style="width:100%; padding:7px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-size:11.5px;">
                                        <option value="ALL">성별 무관</option>
                                        <option value="남">남성 회원만</option>
                                        <option value="여">여성 회원만</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">⑥ 최소 출전 수</label>
                                    <input type="number" id="admin-cond-min-games" value="3" min="1" max="100" oninput="window.previewAdminTitleCandidates()" style="width:100%; padding:7px 10px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-size:11.5px; box-sizing:border-box;">
                                </div>
                            </div>

                            <div>
                                <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">⑦ 수상 산출 기준 (9종)</label>
                                <select id="admin-cond-metric" onchange="window.previewAdminTitleCandidates()" style="width:100%; padding:8px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#f59e0b; font-weight:800; font-size:12px;">
                                    <option value="most_wins">🏆 다승 (최다 승리)</option>
                                    <option value="win_rate">🎯 최고 승률 (승률 1위)</option>
                                    <option value="win_rate_100">👑 무패 신화 (승률 100% 다승 순)</option>
                                    <option value="most_games">🔥 최다 출전 (코트 철인·개근)</option>
                                    <option value="clutch_wins">💓 접전 승부사 (2점 차 이내 최다승)</option>
                                    <option value="big_wins">🚀 대승 폭격기 (10점 차 이상 대승)</option>
                                    <option value="max_streak">⚡ 최다 연승 (연속 승리 기록)</option>
                                    <option value="point_diff">📈 최고 득실차 (득점-실점 1위)</option>
                                    <option value="most_losses">🏃 칠전팔기 열정상 (최다 패배 격려)</option>
                                </select>
                            </div>

                            <!-- 실시간 조건 부합 후보 리스트 -->
                            <div style="background:#0f1420; border:1px solid #26334d; border-radius:8px; padding:10px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:4px;">
                                    <span style="font-size:11.5px; font-weight:800; color:#34d399; white-space:nowrap;">🔍 조건 부합 정회원 후보 (TOP 10)</span>
                                    <div style="display:flex; gap:4px; flex-shrink:0;">
                                        <button type="button" onclick="window.openAdminEventTitleManager('month')" style="padding:3px 7px; background:${previewPeriod === 'month' ? '#2563eb' : '#151c2c'}; color:#ffffff; border:1px solid #334155; border-radius:4px; font-size:10px; cursor:pointer; white-space:nowrap;">이번 달</button>
                                        <button type="button" onclick="window.openAdminEventTitleManager('last_month')" style="padding:3px 7px; background:${previewPeriod === 'last_month' ? '#2563eb' : '#151c2c'}; color:#ffffff; border:1px solid #334155; border-radius:4px; font-size:10px; cursor:pointer; white-space:nowrap;">지난달</button>
                                    </div>
                                </div>
                                <div id="admin-candidate-preview-list" style="max-height:135px; overflow-y:auto; display:flex; flex-direction:column; gap:4px;"></div>
                            </div>
                        </div>

                        <!-- STEP 3. 타이틀명, 포상 상품 및 게시 상태 입력 -->
                        <div style="background:#151c2c; border:1.5px solid #f59e0b; border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span style="font-size:12.5px; font-weight:800; color:#f59e0b; white-space:nowrap;">STEP 3. 타이틀명 · 포상 상품 및 저장</span>
                                <button type="button" onclick="window.autoGenerateAdminDesc()" style="padding:3px 8px; background:#1e293b; color:#38bdf8; border:1px solid #334155; border-radius:4px; font-size:10.5px; font-weight:700; cursor:pointer; white-space:nowrap;">조건 설명 자동완성</button>
                            </div>

                            <div>
                                <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px;">포상 타이틀명 (필수)</label>
                                <input type="text" id="admin-new-title-name" placeholder="예: 우리 이대로 쭈~욱! 세대공감 파트너상" style="width:100%; padding:8px 10px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-weight:700; font-size:12px; box-sizing:border-box;">
                            </div>

                            <div>
                                <label style="font-size:11px; color:#fbbf24; font-weight:700; display:block; margin-bottom:3px;">🎁 포상 상품 안내 (회원 화면에 노출)</label>
                                <input type="text" id="admin-new-prize-info" placeholder="예: 요넥스 셔틀콕 1통 / 스포츠 양말 세트 / 상품권 등" style="width:100%; padding:8px 10px; background:#0f1420; border:1px solid #f59e0b; border-radius:6px; color:#fbbf24; font-weight:700; font-size:12px; box-sizing:border-box;">
                            </div>

                            <div>
                                <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px;">달성 조건 및 미션 설명</label>
                                <textarea id="admin-new-title-desc" placeholder="회원들이 도전 목표를 알 수 있도록 미션 조건을 적어주세요." style="width:100%; height:48px; padding:8px 10px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#e2e8f0; font-size:11.5px; box-sizing:border-box; resize:none;"></textarea>
                            </div>

                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">게시 상태</label>
                                    <select id="admin-title-status" style="width:100%; padding:8px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#ffffff; font-weight:700; font-size:11.5px;">
                                        <option value="pending">⏳ 월초 예고 (집계 중)</option>
                                        <option value="published">🏆 월말 발표 (수상 확정)</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size:11px; color:#94a3b8; font-weight:700; display:block; margin-bottom:3px; white-space:nowrap;">수상자 (후보 [선정] 또는 직접 입력)</label>
                                    <input type="text" id="admin-manual-winner" placeholder="비워두면 1위 자동 적용" style="width:100%; padding:8px 10px; background:#0f1420; border:1px solid #334155; border-radius:6px; color:#f59e0b; font-weight:800; font-size:11.5px; box-sizing:border-box;">
                                </div>
                            </div>

                            <button type="button" id="admin-submit-title-btn" onclick="window.submitNewCustomTitle()" style="padding:11px; background:linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color:#0f1420; border:none; border-radius:8px; font-weight:800; font-size:13px; cursor:pointer; margin-top:2px;">
                                이벤트 타이틀 저장하기
                            </button>
                        </div>

                        <!-- 4. 등록된 이벤트 타이틀 목록 -->
                        <div>
                            <div style="font-size:12.5px; font-weight:800; color:#f59e0b; margin-bottom:8px;">📋 등록된 이벤트 타이틀 (${customTitles.length}개)</div>
                            <div style="display:flex; flex-direction:column; gap:8px;">
                                ${customTitles.length === 0 ? `
                                    <div style="background:#151c2c; border:1px solid #26334d; border-radius:8px; padding:20px; text-align:center; color:#64748b; font-size:11.5px;">등록된 이벤트 타이틀이 없습니다.</div>
                                ` : customTitles.map((ct, idx) => {
                                    const isPub = ct.status === 'published';
                                    return `
                                        <div style="background:#151c2c; border:1px solid #26334d; border-left:4px solid ${isPub ? '#f59e0b' : '#38bdf8'}; border-radius:8px; padding:11px; display:flex; flex-direction:column; gap:6px;">
                                            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                                                <div style="display:flex; align-items:center; gap:6px; overflow:hidden;">
                                                    <span style="background:${isPub ? '#f59e0b' : '#1e293b'}; color:${isPub ? '#0f1420' : '#38bdf8'}; font-size:10px; font-weight:800; padding:2px 6px; border-radius:4px; white-space:nowrap; flex-shrink:0;">
                                                        ${isPub ? '발표 완료' : '예고 중'}
                                                    </span>
                                                    <strong style="color:#ffffff; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ct.titleName}</strong>
                                                </div>
                                                <div style="display:flex; gap:4px; flex-shrink:0;">
                                                    <button type="button" onclick="window.loadTitleForEdit(${idx})" style="background:#1e3a8a; color:#93c5fd; border:1px solid #2563eb; border-radius:5px; padding:4px 8px; font-weight:700; font-size:10.5px; cursor:pointer; white-space:nowrap;">수정/선정</button>
                                                    <button type="button" onclick="window.deleteCustomTitle('${ct.id}')" style="background:#7f1d1d; color:#fca5a5; border:1px solid #991b1b; border-radius:5px; padding:4px 8px; font-weight:700; font-size:10.5px; cursor:pointer; white-space:nowrap;">삭제</button>
                                                </div>
                                            </div>
                                            ${ct.prizeInfo ? `<div style="font-size:11px; color:#fbbf24; font-weight:700;">🎁 포상 상품: ${ct.prizeInfo}</div>` : ''}
                                            <div style="font-size:11px; color:#cbd5e1; line-height:1.35;">${ct.description || ''}</div>
                                            <div style="background:#0f1420; border-radius:5px; padding:6px 8px; font-size:11px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
                                                <span style="color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">1위 후보: <strong style="color:#38bdf8;">${ct.autoWinner || '집계 중'}</strong></span>
                                                <span style="color:#cbd5e1; white-space:nowrap; flex-shrink:0;">표기: <strong style="color:#f59e0b;">${isPub ? ct.winner : '미공개'}</strong></span>
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        window.onAdminScopeChange();
    });
};

window.onAdminScopeChange = function(savedGrade = 'ALL', savedAge = 'ALL') {
    const scopeEl = document.getElementById('admin-cond-scope');
    const gradeEl = document.getElementById('admin-cond-grade');
    const ageEl = document.getElementById('admin-cond-age');
    if (!scopeEl || !gradeEl || !ageEl) return;

    if (scopeEl.value === 'pair') {
        gradeEl.innerHTML = `
            <option value="ALL">급수 무관 (전체 파트너)</option>
            <option value="PAIR_MENTOR">🎓 멘토&멘티 (A·B + C·D·초심)</option>
            <option value="PAIR_SAME">🤝 동일 급수끼리 파트너</option>
            <option value="PAIR_LOW">🌱 초심·D조끼리 파트너</option>
            <option value="PAIR_MID_LOW">🔥 초심·D·C조끼리 파트너</option>
            <option value="초심">초심 포함 팀</option>
            <option value="D조">D조 포함 팀</option>
            <option value="C조">C조 포함 팀</option>
            <option value="B조">B조 포함 팀</option>
            <option value="A조">A조 포함 팀</option>
        `;
        ageEl.innerHTML = `
            <option value="ALL">연령 무관 (전체 파트너)</option>
            <option value="PAIR_DIFF_AGE">🌉 세대공감 (서로 다른 연령대)</option>
            <option value="PAIR_GAP_20">🌟 세대초월 (20년 이상 차이)</option>
            <option value="PAIR_SAME_AGE">👫 동년배 단짝 (같은 연령대)</option>
            <option value="20">20대 포함 팀</option>
            <option value="30">30대 포함 팀</option>
            <option value="40">40대 포함 팀</option>
            <option value="50">50대 포함 팀</option>
            <option value="60">60대+ 포함 팀</option>
        `;
    } else {
        gradeEl.innerHTML = `
            <option value="ALL">전체 급수</option>
            <option value="LOW_CD">🌱 초심 + D조 통합</option>
            <option value="LOW_CDC">🔥 초심 + D조 + C조 통합</option>
            <option value="초심">초심만</option>
            <option value="D조">D조만</option>
            <option value="C조">C조만</option>
            <option value="B조">B조만</option>
            <option value="A조">A조만</option>
        `;
        ageEl.innerHTML = `
            <option value="ALL">전체 연령대</option>
            <option value="YOUTH_2030">⚡ 청년층 (20대 + 30대)</option>
            <option value="SENIOR_5060">💎 중장년층 (50대 + 60대+)</option>
            <option value="20">20대만</option>
            <option value="30">30대만</option>
            <option value="40">40대만</option>
            <option value="50">50대만</option>
            <option value="60">60대 이상만</option>
        `;
    }

    gradeEl.value = savedGrade;
    if (!gradeEl.value) gradeEl.value = 'ALL';
    ageEl.value = savedAge;
    if (!ageEl.value) ageEl.value = 'ALL';

    window.previewAdminTitleCandidates();
};

window.previewAdminTitleCandidates = function() {
    const cache = window._adminTitleCache;
    const container = document.getElementById('admin-candidate-preview-list');
    if (!cache || !container) return;

    const scope = document.getElementById('admin-cond-scope').value;
    const targetType = document.getElementById('admin-cond-match-type').value;
    const genderFilter = document.getElementById('admin-cond-gender').value;
    const gradeFilter = document.getElementById('admin-cond-grade').value;
    const ageFilter = document.getElementById('admin-cond-age').value;
    const metric = document.getElementById('admin-cond-metric').value;
    const minG = Math.max(1, parseInt(document.getElementById('admin-cond-min-games').value, 10) || 1);

    const isRegular = (mType) => {
        const u = String(mType || '정회원').toUpperCase();
        return !u.includes('일일') && !u.includes('게스트') && !u.includes('GUEST');
    };
    const getGradeRank = (g) => ({ 'S조': 6, 'A조': 5, 'B조': 4, 'C조': 3, 'D조': 2, '초심': 1 }[g] || 0);

    let list = [];
    if (scope === 'pair') {
        const regPairs = (cache.pairsStats || []).filter(pr => isRegular(pr.p1Type) && isRegular(pr.p2Type));
        list = regPairs.filter(pr => {
            if (genderFilter === '남' && (pr.p1Gender !== '남' || pr.p2Gender !== '남')) return false;
            if (genderFilter === '여' && (pr.p1Gender !== '여' || pr.p2Gender !== '여')) return false;

            const r1 = getGradeRank(pr.p1Grade);
            const r2 = getGradeRank(pr.p2Grade);
            if (gradeFilter === 'PAIR_SAME' && (!pr.p1Grade || pr.p1Grade !== pr.p2Grade)) return false;
            if (gradeFilter === 'PAIR_MENTOR' && !((r1 >= 4 && r2 >= 1 && r2 <= 3) || (r2 >= 4 && r1 >= 1 && r1 <= 3))) return false;
            if (gradeFilter === 'PAIR_LOW' && (r1 < 1 || r1 > 2 || r2 < 1 || r2 > 2)) return false;
            if (gradeFilter === 'PAIR_MID_LOW' && (r1 < 1 || r1 > 3 || r2 < 1 || r2 > 3)) return false;
            if (['초심', 'D조', 'C조', 'B조', 'A조'].includes(gradeFilter) && pr.p1Grade !== gradeFilter && pr.p2Grade !== gradeFilter) return false;

            const a1 = parseInt(pr.p1Age, 10) || 0;
            const a2 = parseInt(pr.p2Age, 10) || 0;
            if (ageFilter === 'PAIR_DIFF_AGE' && (!a1 || !a2 || a1 === a2)) return false;
            if (ageFilter === 'PAIR_GAP_20' && (!a1 || !a2 || Math.abs(a1 - a2) < 20)) return false;
            if (ageFilter === 'PAIR_SAME_AGE' && (!a1 || !a2 || a1 !== a2)) return false;
            if (['20', '30', '40', '50', '60'].includes(ageFilter)) {
                const tAge = parseInt(ageFilter, 10);
                if (tAge === 60 ? (a1 < 60 && a2 < 60) : (a1 !== tAge && a2 !== tAge)) return false;
            }
            return true;
        }).map(pr => {
            const stat = (targetType !== 'ALL' && pr.byType && pr.byType[targetType]) ? pr.byType[targetType] : pr;
            const games = stat.games || 0;
            const wins = stat.wins || 0;
            const losses = stat.losses || 0;
            const winRate = games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
            const pointDiff = (stat.pointsFor || 0) - (stat.pointsAgainst || 0);
            return {
                displayName: `${pr.p1Formatted} · ${pr.p2Formatted}`,
                evalGames: games, evalWins: wins, evalLosses: losses, evalWinRate: winRate,
                evalClutchWins: stat.clutchWins || 0, evalBigWins: stat.bigWins || 0,
                evalMaxStreak: stat.maxStreak || 0, evalPointDiff: pointDiff
            };
        });
    } else {
        const regPlayers = (cache.playersStats || []).filter(p => isRegular(p.memberType));
        list = regPlayers.filter(p => {
            if (genderFilter !== 'ALL' && p.gender !== genderFilter) return false;
            const g = p.grade || '';
            if (gradeFilter === 'LOW_CD' && g !== '초심' && g !== 'D조') return false;
            if (gradeFilter === 'LOW_CDC' && g !== '초심' && g !== 'D조' && g !== 'C조') return false;
            if (['초심', 'D조', 'C조', 'B조', 'A조'].includes(gradeFilter) && g !== gradeFilter) return false;

            const ageNum = parseInt(p.ageGroup, 10) || 0;
            if (ageFilter === 'YOUTH_2030' && ageNum !== 20 && ageNum !== 30) return false;
            if (ageFilter === 'SENIOR_5060' && ageNum < 50) return false;
            if (['20', '30', '40', '50', '60'].includes(ageFilter)) {
                const tAge = parseInt(ageFilter, 10);
                if (tAge === 60 ? ageNum < 60 : ageNum !== tAge) return false;
            }
            return true;
        }).map(p => {
            const stat = (targetType !== 'ALL' && p.byType && p.byType[targetType]) ? p.byType[targetType] : p;
            const games = stat.games || 0;
            const wins = stat.wins || 0;
            const losses = stat.losses || 0;
            const winRate = games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
            const pointDiff = (stat.pointsFor || 0) - (stat.pointsAgainst || 0);
            return {
                displayName: `${p.name}${p.grade ? '(' + p.grade + ')' : ''}`,
                evalGames: games, evalWins: wins, evalLosses: losses, evalWinRate: winRate,
                evalClutchWins: stat.clutchWins || 0, evalBigWins: stat.bigWins || 0,
                evalMaxStreak: stat.maxStreak || 0, evalPointDiff: pointDiff
            };
        });
    }

    let qualified = list.filter(i => i.evalGames >= minG);

    if (metric === 'most_wins') {
        qualified = qualified.filter(i => i.evalWins > 0).sort((a, b) => (b.evalWins - a.evalWins) || (b.evalWinRate - a.evalWinRate));
        qualified.forEach(i => { i.metricText = `${i.evalWins}승 (${i.evalWinRate}%)`; });
    } else if (metric === 'win_rate') {
        qualified = qualified.filter(i => i.evalWins > 0).sort((a, b) => (b.evalWinRate - a.evalWinRate) || (b.evalWins - a.evalWins));
        qualified.forEach(i => { i.metricText = `승률 ${i.evalWinRate}% (${i.evalWins}승)`; });
    } else if (metric === 'win_rate_100') {
        qualified = qualified.filter(i => i.evalWinRate === 100 && i.evalWins > 0).sort((a, b) => b.evalWins - a.evalWins);
        qualified.forEach(i => { i.metricText = `${i.evalWins}전 전승`; });
    } else if (metric === 'most_games') {
        qualified = qualified.sort((a, b) => (b.evalGames - a.evalGames) || (b.evalWins - a.evalWins));
        qualified.forEach(i => { i.metricText = `${i.evalGames}전 출전`; });
    } else if (metric === 'clutch_wins') {
        qualified = qualified.filter(i => i.evalClutchWins > 0).sort((a, b) => (b.evalClutchWins - a.evalClutchWins) || (b.evalWins - a.evalWins));
        qualified.forEach(i => { i.metricText = `접전 ${i.evalClutchWins}승`; });
    } else if (metric === 'big_wins') {
        qualified = qualified.filter(i => i.evalBigWins > 0).sort((a, b) => (b.evalBigWins - a.evalBigWins) || (b.evalPointDiff - a.evalPointDiff));
        qualified.forEach(i => { i.metricText = `대승 ${i.evalBigWins}회`; });
    } else if (metric === 'max_streak') {
        qualified = qualified.filter(i => i.evalMaxStreak > 0).sort((a, b) => (b.evalMaxStreak - a.evalMaxStreak) || (b.evalWins - a.evalWins));
        qualified.forEach(i => { i.metricText = `${i.evalMaxStreak}연승`; });
    } else if (metric === 'point_diff') {
        qualified = qualified.sort((a, b) => (b.evalPointDiff - a.evalPointDiff) || (b.evalWins - a.evalWins));
        qualified.forEach(i => { i.metricText = `득실 ${i.evalPointDiff >= 0 ? '+' + i.evalPointDiff : i.evalPointDiff}`; });
    } else if (metric === 'most_losses') {
        qualified = qualified.filter(i => i.evalLosses > 0).sort((a, b) => (b.evalLosses - a.evalLosses) || (b.evalGames - a.evalGames));
        qualified.forEach(i => { i.metricText = `${i.evalGames}전 ${i.evalLosses}패`; });
    }

    const top10 = qualified.slice(0, 10);

    if (top10.length === 0) {
        container.innerHTML = `<div style="padding:12px; text-align:center; color:#64748b; font-size:11px;">현재 조건을 만족하는 후보가 없습니다. (최소 출전 수를 낮춰보세요)</div>`;
        return;
    }

    container.innerHTML = top10.map((c, idx) => {
        const winnerStr = `${c.displayName} · ${c.metricText}`.replace(/'/g, "\\'");
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:#151c2c; border:1px solid #1e293b; border-radius:5px; font-size:11.5px; gap:6px;">
                <div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">
                    <span style="color:#f59e0b; font-weight:800; margin-right:4px;">${idx + 1}위</span>
                    <strong style="color:#ffffff;">${c.displayName}</strong>
                </div>
                <div style="display:flex; align-items:center; gap:6px; flex-shrink:0; white-space:nowrap;">
                    <span style="color:#38bdf8; font-weight:700; font-size:11px;">${c.metricText}</span>
                    <button type="button" onclick="window.selectCandidateAsWinner('${winnerStr}')" style="padding:3px 7px; background:#2563eb; color:#ffffff; border:none; border-radius:4px; font-size:10px; font-weight:800; cursor:pointer;">선정</button>
                </div>
            </div>
        `;
    }).join('');
};

window.selectCandidateAsWinner = function(winnerText) {
    const winnerEl = document.getElementById('admin-manual-winner');
    const statusEl = document.getElementById('admin-title-status');
    if (winnerEl) winnerEl.value = winnerText;
    if (statusEl) statusEl.value = 'published';
};

window.applyAdminTitlePreset = function(idx) {
    const p = window.ADMIN_EVENT_PRESETS[idx];
    if (!p) return;

    document.getElementById('admin-edit-title-id').value = '';
    document.getElementById('admin-form-mode-title').innerText = 'STEP 2. 달성 조건 설정 (템플릿 적용됨)';
    document.getElementById('admin-new-title-name').value = p.titleName;
    document.getElementById('admin-new-prize-info').value = p.prizeInfo || '';
    document.getElementById('admin-new-title-desc').value = p.description;
    document.getElementById('admin-cond-scope').value = p.scope;
    document.getElementById('admin-cond-match-type').value = p.targetMatchType;
    document.getElementById('admin-cond-gender').value = p.genderFilter;
    document.getElementById('admin-cond-metric').value = p.metricType;
    document.getElementById('admin-cond-min-games').value = p.minGames;
    document.getElementById('admin-manual-winner').value = '';
    document.getElementById('admin-title-status').value = 'pending';

    window.onAdminScopeChange(p.gradeFilter, p.ageFilter);
};

window.autoGenerateAdminDesc = function() {
    const scopeTxt = document.getElementById('admin-cond-scope').selectedOptions[0].text;
    const typeTxt = document.getElementById('admin-cond-match-type').selectedOptions[0].text;
    const genderTxt = document.getElementById('admin-cond-gender').selectedOptions[0].text;
    const gradeTxt = document.getElementById('admin-cond-grade').selectedOptions[0].text.replace(/^[^\s]+\s/, '');
    const ageTxt = document.getElementById('admin-cond-age').selectedOptions[0].text.replace(/^[^\s]+\s/, '');
    const metricTxt = document.getElementById('admin-cond-metric').selectedOptions[0].text.replace(/^[^\s]+\s/, '');
    const minG = document.getElementById('admin-cond-min-games').value || 3;

    const parts = [];
    if (typeTxt !== '전체 종목') parts.push(typeTxt);
    if (genderTxt !== '성별 무관') parts.push(genderTxt);
    if (!gradeTxt.includes('무관') && !gradeTxt.includes('전체')) parts.push(gradeTxt);
    if (!ageTxt.includes('무관') && !ageTxt.includes('전체')) parts.push(ageTxt);

    const targetDesc = parts.length > 0 ? `[${parts.join(' · ')}]` : '전체 정회원';
    const unitDesc = scopeTxt.includes('파트너') ? '파트너 팀' : '회원';

    document.getElementById('admin-new-title-desc').value = `이번 달 ${targetDesc} 대상 최소 ${minG}경기 이상 출전하여 [${metricTxt}] 1위를 달성한 ${unitDesc} 포상!`;
};

window.loadTitleForEdit = function(idx) {
    const cache = window._adminTitleCache;
    if (!cache || !cache.customTitles || !cache.customTitles[idx]) return;
    const ct = cache.customTitles[idx];
    const cond = ct.condition || {};

    document.getElementById('admin-edit-title-id').value = ct.id;
    document.getElementById('admin-form-mode-title').innerHTML = `<span style="color:#f59e0b;">✏️ 타이틀 수정 / 수상자 확정: [${ct.titleName}]</span>`;
    document.getElementById('admin-new-title-name').value = ct.titleName || '';
    document.getElementById('admin-new-prize-info').value = ct.prizeInfo || '';
    document.getElementById('admin-new-title-desc').value = ct.description || '';
    document.getElementById('admin-cond-scope').value = cond.scope || 'player';
    document.getElementById('admin-cond-match-type').value = cond.targetMatchType || 'ALL';
    document.getElementById('admin-cond-gender').value = cond.genderFilter || 'ALL';
    document.getElementById('admin-cond-metric').value = cond.metricType || 'most_wins';
    document.getElementById('admin-cond-min-games').value = cond.minGames || 3;
    document.getElementById('admin-title-status').value = ct.status || 'pending';
    document.getElementById('admin-manual-winner').value = ct.manualWinner || '';

    window.onAdminScopeChange(cond.gradeFilter || 'ALL', cond.ageFilter || 'ALL');
};

window.resetAdminTitleForm = function() {
    document.getElementById('admin-edit-title-id').value = '';
    document.getElementById('admin-form-mode-title').innerText = 'STEP 2. 달성 조건 설정 및 후보 확인';
    document.getElementById('admin-new-title-name').value = '';
    document.getElementById('admin-new-prize-info').value = '';
    document.getElementById('admin-new-title-desc').value = '';
    document.getElementById('admin-cond-scope').value = 'player';
    document.getElementById('admin-cond-match-type').value = 'ALL';
    document.getElementById('admin-cond-gender').value = 'ALL';
    document.getElementById('admin-cond-metric').value = 'most_wins';
    document.getElementById('admin-cond-min-games').value = 3;
    document.getElementById('admin-title-status').value = 'pending';
    document.getElementById('admin-manual-winner').value = '';
    window.onAdminScopeChange('ALL', 'ALL');
};

window.submitNewCustomTitle = function() {
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';
    const id = document.getElementById('admin-edit-title-id').value || null;
    const titleName = document.getElementById('admin-new-title-name').value.trim();
    const prizeInfo = document.getElementById('admin-new-prize-info').value.trim();
    const description = document.getElementById('admin-new-title-desc').value.trim();
    const status = document.getElementById('admin-title-status').value;
    const manualWinner = document.getElementById('admin-manual-winner').value.trim();

    const condition = {
        scope: document.getElementById('admin-cond-scope').value,
        targetMatchType: document.getElementById('admin-cond-match-type').value,
        genderFilter: document.getElementById('admin-cond-gender').value,
        gradeFilter: document.getElementById('admin-cond-grade').value,
        ageFilter: document.getElementById('admin-cond-age').value,
        metricType: document.getElementById('admin-cond-metric').value,
        minGames: parseInt(document.getElementById('admin-cond-min-games').value, 10) || 3,
        prizeInfo: prizeInfo
    };

    if (!titleName) {
        alert('포상 타이틀명을 입력해 주세요.');
        return;
    }

    socket.emit('saveCustomTitle', {
        clubId,
        id,
        titleName,
        description,
        prizeInfo,
        targetMatchType: condition.targetMatchType,
        minGames: condition.minGames,
        metricType: condition.metricType,
        badgeTheme: 'gold',
        manualWinner: manualWinner || null,
        status,
        condition
    }, (res) => {
        if (res && res.success) {
            alert(res.message || '저장되었습니다!');
            const period = (window._adminTitleCache && window._adminTitleCache.period) || 'month';
            window.openAdminEventTitleManager(period);
        } else {
            alert((res && res.message) || '저장에 실패했습니다.');
        }
    });
};

window.deleteCustomTitle = function(id) {
    if (!confirm('이 이벤트 타이틀을 삭제하시겠습니까?')) return;
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';
    socket.emit('deleteCustomTitle', { clubId, id }, (res) => {
        if (res && res.success) {
            const period = (window._adminTitleCache && window._adminTitleCache.period) || 'month';
            window.openAdminEventTitleManager(period);
        } else {
            alert('삭제에 실패했습니다.');
        }
    });
};

// =========================================================================
// 4. [관리자 전용] 자체대회 대진표 작성용 정회원 기간별 전적 통계 엑셀(CSV) 다운로드
// =========================================================================
window.exportRegularMemberStatsCSV = function() {
    const clubId = window.currentClubId || localStorage.getItem('selectedClubId') || 'unjeong';
    const periodEl = document.getElementById('admin-export-stats-period');
    const selectedPeriod = periodEl ? periodEl.value : '3months';

    const periodLabelMap = {
        'all': '전체누적',
        '3months': '최근3개월',
        'month': '이번달',
        'last_month': '지난달'
    };
    const periodLabel = periodLabelMap[selectedPeriod] || selectedPeriod;

    socket.emit('getMatchStats', { clubId, period: selectedPeriod, minGames: 1 }, (res) => {
        if (!res || !res.success) {
            alert('전적 데이터를 불러오지 못했습니다.');
            return;
        }

        const allPlayers = res.playersStats || [];
        const allPairs = res.pairsStats || res.pairStats || [];
        const members = res.members || [];

        // 회원 정보(급수, 성별, 연령대, 정회원 여부) 매핑 보완
        const memberMap = {};
        members.forEach(m => {
            if (m && m.name) memberMap[String(m.name).trim()] = m;
        });

        const isRegularMember = (mType) => {
            const u = String(mType || '정회원').toUpperCase();
            return !u.includes('일일') && !u.includes('게스트') && !u.includes('GUEST');
        };

        // 1) 정회원 개인 전적 필터링 및 정렬 (급수순 -> 승률순 -> 다승순)
        const regularPlayers = allPlayers.filter(p => {
            const prof = memberMap[p.name] || {};
            return isRegularMember(p.memberType || prof.memberType);
        }).map(p => {
            const prof = memberMap[p.name] || {};
            return {
                ...p,
                grade: p.grade || prof.grade || '미지정',
                gender: p.gender || prof.gender || '-',
                ageGroup: p.ageGroup || prof.ageGroup || '-'
            };
        });

        if (regularPlayers.length === 0) {
            alert(`[${periodLabel}] 기간에 기록된 정회원 전적 데이터가 없습니다.`);
            return;
        }

        // 정회원 이름 Set (파트너 통계 필터링용)
        const regularNamesSet = new Set(regularPlayers.map(p => p.name));

        // 2) 정회원 간 복식 파트너 전적 필터링
        const regularPairs = allPairs.filter(pr => {
            const p1 = pr.player1 || (pr.players && pr.players[0]) || '';
            const p2 = pr.player2 || (pr.players && pr.players[1]) || '';
            return pr.games > 0 && regularNamesSet.has(p1) && regularNamesSet.has(p2);
        });

        // CSV 셀 이스케이프 헬퍼
        const escapeCsv = (val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };

        const formatTypeStat = (byType, typeName) => {
            const st = (byType && byType[typeName]) ? byType[typeName] : { games: 0, wins: 0, losses: 0 };
            if (!st.games) return '0전';
            const rate = Math.round((st.wins / st.games) * 100);
            return `${st.games}전 ${st.wins}승 ${st.losses}패 (${rate}%)`;
        };

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const csvRows = [];

        // 상단 요약 헤더
        csvRows.push([`[오늘민턴] 클럽 정회원 전적 통계 리포트 (자체대회 대진표 작성 참고자료)`].map(escapeCsv).join(','));
        csvRows.push([`조회 클럽: ${clubId}`, `집계 기간: ${periodLabel}`, `추출 일자: ${dateStr}`, `집계 대상: 정회원 (${regularPlayers.length}명)`].map(escapeCsv).join(','));
        csvRows.push('');

        // [섹션 1] 정회원 개인별 상세 전적
        csvRows.push([`■ 1. 정회원 개인별 전적 통계 (다승 및 승률 순)`].map(escapeCsv).join(','));
        csvRows.push([
            '순위', '이름', '급수', '성별', '연령대',
            '총 출전수', '승', '패', '승률(%)',
            '총 득점', '총 실점', '득실차',
            '접전승(2점차)', '대승(10점차)', '최다연승',
            '남복 전적', '여복 전적', '혼복 전적'
        ].map(escapeCsv).join(','));

        regularPlayers.forEach((p, idx) => {
            const pointDiff = (p.pointsFor || 0) - (p.pointsAgainst || 0);
            const ageStr = p.ageGroup && p.ageGroup !== '-' ? `${p.ageGroup}대` : '-';
            csvRows.push([
                idx + 1,
                p.name,
                p.grade,
                p.gender,
                ageStr,
                p.games || 0,
                p.wins || 0,
                p.losses || 0,
                `${p.winRate || 0}%`,
                p.pointsFor || 0,
                p.pointsAgainst || 0,
                pointDiff > 0 ? `+${pointDiff}` : pointDiff,
                p.clutchWins || 0,
                p.bigWins || 0,
                p.maxStreak || 0,
                formatTypeStat(p.byType, '남복'),
                formatTypeStat(p.byType, '여복'),
                formatTypeStat(p.byType, '혼복')
            ].map(escapeCsv).join(','));
        });

        csvRows.push('');
        csvRows.push('');

        // [섹션 2] 정회원 복식 파트너 조합별 전적 (대진표 파트너 매칭 참고용)
        csvRows.push([`■ 2. 정회원 복식 파트너(페어) 조합별 전적 (합작 다승 및 승률 순)`].map(escapeCsv).join(','));
        csvRows.push([
            '순위', '파트너 조합', '선수1(급수)', '선수2(급수)',
            '합작 출전수', '합작 승', '합작 패', '합작 승률(%)', '합작 득실차'
        ].map(escapeCsv).join(','));

        regularPairs.forEach((pr, idx) => {
            const p1 = pr.player1 || (pr.players && pr.players[0]) || '';
            const p2 = pr.player2 || (pr.players && pr.players[1]) || '';
            const g1 = (memberMap[p1] && memberMap[p1].grade) || pr.p1Grade || '';
            const g2 = (memberMap[p2] && memberMap[p2].grade) || pr.p2Grade || '';
            const p1Text = g1 ? `${p1}(${g1})` : p1;
            const p2Text = g2 ? `${p2}(${g2})` : p2;
            const losses = typeof pr.losses === 'number' ? pr.losses : Math.max(0, (pr.games || 0) - (pr.wins || 0));
            const diff = (pr.pointsFor || 0) - (pr.pointsAgainst || 0);

            csvRows.push([
                idx + 1,
                `${p1Text} & ${p2Text}`,
                p1Text,
                p2Text,
                pr.games || 0,
                pr.wins || 0,
                losses,
                `${pr.winRate || 0}%`,
                diff > 0 ? `+${diff}` : diff
            ].map(escapeCsv).join(','));
        });

        // 엑셀 한글 깨짐 방지를 위한 UTF-8 BOM(\uFEFF) 추가
        const csvContent = '\uFEFF' + csvRows.join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `오늘민턴_정회원전적통계_${periodLabel}_${dateStr}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });
};