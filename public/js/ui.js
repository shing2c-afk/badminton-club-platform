let CONFIG = { ENTRY_TIMEOUT_SEC: 180, NANTA_COURT_LIMIT_SEC: 900, ENABLE_ALERT: true };
let courtsData = [];
let gameQueue = [];
let nantaQueue = [];
let notificationsList = [];

let currentUser = null;

let activeMergeSlotId = null;

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

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
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
            .filter(p => p && p.length > 0)
            .map(p => {
                let normalizedStr = p;
                if (p.includes('/')) {
                    normalizedStr = p.split('/').map(part => part.trim()).join(' / ');
                }
                return `<div>${escapeHtml(normalizedStr)}</div>`;
            })
            .join('');
    }

    courtsData.forEach(court => {
        let html = '';
        if(court.type === 'game') {
            if(court.isEmpty) {
                html = `
                    <div class="court-row">
                        <div class="court-head-info">
                            <span class="court-num">${court.id}번 코트</span>
                            <span class="type-badge badge-game">게임 코트</span>
                        </div>
                        <div class="empty-court-box">✨ 빈 코트</div>
                    </div>`;
            } else {
                let isUserOnThisCourt = false;
                if (court.players) {
                    if (Array.isArray(court.players)) {
                        isUserOnThisCourt = court.players.some(p => p && currentUserName && p.includes(currentUserName));
                    } else if (typeof court.players === 'string') {
                        isUserOnThisCourt = currentUserName && court.players.includes(currentUserName);
                    }
                }

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
        else if(court.type === 'nanta') {
            let isUserOnSideA = false;
            if (court.sideA && court.sideA.players) {
                if (Array.isArray(court.sideA.players)) {
                    isUserOnSideA = court.sideA.players.some(p => p && currentUserName && p.includes(currentUserName));
                } else if (typeof court.sideA.players === 'string') {
                    isUserOnSideA = currentUserName && court.sideA.players.includes(currentUserName);
                }
            }

            let isUserOnSideB = false;
            if (court.sideB && court.sideB.players) {
                if (Array.isArray(court.sideB.players)) {
                    isUserOnSideB = court.sideB.players.some(p => p && currentUserName && p.includes(currentUserName));
                } else if (typeof court.sideB.players === 'string') {
                    isUserOnSideB = currentUserName && court.sideB.players.includes(currentUserName);
                }
            }

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
                    <span class="nanta-timer-badge">⏱️ ${formatTime(court.sideA ? court.sideA.remainingSeconds : 0)}</span>
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
        else if(court.type === 'lesson') {
            html = `
                <div class="court-row">
                    <div class="court-head-info">
                        <span class="court-num">${court.id}번 코트</span>
                        <span class="type-badge badge-lesson">레슨 코트</span>
                    </div>
                    <div style="background:#1f2937; padding:10px; border-radius:6px; text-align:center; color:#c084fc; font-size:12px;">
                        ${escapeHtml(court.players || '코치 레슨 전용 코트')}
                    </div>
                </div>`;
        }
        courtList.insertAdjacentHTML('beforeend', html);
    });
}

function renderGameQueue() {
    const container = document.getElementById('game-slot-list');
    if (!container) return;

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    let cleanName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
            cleanName = currentUserName.replace(/님$/, '').trim();
        } catch (e) {}
    }

    function formatPlayerText(playerStr) {
        if (!playerStr) return '';
        if (playerStr.includes('/')) {
            return playerStr.split('/').map(part => part.trim()).join(' / ');
        }
        return playerStr;
    }

    // 이름 식별 함수 ('관리자' / '관리자님' 및 구장별 세션 완벽 대응)
function isMePlayer(p) {
    if (!p) return false;

    // 🔑 현재 구장 키 식별
    const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                   || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                   || new URLSearchParams(window.location.search).get('club') 
                   || 'default';

    const storageKey = (typeof getClubStorageKey === 'function') 
                       ? getClubStorageKey("currentUser") 
                       : `currentUser_${clubId}`;

    const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");

    let myCleanName = (typeof cleanName !== 'undefined' && cleanName) ? cleanName : "";
    let myUserName = (typeof currentUserName !== 'undefined' && currentUserName) ? currentUserName : "";

    // cleanName이 비어있다면 구장별 스토리지에서 직접 이름 추출
    if (!myCleanName && savedUser) {
        try {
            const u = JSON.parse(savedUser);
            const raw = (u.name || u.username || "").trim();
            myCleanName = raw.replace(/님$/, '').trim();
            myUserName = raw;
        } catch (e) {}
    }

    if (!myCleanName && !myUserName) return false;

    const str = typeof p === 'object' ? JSON.stringify(p) : String(p);
    return (myCleanName && str.includes(myCleanName)) || (myUserName && str.includes(myUserName));
}

    // 1. 코트 현황 확인 (내가 현재 게임 코트 경기 중인지 체크)
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);
    const isPlayingGame = activeCourts.some(c => {
        if (!c || c.type !== 'game') return false;
        const courtStr = JSON.stringify(c);
        return cleanName && (courtStr.includes(cleanName) || courtStr.includes(currentUserName));
    });

    // 2. 대기열 확인 (내가 이미 게임 대기열 어느 방이든 들어가 있는지)
    const amIInGameQueue = gameQueue.some(slot => 
        slot.players && slot.players.some(p => isMePlayer(p))
    );

    // 🚨 게임참여 버튼 비활성화 조건: 이미 게임 대기열에 있거나 게임 코트 경기 중일 때
    // (※ 난타 코트에서 몸을 풀고 있는 회원은 게임에 참여할 수 있도록 열어둠!)
    const cannotJoinGame = amIInGameQueue || isPlayingGame;

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
                // [퇴장 버튼]: 본인 칸만 활성화
                if (isMe) {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedPlayer)}</span><button class="btn-exit" onclick="exitGamePlayer('${slot.id}', ${i})">퇴장</button></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedPlayer)}</span><button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button></div>`;
                }
            } else {
                // [게임참여 버튼]: 경기 중이거나 이미 대기 중인 경우 비활성화
                if (cannotJoinGame) {
                    playerCellsHtml += `<div class="player-cell" style="background:#2a2a2a; cursor:not-allowed;"><span class="empty-cell" style="color:#777;">게임참여</span></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell" onclick="joinGameCell('${slot.id}', ${i})" style="cursor:pointer;"><span class="empty-cell">게임참여</span></div>`;
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
                    const rawPlayersList = getValidPlayers(targetSlot.players).map(p => formatPlayerText(p));
                    const playersStr = rawPlayersList.join(", ");
                    listHtml += `
                        <div class="merge-option-item" onclick="confirmAndExecuteMerge('${slot.id}', '${targetSlot.id}', ${targetRank})" style="padding: 10px 12px; margin-bottom: 6px; background: #1e1e2f; border: 1px solid #7c3aed; border-radius: 6px; cursor: pointer;">
                            <div style="font-weight: bold; color: #a78bfa; font-size: 13px;">📌 ${targetRank}순위 방과 통합</div>
                            <div style="color: #cbd5e1; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">멤버: ${escapeHtml(playersStr)}</div>
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
}

function mergeGameSlot(slotId) {
    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    let cleanName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
            cleanName = currentUserName.replace(/님$/, '').trim();
        } catch (e) {}
    }

    // 이름 식별 함수 ('관리자' / '관리자님' 및 구장별 세션 완벽 대응)
    function isMePlayer(p) {
        if (!p) return false;

        // 🔑 현재 구장 키 식별
        const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                       || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                       || new URLSearchParams(window.location.search).get('club') 
                       || 'default';

        const storageKey = (typeof getClubStorageKey === 'function') 
                           ? getClubStorageKey("currentUser") 
                           : `currentUser_${clubId}`;

        const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");

        let myCleanName = (typeof cleanName !== 'undefined' && cleanName) ? cleanName : "";
        let myUserName = (typeof currentUserName !== 'undefined' && currentUserName) ? currentUserName : "";

        // cleanName이 비어있다면 구장별 스토리지에서 직접 이름 추출
        if (!myCleanName && savedUser) {
            try {
                const u = JSON.parse(savedUser);
                const raw = (u.name || u.username || "").trim();
                myCleanName = raw.replace(/님$/, '').trim();
                myUserName = raw;
            } catch (e) {}
        }

        if (!myCleanName && !myUserName) return false;

        const str = typeof p === 'object' ? JSON.stringify(p) : String(p);
        return (myCleanName && str.includes(myCleanName)) || (myUserName && str.includes(myUserName));
    }

    const currentSlot = gameQueue.find(s => s.id === slotId);
    if (!currentSlot) return;

    const currentValidPlayers = getValidPlayers(currentSlot.players);
    const isMySlot = currentSlot.players.some(p => isMePlayer(p));
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

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    let cleanName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
            cleanName = currentUserName.replace(/님$/, '').trim();
        } catch (e) {}
    }

    function formatNantaPlayerText(playerStr) {
        if (!playerStr) return '';
        if (playerStr.includes('/')) {
            return playerStr.split('/').map(part => part.trim()).join(' / ');
        }
        return playerStr;
    }

    // 이름 식별 함수 ('관리자' / '관리자님' 및 구장별 세션 완벽 대응)
    function isMePlayer(p) {
        if (!p) return false;

        // 🔑 현재 구장 키 식별
        const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                       || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                       || new URLSearchParams(window.location.search).get('club') 
                       || 'default';

        const storageKey = (typeof getClubStorageKey === 'function') 
                           ? getClubStorageKey("currentUser") 
                           : `currentUser_${clubId}`;

        const savedUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");

        let myCleanName = (typeof cleanName !== 'undefined' && cleanName) ? cleanName : "";
        let myUserName = (typeof currentUserName !== 'undefined' && currentUserName) ? currentUserName : "";

        // cleanName이 비어있다면 구장별 스토리지에서 직접 이름 추출
        if (!myCleanName && savedUser) {
            try {
                const u = JSON.parse(savedUser);
                const raw = (u.name || u.username || "").trim();
                myCleanName = raw.replace(/님$/, '').trim();
                myUserName = raw;
            } catch (e) {}
        }

        if (!myCleanName && !myUserName) return false;

        const str = typeof p === 'object' ? JSON.stringify(p) : String(p);
        return (myCleanName && str.includes(myCleanName)) || (myUserName && str.includes(myUserName));
    }

    // 1. 코트 현황 확인 (게임 코트나 난타 코트 중 하나라도 코트 이용 중인지 검사)
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);
    const isPlayingAnyCourt = activeCourts.some(c => {
        if (!c || (c.type !== 'game' && c.type !== 'nanta')) return false;
        const courtStr = JSON.stringify(c);
        return cleanName && (courtStr.includes(cleanName) || courtStr.includes(currentUserName));
    });

    // 2. 난타 대기열 확인
    const amIInNantaQueue = nantaQueue.some(slot => 
        slot.players && slot.players.some(p => isMePlayer(p))
    );

    // 🚨 난타참여 비활성화 조건: 이미 난타 대기열에 있거나, 어떤 코트든 경기/플레이 중일 때
    const cannotJoinNanta = amIInNantaQueue || isPlayingAnyCourt;

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
                const formattedNantaPlayer = formatNantaPlayerText(p);
                // [퇴장 버튼]: 본인 칸만 활성화
                if (isMe) {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedNantaPlayer)}</span><button class="btn-exit" onclick="exitNantaPlayer('${slot.id}', ${i})">퇴장</button></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell"><span class="player-info">${escapeHtml(formattedNantaPlayer)}</span><button class="btn-exit" disabled style="background:#444; color:#888; opacity:0.6; cursor:not-allowed;">퇴장</button></div>`;
                }
            } else {
                // [난타참여 버튼]: 코트 이용 중이거나 이미 대기 중인 경우 비활성화
                if (cannotJoinNanta) {
                    playerCellsHtml += `<div class="player-cell" style="background:#2a2a2a; cursor:not-allowed;"><span class="empty-cell" style="color:#777;">난타참여</span></div>`;
                } else {
                    playerCellsHtml += `<div class="player-cell" onclick="joinNantaCell('${slot.id}', ${i})" style="cursor:pointer;"><span class="empty-cell">난타참여</span></div>`;
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

    const rawName = (u.name || u.username || "").trim();
    const cleanName = rawName.replace(/님$/, '').trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!cleanName) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    const parts = [cleanName, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join(" / ");

    // 1. 코트 현황 검사
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);
    
    // 게임 코트에서 실제 경기 중인지 검사
    const isPlayingGame = activeCourts.some(c => {
        if (!c || c.type !== 'game') return false;
        const courtStr = JSON.stringify(c);
        return courtStr.includes(cleanName) || courtStr.includes(rawName);
    });

    if (isPlayingGame) {
        alert(`⚠️ ${cleanName} 님은 현재 게임 코트에서 경기 중이므로 새로운 게임방을 개설할 수 없습니다.`);
        return;
    }

    // 2. 게임 대기열 확인
    const activeGameQueue = (typeof gameQueue !== 'undefined' && gameQueue) ? gameQueue : (window.gameQueue || []);
    const isWaitingGame = activeGameQueue.some(slot => {
        if (!slot) return false;
        const slotStr = JSON.stringify(slot);
        return slotStr.includes(cleanName) || slotStr.includes(rawName);
    });

    if (isWaitingGame) {
        alert(`⚠️ ${cleanName} 님은 이미 게임에 참여(대기) 중이므로 새로운 게임방을 개설할 수 없습니다.`);
        return;
    }

    // 3. 난타 대기열 확인 (교차 선택창 1회)
    const activeNantaQueue = (typeof nantaQueue !== 'undefined' && nantaQueue) ? nantaQueue : (window.nantaQueue || []);
    const isWaitingNanta = activeNantaQueue.some(slot => {
        if (!slot) return false;
        const slotStr = JSON.stringify(slot);
        return slotStr.includes(cleanName) || slotStr.includes(rawName);
    });

    if (isWaitingNanta) {
        const confirmSwitch = await confirm(`현재 난타 대기 상태입니다. 게임 방을 개설하시면 기존 난타 대기 상태에 영향을 줄 수 있습니다. 진행하시겠습니까?`);
        if (!confirmSwitch) return;

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('forceCreateSlot', { type: 'game', userId: u.id || u.userId, user: formattedPlayerInfo });
        }
        return;
    }

    // 체육관 Wi-Fi 검사 (관리자 설정 ON 여부 + 실제 구장 Wi-Fi 접속 여부 함께 판별)
    const isRestrictionActive = (localStorage.getItem("useWifiRestriction") === "true") || (window.useWifiRestriction === true);

    if (isRestrictionActive && (!window.isGymWifiConnected || window.isGymWifiConnected === false)) {
        const modal = document.getElementById('custom-alert-modal');
        const msgEl = document.getElementById('custom-alert-message');
        const confirmBtn = document.getElementById('custom-alert-ok-btn');

        if (modal && msgEl) {
            msgEl.innerText = '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.';
            modal.style.display = 'flex';

            if (confirmBtn) {
                confirmBtn.onclick = function() {
                    modal.style.display = 'none';
                };
            }
        } else {
            alert('⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.');
        }
        return;
    }

    // 정상 게임방 개설 요청
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'game', userId: u.id || u.userId, user: formattedPlayerInfo });
}


