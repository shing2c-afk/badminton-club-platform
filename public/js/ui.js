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

    // 회원 공개용 플로팅 랭킹 버튼 자동 부착 (TV 화면 제외)
    window.addEventListener('DOMContentLoaded', () => {
        if (window.location.pathname.includes('tv')) return;
        if (document.getElementById('floating-ranking-btn')) return;
        const floatBtn = document.createElement('button');
        floatBtn.id = 'floating-ranking-btn';
        floatBtn.innerHTML = '🏆 랭킹보드';
        floatBtn.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9990; padding:10px 16px; border-radius:30px; background:linear-gradient(135deg, #f59e0b, #d97706); color:#fff; font-weight:800; font-size:13px; border:2px solid #fef08a; box-shadow:0 4px 15px rgba(245,158,11,0.5); cursor:pointer;';
        floatBtn.onclick = () => window.openStatsDashboard(false);
        document.body.appendChild(floatBtn);
    });
})();

window.currentStatsAdminMode = false;

// 2) 대시보드 모달 열기 (isAdmin이 true이면 타이틀 생성/삭제 노출, false이면 회원 공개용)
window.openStatsDashboard = function(isAdmin = false) {
    window.currentStatsAdminMode = !!isAdmin;
    const existing = document.getElementById('stats-dashboard-modal');
    if (existing) existing.remove();

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentYM = `${curYear}-${curMonth}`;

    const modalHtml = `
        <div id="stats-dashboard-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); display:flex; justify-content:center; align-items:flex-start; overflow-y:auto; z-index:99999; padding:20px 10px; box-sizing:border-box;">
            <div style="background:#0f172a; color:#f8fafc; width:100%; max-width:900px; border-radius:16px; border:1px solid #334155; padding:20px; box-shadow:0 15px 40px rgba(0,0,0,0.7); margin-bottom:40px;">
                
                <!-- 상단 헤더 -->
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:14px; margin-bottom:16px;">
                    <div>
                        <h2 style="margin:0; font-size:20px; color:#fbbf24; display:flex; align-items:center; gap:8px;">
                            🏆 ${isAdmin ? '클럽 전적 통계 & 타이틀 관리 (관리자)' : '명예의 전당 & 실시간 랭킹 보드'}
                        </h2>
                        <p style="margin:4px 0 0 0; font-size:12px; color:#94a3b8;">게임 종료 시 기록된 스코어를 바탕으로 실시간 집계됩니다.</p>
                    </div>
                    <button onclick="document.getElementById('stats-dashboard-modal').remove()" style="background:#334155; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-weight:bold; cursor:pointer;">✕ 닫기</button>
                </div>

                <!-- 기간 선택 필터 바 -->
                <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:#1e293b; padding:12px; border-radius:10px; margin-bottom:18px;">
                    <span style="font-size:13px; font-weight:bold; color:#cbd5e1;">📅 조회 기간:</span>
                    <select id="stats-period-select" onchange="window.loadStatsData()" style="padding:8px 12px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; font-size:13px; font-weight:bold;">
                        <option value="month">이번 달 (${curMonth}월)</option>
                        <option value="quarter">이번 분기</option>
                        <option value="all">전체 누적</option>
                        <option value="${currentYM}">직접 월 선택 (${currentYM})</option>
                    </select>
                    <input type="month" id="stats-custom-month" value="${currentYM}" onchange="document.getElementById('stats-period-select').value=this.value; window.loadStatsData();" style="padding:7px 10px; background:#0f172a; color:#38bdf8; border:1px solid #475569; border-radius:6px; font-size:13px;">
                    
                    <span style="font-size:12px; color:#94a3b8; margin-left:auto;">승률왕 최소 경기수:</span>
                    <input type="number" id="stats-min-games" value="5" min="1" max="50" onchange="window.loadStatsData()" style="width:55px; padding:6px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; text-align:center;">
                    <button onclick="window.loadStatsData()" style="padding:8px 14px; background:#0284c7; color:#fff; border:none; border-radius:6px; font-size:13px; font-weight:bold; cursor:pointer;">🔄 새로고침</button>
                </div>

                <!-- [관리자 전용] 새 커스텀 반짝이 타이틀 생성기 -->
                ${isAdmin ? `
                <div style="background:#1e293b; border:1px solid #fbbf24; border-radius:12px; padding:14px; margin-bottom:20px;">
                    <div style="font-size:14px; font-weight:bold; color:#fbbf24; margin-bottom:10px;">✨ 새 반짝이 이벤트 타이틀 만들기 (월별/분기별 특별 어워드)</div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px; margin-bottom:10px;">
                        <input type="text" id="new-title-name" placeholder="예: 11월 불꽃 스매싱왕" style="padding:8px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; font-size:13px;">
                        <select id="new-title-metric" style="padding:8px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; font-size:13px;">
                            <option value="most_wins">🏆 최다 승 (다승)</option>
                            <option value="win_rate">🎯 최고 승률 (%)</option>
                            <option value="most_games">🔥 최다 출전 (철인)</option>
                            <option value="clutch_wins">⚡ 접전 승부사 (2점차 승리)</option>
                            <option value="max_streak">🚀 최다 연승 기록</option>
                            <option value="point_diff">📈 최고 득실차</option>
                            <option value="most_losses">😭 최다 패 (패가망신)</option>
                        </select>
                        <select id="new-title-matchtype" style="padding:8px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; font-size:13px;">
                            <option value="ALL">전 종목 통합</option>
                            <option value="남복">남성복식 한정</option>
                            <option value="여복">여성복식 한정</option>
                            <option value="혼복">혼성복식 한정</option>
                            <option value="자유복식">자유복식 한정</option>
                        </select>
                        <select id="new-title-theme" style="padding:8px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; font-size:13px;">
                            <option value="gold">🌟 골드 네온 (황금빛)</option>
                            <option value="fire">🔥 플레임 오라 (불꽃)</option>
                            <option value="prism">💎 다이아 프리즘 (홀로그램)</option>
                            <option value="fun">😂 유머/위로 테마 (보라빛)</option>
                        </select>
                        <input type="number" id="new-title-mingames" value="3" min="1" placeholder="최소 경기수" title="최소 경기수 기준" style="padding:8px; background:#0f172a; color:#fff; border:1px solid #475569; border-radius:6px; font-size:13px;">
                    </div>
                    <button onclick="window.createNewCustomTitle()" style="width:100%; padding:10px; background:linear-gradient(135deg, #f59e0b, #d97706); color:#fff; border:none; border-radius:8px; font-weight:bold; font-size:13px; cursor:pointer;">
                        ➕ 반짝이는 타이틀 생성 및 랭킹보드에 즉시 등록
                    </button>
                </div>
                ` : ''}

                <!-- 1. 반짝이는 타이틀 배지 보드 (기본 5대 + 커스텀 타이틀) -->
                <h3 style="font-size:15px; color:#38bdf8; margin:0 0 10px 0;">🌟 이달의 타이틀 홀더 (실시간 1위)</h3>
                <div id="stats-titles-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:12px; margin-bottom:24px;">
                    <div style="color:#94a3b8; font-size:13px;">데이터를 불러오는 중...</div>
                </div>

                <!-- 2. 개인별 전적 순위표 & 환상의 짝꿍 -->
                <div style="display:grid; grid-template-columns:1fr; gap:20px;">
                    <div>
                        <h3 style="font-size:15px; color:#38bdf8; margin:0 0 10px 0;">📊 회원별 종합 전적 순위표</h3>
                        <div style="overflow-x:auto; background:#1e293b; border-radius:10px; border:1px solid #334155;">
                            <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:center;">
                                <thead>
                                    <tr style="background:#0f172a; color:#94a3b8; border-bottom:1px solid #334155;">
                                        <th style="padding:10px 6px;">순위</th>
                                        <th style="padding:10px 6px;">회원명</th>
                                        <th style="padding:10px 6px;">출전</th>
                                        <th style="padding:10px 6px; color:#38bdf8;">승</th>
                                        <th style="padding:10px 6px; color:#f43f5e;">패</th>
                                        <th style="padding:10px 6px; color:#fbbf24;">승률</th>
                                        <th style="padding:10px 6px;">득실차</th>
                                        <th style="padding:10px 6px;">최다연승</th>
                                    </tr>
                                </thead>
                                <tbody id="stats-players-tbody">
                                    <tr><td colspan="8" style="padding:20px; color:#94a3b8;">집계 중...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 3. 환상의 짝꿍 (복식 파트너 TOP 10) -->
                    <div>
                        <h3 style="font-size:15px; color:#34d399; margin:0 0 10px 0;">🤝 환상의 짝꿍 (복식 파트너 다승 TOP 10)</h3>
                        <div id="stats-pairs-list" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:8px;"></div>
                    </div>
                </div>

            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    window.loadStatsData();
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