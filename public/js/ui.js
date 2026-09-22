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

function renderNotifications() {
    const notiCountEl = document.getElementById('noti-count');
    if (notiCountEl) notiCountEl.innerText = notificationsList.length;
    
    const container = document.getElementById('noti-list');
    if (!container) return;
    
    if (notificationsList.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:#6b7280; font-size:12px; padding:20px 0;">새로운 알림이 없습니다.</div>`;
        return;
    }

    container.innerHTML = '';
    notificationsList.forEach(n => {
        const html = `
            <div class="noti-item">
                <div>${escapeHtml(n.message)}</div>
                <div class="noti-time">${escapeHtml(n.time)}</div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
    });
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
    // 🛑 [추가] 시뮬레이션 모드 동작 중에는 서버 데이터로 코트를 덮어쓰지 않음!
    if (typeof isSimulationMode !== 'undefined' && isSimulationMode) {
        return;
    }
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

    // 🛑 [추가] 시뮬레이션 모드 동작 중에는 서버 데이터로 덮어쓰지 않음!
    if (typeof isSimulationMode !== 'undefined' && isSimulationMode) {
        return;
    }

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

    // 이름 식별 함수 ('관리자' / '관리자님' 모두 완벽 대응)
    function isMePlayer(p) {
        if (!p || !cleanName) return false;
        const str = typeof p === 'object' ? JSON.stringify(p) : String(p);
        return str.includes(cleanName) || str.includes(currentUserName);
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

    function isMePlayer(p) {
        if (!p || !cleanName) return false;
        const str = typeof p === 'object' ? JSON.stringify(p) : String(p);
        return str.includes(cleanName) || str.includes(currentUserName);
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

    // 🛑 [추가] 시뮬레이션 모드 동작 중에는 서버 데이터로 덮어쓰지 않음!
    if (typeof isSimulationMode !== 'undefined' && isSimulationMode) {
        return;
    }

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

    function isMePlayer(p) {
        if (!p || !cleanName) return false;
        const str = typeof p === 'object' ? JSON.stringify(p) : String(p);
        return str.includes(cleanName) || str.includes(currentUserName);
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

async function createNewGameSlot() {
    const savedUser = localStorage.getItem("currentUser");
    if (!savedUser) {
        alert("로그인 정보가 없습니다. 다시 로그인해 주세요.");
        return;
    }

    const user = JSON.parse(savedUser);
    const userInfo = `${user.name || ''} / ${user.gender || ''} / ${user.ageGroup || ''} / ${user.grade || ''}`;

    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }
// 💡 [수정] 시뮬레이션 모드가 아닐 때만 Wi-Fi 체크 진행
    if (!window.isGymWifiConnected && !isSimulationMode) {
        // 체육관 외부 접속 시 가상 봇 10명 체험 모달 실행
        if (typeof promptSimulationModal === 'function') {
            promptSimulationModal();
        } else {
            // 예외 대비 기존 알림 백업
            const modal = document.getElementById('custom-alert-modal');
            const msgEl = document.getElementById('custom-alert-message');
            const confirmBtn = document.getElementById('custom-alert-ok-btn');
            if (modal && msgEl) {
                msgEl.innerText = '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설할 수 있습니다.';
                modal.style.display = 'flex';
                if (confirmBtn) {
                    confirmBtn.onclick = function() { modal.style.display = 'none'; };
                }
            }
        }
        return;
    }

    // 💡 시뮬레이션 모드일 때는 서버로 보내지 않고 로컬 가상 처리 (다음 단계 연결용)
    if (isSimulationMode) {
        console.log('🧪 시뮬레이션 모드에서 방 생성 클릭됨');
        alert('체험 모드: 방 개설 기능이 가상으로 동작합니다.');
        return;
    }

    // 💡 직접 팝업을 띄우지 않고, 서버에 검증 및 처리를 요청함 (서버가 상황에 맞는 팝업 신호를 줌)
    activeSocket.emit('createSlot', { type: 'game', userId: user.id, user: userInfo });
}

// ==========================================
// 1. 게임방 개설 (문구 통일 및 방어 로직 완비)
// ==========================================
async function createNewGameSlot() {
    const savedUser = localStorage.getItem("currentUser");
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

    // 🚨 문구 통일: '경기 중이므로 새로운 게임방을 개설할 수 없습니다.'
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

   // 💡 [수정] 관리자가 설정을 켰고(ON), 시뮬레이션 모드가 아니며, 구장 Wi-Fi 인증이 안 된 경우
    if (isRestrictionActive && !isSimulationMode && (!window.isGymWifiConnected || window.isGymWifiConnected === false)) {
        // 체육관 외부 접속 시 가상 봇 10명 체험 모달 실행
        if (typeof promptSimulationModal === 'function') {
            promptSimulationModal();
        } else {
            const modal = document.getElementById('custom-alert-modal');
            const msgEl = document.getElementById('custom-alert-message');
            const confirmBtn = document.getElementById('custom-alert-ok-btn');

            if (modal && msgEl) {
                msgEl.innerText = '⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설하거나 참여할 수 있습니다.';
                modal.style.display = 'flex';

                if (confirmBtn) {
                    confirmBtn.onclick = function() {
                        modal.style.display = 'none';
                    };
                }
            } else {
                alert('⚠️ 체육관 공용 Wi-Fi에 연결된 상태에서만 방을 개설하거나 참여할 수 있습니다.');
            }
        }
        return;
    }

    // 💡 [추가] 시뮬레이션 모드일 때 서버 전송 차단 및 로컬 가상 동작 안내
    if (isSimulationMode) {
        console.log('🧪 시뮬레이션 모드: 로컬 가상 동작 실행');
        alert('체험 모드: 가상 봇들과 함께 로컬에서 동작합니다. (실제 서버에 전송되지 않음)');
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
    const savedUser = localStorage.getItem("currentUser");
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

    // 🚨 문구 통일: '경기 중이므로 새로운 난타방을 개설할 수 없습니다.'
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

    // 관리자가 설정을 켰고(ON), 구장 Wi-Fi 인증이 되지 않은 경우만 차단
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

    // 💡 [추가] 시뮬레이션 모드일 때 서버 전송 차단 및 로컬 가상 동작 안내
    if (isSimulationMode) {
        console.log('🧪 시뮬레이션 모드: 로컬 가상 동작 실행');
        alert('체험 모드: 가상 봇들과 함께 로컬에서 동작합니다. (실제 서버에 전송되지 않음)');
        return;
    }

    // 정상 게임방 개설 요청
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (!activeSocket) {
        alert("소켓 연결이 원활하지 않습니다. 페이지를 새로고침 해보세요.");
        return;
    }

    activeSocket.emit('createSlot', { type: 'nanta', userId: u.id || u.userId, user: formattedPlayerInfo });
}

async function joinGameCell(slotId, idx) {
    if (!window.isGymWifiConnected && !isSimulationMode) {
        if (typeof promptSimulationModal === 'function') {
            promptSimulationModal();
        }
        return;
    }

    const savedUser = localStorage.getItem("currentUser");
    let formattedPlayerInfo = "체험회원/남/30대/C";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            const name = (u.name || u.username || "").trim();
            const gender = (u.gender || "").trim();
            const age = (u.age || u.ageGroup || "").trim();
            const level = (u.level || u.grade || "").trim();
            if (name) {
                formattedPlayerInfo = [name, gender, age, level].filter(Boolean).join("/");
            }
        } catch (e) {}
    }

    // 🧪 [시뮬레이션 모드 전용 참여 로직]
    if (isSimulationMode) {
        console.log('🧪 시뮬레이션 모드: 가상 참여 직접 실행');

        // 1. 대기열 카드의 버튼을 내 이름으로 즉시 변경
        const simCard = document.querySelector('.sim-slot');
        if (simCard) {
            const joinBtn = simCard.querySelector('button');
            if (joinBtn) {
                const mySlot = document.createElement('div');
                mySlot.id = 'sim-my-slot';
                mySlot.style.cssText = "background: #2563eb; color: #fff; padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; font-weight: bold; border: 2px solid #60a5fa;";
                mySlot.textContent = formattedPlayerInfo;
                joinBtn.replaceWith(mySlot);
            }
            const statusText = simCard.querySelector('span:last-child');
            if (statusText) statusText.innerHTML = '<b style="color:#10b981;">매칭 완료! (4/4명)</b>';
        }

        // 2. 1.5초 후 코트 탭으로 강제 이동 및 경기 화면 생성
        setTimeout(() => {
            // 모든 탭 섹션 숨기고 코트 섹션 강제 표시
            const secGame = document.getElementById('section-game');
            const secNanta = document.getElementById('section-nanta');
            const secCourt = document.getElementById('section-court');

            if (secGame) secGame.style.display = 'none';
            if (secNanta) secNanta.style.display = 'none';
            if (secCourt) secCourt.style.display = 'block';

            // 상단 탭 버튼 활성화 스타일 동기화
            const tabs = document.querySelectorAll('.tab-menu button, .tab-menu div, .tab-btn');
            tabs.forEach(t => {
                if (t.innerText && t.innerText.includes('코트')) {
                    t.classList.add('active');
                } else {
                    t.classList.remove('active');
                }
            });

            // 코트 화면에 경기 카드 그리기
            showSimulatedCourtMatch(formattedPlayerInfo);
        }, 1200);

        return;
    }

    // 실제 서버 환경 참여 확인
    const confirmed = await confirm(`[${formattedPlayerInfo}]로 게임에 참여하시겠습니까?`);
    if (confirmed) {
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.emit('joinPlayer', { type: 'game', slotId, index: idx, name: formattedPlayerInfo });
        }
    }
}

// 🏸 코트에 가상 매칭 경기 띄워주기 함수 (강제 렌더링)
function showSimulatedCourtMatch(myInfo) {
    const courtSection = document.getElementById('section-court');
    if (!courtSection) return;

    courtSection.innerHTML = `
        <div style="padding: 10px 4px;">
            <div style="background: #1e293b; border: 2px solid #2563eb; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 4px 15px rgba(37,99,235,0.3);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <span style="font-size:15px; font-weight:bold; color:#60a5fa;">🏸 2코트 경기 진행 중 (체험)</span>
                    <span style="background:#ef4444; color:#fff; font-size:11px; padding:2px 8px; border-radius:4px; font-weight:bold; animation: blink 1.5s infinite;">LIVE</span>
                </div>
                <div style="display:flex; justify-content:space-around; align-items:center; background:rgba(0,0,0,0.25); padding:14px 10px; border-radius:8px;">
                    <div style="text-align:center; flex:1;">
                        <div style="color:#93c5fd; font-weight:bold; font-size:12px; margin-bottom:4px;">A팀</div>
                        <div style="font-size:13px; color:#fff;">윤도현 (남/B)</div>
                        <div style="font-size:13px; color:#fff;">한소희 (여/C)</div>
                        <div style="font-size:26px; font-weight:bold; color:#60a5fa; margin-top:8px;">12</div>
                    </div>
                    <div style="font-size:18px; font-weight:bold; color:#64748b; padding:0 8px;">VS</div>
                    <div style="text-align:center; flex:1;">
                        <div style="color:#fca5a5; font-weight:bold; font-size:12px; margin-bottom:4px;">B팀 (나)</div>
                        <div style="font-size:13px; color:#fff;">장기용 (남/D)</div>
                        <div style="font-size:13px; color:#38bdf8; font-weight:bold;">${myInfo.split('/')[0]} (나)</div>
                        <div style="font-size:26px; font-weight:bold; color:#f87171; margin-top:8px;">10</div>
                    </div>
                </div>
                <div style="text-align:center; margin-top:12px; font-size:12px; color:#94a3b8; line-height:1.4;">
                    🎉 4인 매칭이 완료되어 2코트로 자동 배정되었습니다.<br>
                    실제 체육관에서는 전광판과 자동 동기화됩니다.
                </div>
            </div>
        </div>
    `;
}

async function joinNantaCell(slotId, idx) {
    // 📶 구장 Wi-Fi 접속 여부 체크 (시뮬레이션 모드가 아닐 때 검사)
    if (!window.isGymWifiConnected && !isSimulationMode) {
        if (typeof promptSimulationModal === 'function') {
            promptSimulationModal();
        } else {
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
        }
        return;
    }

    const savedUser = localStorage.getItem("currentUser");
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
        // 🧪 시뮬레이션 모드일 때는 서버로 보내지 않고 로컬에서 가상 처리
        if (isSimulationMode) {
            console.log('🧪 시뮬레이션 모드: 가상 난타 대기열 참여 완료');
            alert(`[체험존] ${formattedPlayerInfo} 님이 난타 대기열에 성공적으로 참여했습니다!`);
            return;
        }

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
    const userStr = localStorage.getItem("currentUser");
    const headerUserEl = document.getElementById("user-display-name"); 
    
    if (!headerUserEl) return;

    if (userStr) {
        const user = JSON.parse(userStr);
        headerUserEl.textContent = `${user.name}님`;
        
        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket && user.username) {
            activeSocket.emit('registerUserSession', user.username);
        }
    } else {
        headerUserEl.textContent = "로그인 필요";
    }
}

async function handleLogout() {
    const confirmed = await confirm("로그아웃 하시겠습니까?");
    if (confirmed) {
        const rawUser = localStorage.getItem("currentUser");

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
                    body: JSON.stringify({ user: userData })
                });
            } catch (err) {
                console.error("❌ 로그아웃 서버 통신 에러:", err);
            }
        }

        const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
        if (activeSocket) {
            activeSocket.disconnect();
        }

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

// ==========================================
// 🧪 [시뮬레이션 모드] 가상 봇 10명 데이터 및 컨트롤러
// ==========================================
let isSimulationMode = false;

// 1. 가상 봇 10명 프로필 (1코트 4명, 난타 대기 3명, 게임 대기 3명)
const mockBots = [
    // 🏸 코트 1 진행 중 (4명)
    { id: 'bot_1', name: '김민수', gender: '남', grade: 'A', status: 'playing', court: 1 },
    { id: 'bot_2', name: '이영희', gender: '여', grade: 'B', status: 'playing', court: 1 },
    { id: 'bot_3', name: '박준호', gender: '남', grade: 'B', status: 'playing', court: 1 },
    { id: 'bot_4', name: '최수진', gender: '여', grade: 'C', status: 'playing', court: 1 },

    // 🏸 난타 대기열 (3명 대기 중 -> 사용자가 들어오면 4명 완성!)
    { id: 'bot_5', name: '정우성', gender: '남', grade: 'C', status: 'waiting_rally' },
    { id: 'bot_6', name: '강민경', gender: '여', grade: 'D', status: 'waiting_rally' },
    { id: 'bot_7', name: '임시완', gender: '남', grade: 'B', status: 'waiting_rally' },

    // 🏸 다음 게임 대기열 1번방 (3명 대기 중 -> 사용자가 참여하면 4명 완성!)
    { id: 'bot_8', name: '윤도현', gender: '남', grade: 'B', status: 'waiting_game' },
    { id: 'bot_9', name: '한소희', gender: '여', grade: 'C', status: 'waiting_game' },
    { id: 'bot_10', name: '장기용', gender: '남', grade: 'D', status: 'waiting_game' }
];

// 2. 모달 열기/닫기 및 시뮬레이션 시작 바인딩
document.addEventListener('DOMContentLoaded', () => {
    const simModal = document.getElementById('simulation-guide-modal');
    const startSimBtn = document.getElementById('start-simulation-btn');
    const closeSimBtn = document.getElementById('close-simulation-btn');

    if (startSimBtn) {
        startSimBtn.addEventListener('click', () => {
            if (simModal) simModal.style.display = 'none';
            startSimulationMode();
        });
    }

    if (closeSimBtn) {
        closeSimBtn.addEventListener('click', () => {
            if (simModal) simModal.style.display = 'none';
        });
    }
});

// 3. 외부 접속 시 모달 띄우기 함수
function promptSimulationModal() {
    const simModal = document.getElementById('simulation-guide-modal');
    if (simModal) {
        simModal.style.display = 'flex';
    }
}

// 4. 시뮬레이션 실행 로직 (강화 버전)
function startSimulationMode() {
    isSimulationMode = true;
    console.log('🧪 [시뮬레이션 시작] 가상 회원 10명과 함께 가상 환경을 로드합니다.');

    // 1) 상단 안내 배너 띄우기
    let banner = document.getElementById('simulation-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'simulation-banner';
        banner.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%;
            background-color: #f59e0b; color: #111827;
            text-align: center; padding: 10px 14px; font-size: 13.5px;
            font-weight: bold; z-index: 10000; box-shadow: 0 2px 10px rgba(0,0,0,0.15);
            display: flex; justify-content: space-between; align-items: center;
        `;
        banner.innerHTML = `
            <span>🧪 가상 체험존 동작 중 (실제 구장 데이터에 영향 없음)</span>
            <button id="exit-simulation-btn" style="background:#111827; color:white; border:none; padding:4px 10px; border-radius:6px; font-size:12px; cursor:pointer;">체험 종료</button>
        `;
        document.body.appendChild(banner);

        document.getElementById('exit-simulation-btn').addEventListener('click', exitSimulationMode);
    }
    banner.style.display = 'flex';

    // 2) 왼쪽 하단 배지 카운터 가상 반영
    const clubElement = document.getElementById('club-count');
    const totalElement = document.getElementById('online-count');
    if (clubElement) clubElement.textContent = '10';
    if (totalElement) totalElement.textContent = '11';

    // 3) 가상 대기열 카드 강제 주입 (alert 전에 즉시 렌더링)
    renderMockQueues();

    // 4) 기존 "현재 대기 중인 게임 방이 없습니다" 메시지 강제 숨김
    const emptyMsg = document.querySelector('.empty-queue-msg');
    if (emptyMsg) {
        emptyMsg.style.display = 'none';
    }

    console.log('✅ 가상 봇 10명 배치 및 대기열 구성 완료!');

    alert('가상 체험존이 활성화되었습니다!\n가상 회원 10명이 대기열 및 코트에 배치됩니다.');
}

// 5. 시뮬레이션 종료
function exitSimulationMode() {
    isSimulationMode = false;
    const banner = document.getElementById('simulation-banner');
    if (banner) banner.style.display = 'none';

    // 원래 서버 실제 상태로 복귀
    location.reload();
}
// ==========================================
// 🎨 [시뮬레이션 모드] 가상 화면 렌더링 엔진 (난타 2인 + 잔여 대기열 유지)
// ==========================================

function renderMockQueues() {
    // 🏸 1) 게임 대기열 주입 (#game-slot-list)
    const gameSlotList = document.getElementById('game-slot-list');
    if (gameSlotList) {
        gameSlotList.innerHTML = `
            <!-- 1번 방: 3명 대기 중 -> 사용자 참여 시 4명 매칭 -->
            <div class="slot-card sim-slot-game" style="background: #1e293b; border: 1px solid #3b82f6; border-radius: 12px; padding: 14px; margin-bottom: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
                    <span style="font-weight: bold; color: #60a5fa; font-size: 14px;">🏸 [체험] 게임 1번방 (3/4명)</span>
                    <span class="sim-game-status" style="font-size: 12px; color: #94a3b8;">1명 모집 중</span>
                </div>
                <div class="game-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
                    <div style="background: rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #f1f5f9;">윤도현 (남/B)</div>
                    <div style="background: rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #f1f5f9;">한소희 (여/C)</div>
                    <div style="background: rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #f1f5f9;">장기용 (남/D)</div>
                    <button onclick="joinGameCell('sim_game', 3)" style="background: #2563eb; color: #ffffff; border: none; padding: 10px; border-radius: 8px; font-size: 13px; font-weight: bold; cursor: pointer; transition: 0.2s;">
                        + 터치하여 참여
                    </button>
                </div>
            </div>

            <!-- 2번 방: 잔여 가상 봇들이 대기 중 (실제 구장 북적거림 유지) -->
            <div class="slot-card" style="background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 14px; margin-bottom: 12px; opacity: 0.85;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
                    <span style="font-weight: bold; color: #94a3b8; font-size: 14px;">🏸 [대기] 게임 2번방 (2/4명)</span>
                    <span style="font-size: 12px; color: #64748b;">대기 순번 2</span>
                </div>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
                    <div style="background: rgba(255,255,255,0.04); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #cbd5e1;">강민경 (여/D)</div>
                    <div style="background: rgba(255,255,255,0.04); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #cbd5e1;">임시완 (남/B)</div>
                    <div style="background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.1); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #64748b;">빈자리</div>
                    <div style="background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.1); padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; color: #64748b;">빈자리</div>
                </div>
            </div>
        `;
    }

    // 🏸 2) 난타 대기열 주입 (#section-nanta 내부, 정원 2명 규칙 적용)
    const nantaSection = document.getElementById('section-nanta');
    if (nantaSection) {
        let nantaSlotList = nantaSection.querySelector('#nanta-slot-list') || nantaSection.querySelector('.nanta-list') || nantaSection;
        nantaSlotList.innerHTML = `
            <div class="slot-card sim-slot-nanta" style="background: #1e293b; border: 1px solid #10b981; border-radius: 12px; padding: 14px; margin-bottom: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
                    <span style="font-weight: bold; color: #34d399; font-size: 14px;">🏸 [체험] 난타 랠리 1코트 (1/2명)</span>
                    <span class="sim-nanta-status" style="font-size: 12px; color: #94a3b8;">파트너 1명 대기 중</span>
                </div>
                <div class="nanta-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                    <div style="background: rgba(255,255,255,0.06); padding: 12px; border-radius: 8px; font-size: 13px; text-align: center; color: #f1f5f9;">정우성 (남/C)</div>
                    <button onclick="joinNantaCell('sim_rally', 1)" style="background: #059669; color: #ffffff; border: none; padding: 12px; border-radius: 8px; font-size: 13px; font-weight: bold; cursor: pointer; transition: 0.2s;">
                        + 난타 파트너 참여
                    </button>
                </div>
            </div>
        `;
    }
}

// 🏸 난타 참여 인터랙션 함수 (2인 완성 -> 코트 전환)
async function joinNantaCell(slotId, idx) {
    if (!window.isGymWifiConnected && !isSimulationMode) {
        if (typeof promptSimulationModal === 'function') {
            promptSimulationModal();
        }
        return;
    }

    const savedUser = localStorage.getItem("currentUser");
    let formattedPlayerInfo = "체험회원/남/30대/C";
    if (savedUser) {
        try {
            const u = JSON.parse(savedUser);
            const name = (u.name || u.username || "").trim();
            const gender = (u.gender || "").trim();
            const age = (u.age || u.ageGroup || "").trim();
            const level = (u.level || u.grade || "").trim();
            if (name) formattedPlayerInfo = [name, gender, age, level].filter(Boolean).join("/");
        } catch (e) {}
    }

    if (isSimulationMode) {
        console.log('🧪 시뮬레이션 모드: 2인 난타 완성 및 코트 전환');

        // 난타 카드의 버튼을 내 이름으로 변경
        const nantaCard = document.querySelector('.sim-slot-nanta');
        if (nantaCard) {
            const joinBtn = nantaCard.querySelector('button');
            if (joinBtn) {
                const mySlot = document.createElement('div');
                mySlot.style.cssText = "background: #059669; color: #fff; padding: 12px; border-radius: 8px; font-size: 13px; text-align: center; font-weight: bold; border: 2px solid #34d399;";
                mySlot.textContent = formattedPlayerInfo;
                joinBtn.replaceWith(mySlot);
            }
            const statusText = nantaCard.querySelector('.sim-nanta-status');
            if (statusText) statusText.innerHTML = '<b style="color:#34d399;">난타 매칭 완료! (2/2명)</b>';
        }

        // 1.2초 후 코트 화면으로 이동 (난타 전용 코트 연출)
        setTimeout(() => {
            const secGame = document.getElementById('section-game');
            const secNanta = document.getElementById('section-nanta');
            const secCourt = document.getElementById('section-court');

            if (secGame) secGame.style.display = 'none';
            if (secNanta) secNanta.style.display = 'none';
            if (secCourt) secCourt.style.display = 'block';

            // 코트 탭 버튼 활성화
            const tabs = document.querySelectorAll('.tab-menu button, .tab-menu div, .tab-btn');
            tabs.forEach(t => {
                if (t.innerText && t.innerText.includes('코트')) t.classList.add('active');
                else t.classList.remove('active');
            });

            showSimulatedRallyCourtMatch(formattedPlayerInfo);
        }, 1200);

        return;
    }

    // 실제 서버 환경 참여
    const activeSocket = (typeof socket !== 'undefined' && socket) ? socket : window.socket;
    if (activeSocket) {
        activeSocket.emit('joinPlayer', { type: 'nanta', slotId, index: idx, name: formattedPlayerInfo });
    }
}

// 🏸 난타 전용 코트 렌더링 함수 (정우성 vs 나 1대1 랠리)
function showSimulatedRallyCourtMatch(myInfo) {
    const courtSection = document.getElementById('section-court');
    if (!courtSection) return;

    courtSection.innerHTML = `
        <div style="padding: 10px 4px;">
            <!-- 난타 코트 현황 -->
            <div style="background: #1e293b; border: 2px solid #10b981; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 4px 15px rgba(16,185,129,0.2);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <span style="font-size:15px; font-weight:bold; color:#34d399;">🏸 3코트 난타 랠리 진행 중 (체험)</span>
                    <span style="background:#059669; color:#fff; font-size:11px; padding:2px 8px; border-radius:4px; font-weight:bold;">난타 코트</span>
                </div>
                <div style="display:flex; justify-content:space-around; align-items:center; background:rgba(0,0,0,0.25); padding:16px 10px; border-radius:8px;">
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:14px; font-weight:bold; color:#fff;">정우성 (남/C)</div>
                        <div style="color:#94a3b8; font-size:12px; margin-top:4px;">파트너 A</div>
                    </div>
                    <div style="font-size:18px; font-weight:bold; color:#10b981; padding:0 12px;">↔ 랠리 ↔</div>
                    <div style="text-align:center; flex:1;">
                        <div style="font-size:14px; font-weight:bold; color:#38bdf8;">${myInfo.split('/')[0]} (나)</div>
                        <div style="color:#94a3b8; font-size:12px; margin-top:4px;">파트너 B</div>
                    </div>
                </div>
                <div style="text-align:center; margin-top:12px; font-size:12px; color:#94a3b8; line-height:1.4;">
                    🎾 2인 난타 랠리가 시작되었습니다.<br>
                    몸 풀기 후 게임 대기열에 등록할 수 있습니다.
                </div>
            </div>

            <!-- 다른 1코트 복식 게임 진행 중 (남은 봇 4명 경기 유지) -->
            <div style="background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 14px; opacity: 0.85;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:13px; font-weight:bold; color:#94a3b8;">🏸 1코트 복식 경기 진행 중</span>
                    <span style="font-size:11px; color:#64748b;">16 : 14</span>
                </div>
                <div style="font-size:12px; color:#cbd5e1; display:flex; justify-content:space-between;">
                    <span>김민수 / 이영희</span>
                    <span style="color:#64748b;">vs</span>
                    <span>박준호 / 최수진</span>
                </div>
            </div>
        </div>
    `;
}