// ==========================================
// 2. 난타방 개설 (문구 통일 및 완벽 방어)
// ==========================================
async function createNewNantaSlot() {
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

    const rawName = (u.name || u.username || "").trim();
    const cleanName = rawName.replace(/님$/, '').trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!cleanName) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    const parts = [cleanName, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join(" / ");

    // 1. 코트 현황 검사
    const activeCourts = (typeof courtsData !== 'undefined' && courtsData) ? courtsData : (window.courtsData || []);

    // A. 난타 코트 플레이 중인지 검사
    const isPlayingNanta = activeCourts.some(c => {
        if (!c || c.type !== 'nanta') return false;
        const courtStr = JSON.stringify(c);
        return courtStr.includes(cleanName) || courtStr.includes(rawName);
    });

    if (isPlayingNanta) {
        alert(`⚠️ ${cleanName} 님은 현재 난타 코트에서 플레이 중이므로 새로운 난타방을 개설할 수 없습니다.`);
        return;
    }

    // B. 게임 코트 경기 중인지 검사
    const isPlayingGame = activeCourts.some(c => {
        if (!c || c.type !== 'game') return false;
        const courtStr = JSON.stringify(c);
        return courtStr.includes(cleanName) || courtStr.includes(rawName);
    });

    if (isPlayingGame) {
        alert(`⚠️ ${cleanName} 님은 현재 게임 코트에서 경기 중이므로 새로운 난타방을 개설할 수 없습니다.`);
        return;
    }

    // 2. 난타 대기열 확인
    const activeNantaQueue = (typeof nantaQueue !== 'undefined' && nantaQueue) ? nantaQueue : (window.nantaQueue || []);
    const isWaitingNanta = activeNantaQueue.some(slot => {
        if (!slot) return false;
        const slotStr = JSON.stringify(slot);
        return slotStr.includes(cleanName) || slotStr.includes(rawName);
    });

    if (isWaitingNanta) {
        alert(`⚠️ ${cleanName} 님은 이미 난타에 참여(대기) 중이므로 새로운 난타방을 개설할 수 없습니다.`);
        return;
    }

    // 3. 게임 대기열 확인 (교차 확인창 1회)
    const activeGameQueue = (typeof gameQueue !== 'undefined' && gameQueue) ? gameQueue : (window.gameQueue || []);
    const isWaitingGame = activeGameQueue.some(slot => {
        if (!slot) return false;
        const slotStr = JSON.stringify(slot);
        return slotStr.includes(cleanName) || slotStr.includes(rawName);
    });

    if (isWaitingGame) {
        const confirmSwitch = await confirm(`현재 게임 대기 상태입니다. 난타 방을 개설하시면 기존 게임 대기 상태에 영향을 줄 수 있습니다. 진행하시겠습니까?`);
        if (!confirmSwitch) return;

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('forceCreateSlot', { type: 'nanta', userId: u.id || u.userId, user: formattedPlayerInfo });
        }
        return;
    }

    // 체육관 Wi-Fi 검사 (관리자 설정 ON 여부 + 실제 구장 Wi-Fi 접속 여부 함께 판별)
    const isRestrictionActive = (localStorage.getItem("useWifiRestriction") === "true") || (window.useWifiRestriction === true);

    if (isRestrictionActive && (!window.isGymWifiConnected || window.isGymWifiConnected === false)) {
        const modal = document.getElementById('custom-alert-modal');
        const msgEl = document.getElementById('custom-alert-message');
        const confirmBtn = document.getElementById('custom-alert-ok-btn');

        if (modal && msgEl) {
            msgEl.innerText = '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.';
            modal.style.display = 'flex';

            if (confirmBtn) {
                confirmBtn.onclick = function() {
                    modal.style.display = 'none';
                };
            }
        } else {
            alert('⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.');
        }
        return;
    }

    // 정상 난타방 개설 요청
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'nanta', userId: u.id || u.userId, user: formattedPlayerInfo });
}

async function joinGameCell(slotId, idx) {
    // 📶 구장 Wi-Fi 접속 여부 체크 (커스텀 모달 적용)
    if (!window.isGymWifiConnected) {
        const modal = document.getElementById('custom-alert-modal');
        const msgEl = document.getElementById('custom-alert-message');
        const confirmBtn = document.getElementById('custom-alert-ok-btn');

        if (modal && msgEl) {
            msgEl.innerText = '⚠️ 체육관 공용 Wi-Fi에 연결되어야 참여가 가능합니다. Wi-Fi 연결 상태를 확인해 주세요.';
            modal.style.display = 'flex';

            if (confirmBtn) {
                confirmBtn.onclick = function() {
                    modal.style.display = 'none';
                };
            }
        }
        return;
    }

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

    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    const parts = [name, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join("/");

    const confirmed = await confirm(`[${formattedPlayerInfo}]로 게임에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'game', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

async function joinNantaCell(slotId, idx) {
    // 📶 구장 Wi-Fi 접속 여부 체크 (커스텀 모달 적용)
    if (!window.isGymWifiConnected) {
        const modal = document.getElementById('custom-alert-modal');
        const msgEl = document.getElementById('custom-alert-message');
        const confirmBtn = document.getElementById('custom-alert-ok-btn');

        if (modal && msgEl) {
            msgEl.innerText = '⚠️ 체육관 공용 Wi-Fi에 연결되어야 참여가 가능합니다. Wi-Fi 연결 상태를 확인해 주세요.';
            modal.style.display = 'flex';

            if (confirmBtn) {
                confirmBtn.onclick = function() {
                    modal.style.display = 'none';
                };
            }
        }
        return;
    }

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

    const name = (u.name || u.username || "").trim();
    const gender = (u.gender || "").trim();
    const age = (u.age || u.ageGroup || "").trim();
    const level = (u.level || u.grade || "").trim();

    if (!name) {
        alert("회원 이름 정보를 찾을 수 없습니다.");
        return;
    }

    const parts = [name, gender, age, level].filter(Boolean);
    const formattedPlayerInfo = parts.join("/");

    const confirmed = await confirm(`[${formattedPlayerInfo}]로 난타에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'nanta', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

// 📶 구장 Wi-Fi 접속 여부에 따라 개설 버튼 스타일 조정
function updateWifiRestrictedButtons() {
    // 실제 버튼 요소 찾기 (ID가 다를 경우 class나 셀렉터로 대체)
    const btnCreateGame = document.getElementById('btn-create-game') || document.querySelector('.btn-create-game');
    const btnCreateNanta = document.getElementById('btn-create-nanta') || document.querySelector('.btn-create-nanta');

    [btnCreateGame, btnCreateNanta].forEach(btn => {
        if (!btn) return;
        if (!window.isGymWifiConnected) {
            btn.style.opacity = '0.5';
            btn.title = '⚠️ 체육관 공용 Wi-Fi 연결 시 이용 가능';
        } else {
            btn.style.opacity = '1.0';
            btn.title = '';
        }
    });
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

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    const isMySlot = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));
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

    const savedUser = localStorage.getItem("currentUser");
    let currentUserName = "";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            currentUserName = (u.name || u.username || "").trim();
        } catch (e) {}
    }

    const isMySlot = slot.players && slot.players.some(p => p && currentUserName && p.includes(currentUserName));
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

    // 🎯 1. 고유 ID로 찾거나, 화면에서 '로그인 중' 글자를 가진 요소를 직접 자동 추적
    let headerUserEl = document.getElementById("user-display-name") 
                    || document.getElementById("user-name")
                    || document.getElementById("userName")
                    || document.getElementById("userDisplay");

    if (!headerUserEl) {
        // ID가 일치하지 않을 때 화면 상단의 '로그인 중' 텍스트 요소를 직접 검색
        const candidates = Array.from(document.querySelectorAll('header span, nav span, .header span, span, div, a, b'));
        headerUserEl = candidates.find(el => el.children.length === 0 && el.textContent.includes('로그인 중'));
    }
    
    if (!headerUserEl) return;

    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            const rawName = user.name || user.username || user.nickname || (typeof user === 'string' ? user : '사용자');
            const cleanName = String(rawName).replace(/님$/, '').trim();
            
            // 🏷️ 회원 이름 반영
            headerUserEl.textContent = `${cleanName}님`;
            
            const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
            if (activeSocket && (user.username || user.phone)) {
                activeSocket.emit('registerUserSession', user.username || user.phone);
            }
        } catch (e) {
            console.error("사용자 정보 파싱 오류:", e);
            headerUserEl.textContent = "로그인 필요";
        }
    } else {
        headerUserEl.textContent = "로그인 필요";
    }
}

// 🚀 화면 로딩 시점에 자동으로 즉시 실행되도록 보장
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyUserProfile);
} else {
    applyUserProfile();
}
window.addEventListener('load', applyUserProfile);

async function handleLogout() {
    const confirmed = await confirm("로그아웃 하시겠습니까?");
    if (confirmed) {
        // 🔑 1. 현재 접속 구장 및 스토리지 키 식별
        const clubId = (typeof currentClubId !== 'undefined' && currentClubId) 
                       || (typeof window.currentClubId !== 'undefined' && window.currentClubId)
                       || new URLSearchParams(window.location.search).get('club') 
                       || 'default';

        const storageKey = (typeof getClubStorageKey === 'function') 
                           ? getClubStorageKey("currentUser") 
                           : `currentUser_${clubId}`;

        // 🔍 구장 전용 키(또는 기존 레거시 키)에서 로그인 정보 조회
        const rawUser = localStorage.getItem(storageKey) || localStorage.getItem("currentUser");

        if (rawUser) {
            try {
                let userData = rawUser;
                try {
                    const parsed = JSON.parse(rawUser);
                    if (parsed) userData = parsed;
                } catch (e) {}

                await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user: userData, clubId: clubId })
                });
            } catch (err) {
                console.error("❌ 로그아웃 서버 통신 에러:", err);
            }
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.disconnect();
        }

        // 💾 2. 구장 전용 키와 기존 키 모두 깨끗하게 삭제
        localStorage.removeItem(storageKey);
        localStorage.removeItem("currentUser");
        localStorage.removeItem("username");
        sessionStorage.clear();
        location.reload(); 
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
// 📶 Wi-Fi 미인증 시 방 개설 버튼 시각적 비활성화 (흐릿하게 처리)
// 📶 Wi-Fi 상태에 따른 버튼 및 참여 텍스트 색상 실시간 일괄 제어
function updateWifiRestrictedButtons() {
    const isWifi = Boolean(window.isGymWifiConnected);
    const activeColor = '#22c55e'; // 밝은 녹색
    const inactiveColor = '#888888'; // 비활성 회색
    const targetColor = isWifi ? activeColor : inactiveColor;
    const targetCursor = isWifi ? 'pointer' : 'not-allowed';

    // 1. 상단 개설 버튼 (투명도/필터 제어)
    const gameBtn = document.querySelector('button[onclick*="createNewGameSlot"]');
    const nantaBtn = document.querySelector('button[onclick*="createNewNantaSlot"]');
    [gameBtn, nantaBtn].filter(Boolean).forEach(btn => {
        btn.style.opacity = isWifi ? '1.0' : '0.35';
        btn.style.filter = isWifi ? 'none' : 'grayscale(60%)';
        btn.style.cursor = targetCursor;
        if (!isWifi) {
            btn.title = '체육관 공용 Wi-Fi 연결 시 이용 가능합니다.';
        } else {
            btn.removeAttribute('title');
        }
    });

    // 2. 화면 내 모든 '게임참여' / '난타참여' 요소 및 셀 검색 후 색상 강제 적용
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
        // 자식 요소가 없고 순수 텍스트가 '게임참여' 또는 '난타참여'인 경우
        if (el.children.length === 0) {
            const txt = (el.textContent || '').trim();
            if (txt === '게임참여' || txt === '난타참여') {
                el.style.setProperty('color', targetColor, 'important');
                el.style.cursor = targetCursor;
            }
        }
        // onclick 속성에 joinGameCell 또는 joinNantaCell이 있는 셀 자체
        const onclickAttr = el.getAttribute('onclick') || '';
        if (onclickAttr.includes('joinGameCell') || onclickAttr.includes('joinNantaCell')) {
            el.style.setProperty('color', targetColor, 'important');
            el.style.cursor = targetCursor;
        }
    });
}